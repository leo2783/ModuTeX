// SPDX-License-Identifier: Apache-2.0
// Loader/IPC bounds; positive fixtures pad a real engine PDF without changing offsets.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {mkdir,open,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'../..');
const output=resolve(root,'.verification-artifacts/tauri','pdf-state-'+randomUUID());
await mkdir(output);
const exe=resolve(root,'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe');
assert.ok(process.argv[2],'Usage: node tests/scripts/tauri-g1-pdf-state.mjs <real-engine-pdf>');
const seed=await readFile(resolve(process.argv[2]));
const trailer=seed.lastIndexOf(Buffer.from('startxref'));
assert.ok(trailer>0&&seed.subarray(-1024).includes(Buffer.from('%%EOF')),'real engine PDF trailer');
const cases=[];
async function runCase(name,fixture,expectStartupFailure,expectedPositive) {
 const server=createServer();
 await new Promise((ok,bad)=>server.once('error',bad).listen(0,'127.0.0.1',ok));
 const port=server.address().port;
 await new Promise(ok=>server.close(ok));
 const env={...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`};
 delete env.MODUTEX_G1_UNTRUSTED_WINDOW;
 if(fixture)env.MODUTEX_G1_PDF=fixture;else delete env.MODUTEX_G1_PDF;
 const app=spawn(exe,[],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','pipe']});
 const watchdog=setTimeout(()=>{
  console.error('PDF_STATE_TIMEOUT: '+name);
  if(app.pid)execFile('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>process.exit(1));
  else process.exit(1);
 },45000);
 let error,stderr='';
 app.on('error',value=>{error=value;});
 app.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-8000);});
 let browser;
 const deadline=Date.now()+20000;
 try {
  if(expectStartupFailure) {
   while(app.exitCode===null&&app.signalCode===null&&!error&&Date.now()<deadline)await delay(100);
   if(error)throw error;
   assert.ok(app.exitCode!==null||app.signalCode!==null,name+': host must terminate');
   assert.ok(app.exitCode!==0,name+': invalid fixture must not start successfully');
   cases.push({name,rejected:true,exitCode:app.exitCode,signal:app.signalCode});
   return;
  }
  let ready=false;
  while(Date.now()<deadline) {
   if(error)throw error;
   assert.equal(app.exitCode,null,'missing PDF must keep host available: '+stderr);
   try {
    const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});
    if(response.ok){ready=true;break;}
   }catch{}
   await delay(100);
  }
  assert.ok(ready,'WebView2 starts without fixture');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
  const page=browser.contexts()[0].pages()[0];
  await page.waitForFunction(()=>globalThis.__TAURI_INTERNALS__?.invoke,null,{timeout:5000});
  const result=await page.evaluate(async()=>{
   try {
    const response=await globalThis.__TAURI_INTERNALS__.invoke('prototype_pdf');
    if(!(response instanceof ArrayBuffer))throw Error('PDF response must be native binary');
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',response));
    return{rejected:false,bytes:response.byteLength,sha256:Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('')};
   }
   catch(error){return{rejected:true,error:String(error)};}
  });
  assert.deepEqual(result,expectedPositive??{rejected:true,error:'PROBE_PDF_UNAVAILABLE'});
  cases.push({name,...result});
 }finally {
  if(browser)await browser.close();
  if(app.pid&&app.exitCode===null&&app.signalCode===null) {
   await promisify(execFile)('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,timeout:10000});
  }
  clearTimeout(watchdog);
 }
}

await runCase('no-fixture',undefined,false);
for(const size of [5*1024*1024+1,32*1024*1024]) {
 const bytes=Buffer.concat([seed.subarray(0,trailer),Buffer.alloc(size-seed.length,32),seed.subarray(trailer)]);
 const fixture=resolve(output,'positive-'+size+'.pdf');
 await writeFile(fixture,bytes);
 await runCase('positive-'+size,fixture,false,{rejected:false,bytes:size,sha256:createHash('sha256').update(bytes).digest('hex')});
}
for(const [name,bytes] of [
 ['short',Buffer.from('%PDF-\n%%EOF')],
 ['wrong-header',Buffer.from('not-a-pdf-file\n%%EOF')],
 ['missing-eof',Buffer.from('%PDF-1.7\nno trailer present')],
 ['eof-too-far-from-end',Buffer.concat([Buffer.from('%PDF-1.7\n%%EOF'),Buffer.alloc(2048,32)])]
]) {
 const fixture=resolve(output,name+'.bin');await writeFile(fixture,bytes);
 await runCase(name,fixture,true);
}
const tooLarge=resolve(output,'over-limit.bin');
const handle=await open(tooLarge,'wx');
try {await handle.truncate(32*1024*1024+1);}finally{await handle.close();}
await runCase('over-limit',tooLarge,true);
const receipt={schemaVersion:1,status:'passed',scope:'G1 PDF fixture loader and native binary limits, including full 32MiB',
 exeSha256:createHash('sha256').update(await readFile(exe)).digest('hex'),cases};
await writeFile(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,...receipt}));
