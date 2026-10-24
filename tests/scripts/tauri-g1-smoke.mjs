// SPDX-License-Identifier: Apache-2.0
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),dir=resolve(root,'.verification-artifacts/tauri');
assert.ok(process.argv[2],'Usage: node tests/scripts/tauri-g1-smoke.mjs <absolute-real-engine-pdf>');
const fixture=resolve(process.argv[2]);
const pdf=await readFile(fixture),pdfHash=createHash('sha256').update(pdf).digest('hex');
const exe=resolve(root,'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe');
const server=createServer();await new Promise((ok,bad)=>server.once('error',bad).listen(0,'127.0.0.1',ok));const port=server.address().port;await new Promise(ok=>server.close(ok));
const app=spawn(exe,[],{cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,MODUTEX_G1_PDF:fixture,MODUTEX_G1_UNTRUSTED_WINDOW:'1'},stdio:['ignore','ignore','pipe']});
let launchError;app.on('error',e=>{launchError=e;});let stderr='';app.stderr.on('data',b=>{stderr+=b;});
let browser;
let stage='launch';
const checkpoint=value=>{stage=value;console.log('G1: '+value);};
const watchdog=setTimeout(()=>{
 console.error('G1_TIMEOUT: '+stage);
 if(app.pid)execFile('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>process.exit(1));
 else process.exit(1);
},120000);
try{
 let ready=false;const until=Date.now()+30000;
 while(Date.now()<until){if(launchError)throw launchError;if(app.exitCode!==null)throw Error('Host exited: '+app.exitCode+' '+stderr.slice(-2000));try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await delay(250);}
 assert.ok(ready,'real WebView2 CDP endpoint');
 checkpoint('connect WebView2');
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:10000});
 const context=browser.contexts()[0];
 const pagesUntil=Date.now()+15000;while(context.pages().length<2&&Date.now()<pagesUntil)await delay(100);
 assert.equal(context.pages().length,2,'main plus untrusted test window');
 let page,untrusted;
 const pageErrors=[];
 const invalidModuleTypes=[];
 for(const candidate of context.pages()){
  candidate.on('console',message=>{if(message.type()==='warning'||message.type()==='error')console.log('WebView: '+message.text().slice(0,1200));});
  candidate.on('requestfailed',request=>console.log('Request failed: '+request.url()+' '+request.failure()?.errorText));
  candidate.on('pageerror',e=>pageErrors.push(e.message));
  candidate.on('response',response=>{
   if (/\/assets\/[^/?]+\.m?js(?:\?|$)/.test(response.url()) &&
    !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers()['content-type']??'')) {
    invalidModuleTypes.push({url:response.url(),contentType:response.headers()['content-type']??null});
   }
  });
  await candidate.waitForFunction(()=>typeof globalThis.__TAURI_INTERNALS__?.invoke==='function');
  const result=await candidate.evaluate(async()=>{try{return{allowed:true,health:await globalThis.__TAURI_INTERNALS__.invoke('host_health')};}catch(e){return{allowed:false,error:String(e)};}});
  if(result.allowed){assert.equal(result.health.owner,'main');page=candidate;}else untrusted=candidate;
 }
 assert.ok(page&&untrusted,'real permission isolation of two windows');
 checkpoint('binary IPC');
 const echo=await page.evaluate(async()=>{
  const results=[];
  for(const size of [0,1,32767,5*1024*1024]){
   const bytes=Uint8Array.from({length:size},(_,i)=>(i*31+17)%256);
   const response=await globalThis.__TAURI_INTERNALS__.invoke('prototype_bytes',bytes);
   if(!(response instanceof ArrayBuffer))throw Error('Binary response was not ArrayBuffer');
   const output=new Uint8Array(response);if(output.length!==size||output.some((v,i)=>v!==bytes[i]))throw Error('Binary roundtrip mismatch');
   results.push({size,equal:true});
  }
  const rejections=[];
  for(const input of [new Uint8Array(5*1024*1024+1),{bytes:[1,2]}]){
   let rejected=false,message='';try{await globalThis.__TAURI_INTERNALS__.invoke('prototype_bytes',input);}catch(e){rejected=true;message=String(e);}
   if(!rejected)throw Error('Accepted over-limit or JSON request');rejections.push(message);
  }
  return{results,rejections};
 });
 checkpoint('untrusted window');
 const denied=await untrusted.evaluate(async()=>{const results=[];for(const name of ['prototype_bytes','prototype_pdf']){let rejected=false,error='';try{await globalThis.__TAURI_INTERNALS__.invoke(name,new Uint8Array([1]));}catch(e){rejected=true;error=String(e);}results.push({name,rejected,error});}return results;});
 assert.ok(denied.every(r=>r.rejected),'untrusted actual commands rejected');
 const returned=Buffer.from(await page.evaluate(async()=>{const response=await globalThis.__TAURI_INTERNALS__.invoke('prototype_pdf');if(!(response instanceof ArrayBuffer))throw Error('PDF is not binary');return Array.from(new Uint8Array(response));}));
 assert.deepEqual(returned,pdf,'real engine PDF preserved across Rust binary IPC');
 checkpoint('Chinese composition');
 await page.waitForFunction(()=>document.querySelector('#app')?.textContent?.trim().length>100);
 await page.getByRole('button',{name:'新文件',exact:true}).click();
 await page.getByRole('button',{name:'原始碼',exact:true}).click();
 const editor=page.locator('.cm-content[contenteditable="true"]').first();await editor.waitFor({state:'visible'});await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% ');
 await editor.evaluate(el=>{globalThis.__g1CompositionEvents=[];for(const type of ['compositionstart','compositionupdate','compositionend'])el.addEventListener(type,e=>globalThis.__g1CompositionEvents.push({type,data:e.data}));});
 const cdp=await context.newCDPSession(page);
 try{await cdp.send('Input.imeSetComposition',{text:'中文測試',selectionStart:4,selectionEnd:4});await cdp.send('Input.insertText',{text:'中文測試'});}finally{await cdp.detach();}
 await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('中文測試'));
 const ime=await page.evaluate(()=>({text:document.querySelector('.cm-content').textContent,events:globalThis.__g1CompositionEvents}));
 assert.equal(ime.text.split('中文測試').length-1,1,'composition commits once');assert.ok(ime.events.some(e=>e.type==='compositionstart'));assert.ok(ime.events.some(e=>e.type==='compositionend'));
 checkpoint('PDF.js');
 await page.locator('input[type="file"][accept=".pdf"]').setInputFiles({name:'g1-tectonic.pdf',mimeType:'application/pdf',buffer:returned});
 const canvas=page.locator('.preview-pane canvas').first();await canvas.waitFor({state:'visible'});
 await page.waitForFunction(()=>{const c=document.querySelector('.preview-pane canvas');if(!c?.width||!c.height)return false;return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i,a)=>i%4===0&&a[i+3]>0&&(v<245||a[i+1]<245||a[i+2]<245));},null,{timeout:30000});
 const pdfView=await canvas.evaluate(c=>({width:c.width,height:c.height,label:c.getAttribute('aria-label'),workerResources:performance.getEntriesByType('resource').filter(e=>/pdf.*worker|worker.*pdf/.test(e.name)).map(e=>e.name)}));
 pdfView.workerURLs=page.workers().map(worker=>worker.url());
 assert.ok(pdfView.workerURLs.some(url=>/pdf\.worker[^/]*\.m?js/.test(url)),'real PDF.js worker, no fake-worker substitute');
 assert.deepEqual(invalidModuleTypes,[],'all loaded JS assets have JavaScript MIME');
 assert.deepEqual(pageErrors,[],'no renderer errors');
 await page.screenshot({path:resolve(dir,'g1-prototypes.png'),fullPage:true});
 const receipt={schemaVersion:1,status:'passed',exeSha256:createHash('sha256').update(await readFile(exe)).digest('hex'),pdf:{fixture,sha256:pdfHash,length:pdf.length,...pdfView},echo,denied,ime:{events:ime.events,committedExactlyOnce:true},invalidModuleTypes,pageErrors};
 await writeFile(resolve(dir,'g1-prototypes-smoke.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{
 if(browser)await browser.close();
 if(app.pid&&app.exitCode===null)await promisify(execFile)('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(e=>{if(app.exitCode===null)throw e;});
 clearTimeout(watchdog);
}
