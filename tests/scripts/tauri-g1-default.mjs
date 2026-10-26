// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),dir=resolve(root,'.verification-artifacts/tauri');
const exe=resolve(root,'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe');
const portServer=createServer();
await new Promise((ok,bad)=>portServer.once('error',bad).listen(0,'127.0.0.1',ok));
const port=portServer.address().port;
await new Promise(ok=>portServer.close(ok));
const app=spawn(exe,[],{cwd:root,windowsHide:true,env:{...process.env,MODUTEX_G1_PDF:'Z:\\missing-g1-fixture.pdf',MODUTEX_G1_UNTRUSTED_WINDOW:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:['ignore','ignore','pipe']});
let spawnError;app.on('error',e=>{spawnError=e;});
let stderr='';app.stderr.on('data',b=>{stderr+=b.toString();});
let browser;
const watchdog=setTimeout(()=>{console.error('DEFAULT_HOST_TIMEOUT');if(app.pid)execFile('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>process.exit(1));else process.exit(1);},45000);
try{
 const deadline=Date.now()+30000;
 let ready=false;
 while(Date.now()<deadline){
  if(spawnError)throw spawnError;
  if(app.exitCode!==null)throw Error('Host exited before WebView2 became available: '+app.exitCode+' '+stderr.slice(-2000));
  try{const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
  await delay(250);
 }
 if(!ready)throw Error('WebView2 debugging endpoint not ready: '+stderr.slice(-2000));
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 const page=browser.contexts()[0].pages()[0];
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('#app')?.textContent?.trim().length>100,null,{timeout:15000});
 assert.equal(browser.contexts()[0].pages().length,1,'prototype env must not create second window in default build');
 const probeDenials=await page.evaluate(async()=>{const a=[];for(const cmd of ['prototype_pdf','prototype_bytes']){try{await globalThis.__TAURI_INTERNALS__.invoke(cmd,new Uint8Array([1]));a.push({cmd,rejected:false});}catch(e){a.push({cmd,rejected:true,error:String(e)});}}return a;});
 assert.ok(probeDenials.every(x=>x.rejected),'default host exposes no prototype commands');
 const result=await page.evaluate(async()=>({health:await globalThis.__TAURI_INTERNALS__.invoke('host_health'),title:document.title,text:document.querySelector('#app').textContent.trim().slice(0,250)}));
 if(result.health.protocolVersion!==1||result.health.owner!=='main'||result.health.hostVersion!=='0.2.1')throw Error('Unexpected real host health '+JSON.stringify(result.health));
 if(errors.length)throw Error('Renderer errors: '+errors.join('; '));
 await page.screenshot({path:resolve(dir,'g1-default-home.png'),fullPage:true});
 const receipt={schemaVersion:1,status:'passed',scope:'Default feature release launches real frontend, health succeeds, prototype commands absent and prototype environment ignored',probeDenials,exeSha256:createHash('sha256').update(await readFile(exe)).digest('hex'),url:page.url(),...result,pageErrors:errors};
 await writeFile(resolve(dir,'g1-default-smoke.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
}finally{
 if(browser)await browser.close();
 if(app.pid&&app.exitCode===null){await promisify(execFile)('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(e=>{if(app.exitCode===null)throw e;});}
 clearTimeout(watchdog);
}
