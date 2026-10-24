// SPDX-License-Identifier: Apache-2.0
// Real native picker, persisted profiles, real Tectonic and unchanged active include.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {join,resolve,basename,toNamespacedPath} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),evidence=join(root,'.verification-artifacts/tauri');
const exe=resolve(process.env.MODUTEX_TEST_EXE??join(root,'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe'));
const coldCache = process.env.MODUTEX_TEST_COLD_CACHE === '1';
if (coldCache) {
 assert(process.env.MODUTEX_TEST_CACHE_DIR, 'cold acceptance requires an explicit isolated cache path');
 const exists = await access(process.env.MODUTEX_TEST_CACHE_DIR).then(() => true, error => {
  if (error.code !== 'ENOENT') throw error;
  return false;
 });
 assert.equal(exists, false, 'cold acceptance must start without a cache');
}
const scratch=await mkdtemp(join(tmpdir(),'modutex-compile-config-e2e-')),workspace=join(scratch,`project \u6e2c\u8a66 ${basename(scratch)}`);await mkdir(join(workspace,'out'),{recursive:true});
await writeFile(join(workspace,'standalone.tex'),'\\documentclass{article}\n\\begin{document}Unconfigured main test.\\end{document}\n');
await writeFile(join(workspace,'main.tex'),'\\documentclass{article}\n\\begin{document}Main document.\\input{chapter}\\end{document}\n');
const chapter='Included chapter material.\n';await writeFile(join(workspace,'chapter.tex'),chapter);
const socket=createServer();await new Promise((ok,fail)=>socket.once('error',fail).listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
const app=spawn(exe,[],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(scratch,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
let browser,page,stderr='',stage='launch',launchError;app.stderr.on('data',s=>stderr=(stderr+s).slice(-8192));app.once('error',e=>launchError=e);
const receipt={createdAt:new Date().toISOString(),exe,sha256:createHash('sha256').update(await readFile(exe)).digest('hex'),scope:'actual native profile UI, unset main compile, trusted custom command, output publication and selected included source preservation',status:'running',checks:[],pageErrors:[],watchFailures:[]};
const watchdog=setTimeout(()=>{if(app.pid)execFile('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true},()=>process.exit(1))},540000);
const exec=(file,args)=>new Promise((ok,fail)=>execFile(file,args,{cwd:root,windowsHide:true,timeout:30000},(e,out,err)=>e?fail(Error(`${e}: ${err}`)):ok(out.trim())));
async function documentTab(){const tab=page.getByRole('tab',{name:/^(文件|Document)$/});if(await tab.count())await tab.click();await page.getByRole('button',{name:/^(原始碼|Source)$/}).click();}
async function settings(){await page.getByRole('link',{name:/^(編譯設定|Compile settings)$/}).click();await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).waitFor({state:'visible'});await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(e=>/儲存工作區編譯設定|Save workspace compile settings/.test(e.textContent));return b&&!b.disabled});}
async function workbench(){await page.getByRole('link',{name:/^(工作區|Workbench|工作台)$/}).click();}
async function assertManagedEngine(){
 const expected=process.env.MODUTEX_TEST_EXPECT_ENGINE;if(!expected)return;
 assert(Number.isSafeInteger(app.pid)&&app.pid>0);
 let observed=[];
 for(const until=Date.now()+15000;Date.now()<until;){
  const output=await exec(process.env.MODUTEX_TEST_PWSH??'pwsh.exe',['-NoProfile','-Command',`@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.pid}" | Where-Object Name -eq 'tectonic.exe' | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress`]);
  observed=output?JSON.parse(output):[];if(typeof observed==='string')observed=[observed];
  if(observed.length)break;await delay(100);
 }
 assert(observed.length,'managed compilation must launch an observable native Tectonic child');
 assert(observed.some(p=>toNamespacedPath(p).toLowerCase()===toNamespacedPath(resolve(expected)).toLowerCase()),'managed compile must use the engine extracted from the installer: '+JSON.stringify(observed));
 receipt.checks.push({packagedManagedEngine:resolve(expected),observed});
}
async function compile(cold = false){const started=performance.now();await page.getByRole('button',{name:/^(編譯 PDF|Compile PDF)$/}).click();await page.getByRole('button',{name:/^(取消編譯|Cancel compilation)$/}).waitFor({timeout:15000});if(cold)await assertManagedEngine();await page.waitForFunction(()=>/編譯完成|Compilation completed|編譯失敗|Compilation failed/.test(document.querySelector('.compile-status')?.textContent??''),null,{timeout:330000});assert.match(await page.locator('.compile-status').innerText(),/編譯完成|Compilation completed/,'real native compile must publish successfully');await page.locator('canvas').first().waitFor({state:'visible',timeout:20000});receipt.checks.push({compileMs:Math.round(performance.now()-started),coldCache:cold});}
try{
 for(const until=Date.now()+30000;Date.now()<until;){if(launchError)throw launchError;if(app.exitCode!==null)throw Error(`host exited ${app.exitCode}: ${stderr}`);try{if((await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(400)})).ok)break}catch{}await delay(100)}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:10000});for(const until=Date.now()+10000;Date.now()<until;){page=browser.contexts().flatMap(c=>c.pages())[0];if(page)break;await delay(50)}assert(page);page.on('pageerror',e=>receipt.pageErrors.push(e.message));
 await page.exposeFunction('recordNativeWatchFailure', value => receipt.watchFailures.push(value));
 await page.evaluate(async()=>{const api=window.__TAURI_INTERNALS__;await api.invoke('plugin:event|listen',{event:'frontend://files/error',target:{kind:'Any'},handler:api.transformCallback(event=>window.recordNativeWatchFailure(event.payload))});});
 stage='owned native folder picker';const selected=exec(process.env.MODUTEX_TEST_PWSH??'pwsh.exe',['-NoProfile','-File',join(root,'tests/scripts/helpers/select-owned-folder.ps1'),'-OwnedProcessId',String(app.pid),'-ExpectedExecutablePath',exe,'-FolderPath',workspace]);void selected.catch(()=>{});await page.getByRole('button',{name:/^(開啟資料夾|Open folder)$/}).click();await selected;await page.locator('.tree-file[title="standalone.tex"]').click();
 stage='persist unset main';await settings();await page.getByLabel(/主 TeX 文件|Main TeX file/).selectOption('');await page.getByLabel(/編譯引擎設定檔|Engine profile/).selectOption('managed');await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).click();await workbench();
 stage='watch after compile settings navigation';await writeFile(join(workspace,'watch-before.txt'),'native watch before compile\n');await page.locator('.tree-file[title="watch-before.txt"]').waitFor({state:'visible',timeout:10000});receipt.checks.push('external file changes arrive after compile settings navigation');
 if(process.env.MODUTEX_TEST_PERIODIC_WATCH==='1'){stage='watch after the native periodic reconcile';await delay(65000);await writeFile(join(workspace,'watch-periodic.txt'),'native watch after periodic reconcile\n');await page.locator('.tree-file[title="watch-periodic.txt"]').waitFor({state:'visible',timeout:10000});assert.deepEqual(receipt.watchFailures,[]);receipt.checks.push('native watch survives the real 60-second periodic reconcile');}
 stage='real managed compile of active unset main';await compile(coldCache);receipt.checks.push('unset configured main compiles active saved TeX with real managed engine');
 stage='watch after managed compilation';await writeFile(join(workspace,'watch-after.txt'),'native watch after compile\n');await page.locator('.tree-file[title="watch-after.txt"]').waitFor({state:'visible',timeout:10000});assert.deepEqual(receipt.watchFailures,[]);receipt.checks.push('native watch remains live after managed compilation');
 stage='save trusted UI custom profile';await settings();await page.getByLabel(/主 TeX 文件|Main TeX file/).selectOption('main.tex');await page.getByLabel(/編譯引擎設定檔|Engine profile/).selectOption('custom');
 const tectonic=join(root,'vendor/tectonic/windows-x64/tectonic.exe');await page.getByLabel(/受信任的命令範本|Trusted command template/).fill(`"${tectonic}" --outdir {out} --keep-logs {main}`);await page.getByLabel(/^輸出目錄|^Output directory/).fill('out');await page.getByLabel(/^PDF 路徑|^PDF path/).fill('out/result.pdf');await page.getByLabel(/^記錄|^Log path|^日誌/).fill('out/result.log');await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).click();await workbench();
 stage='compile configured main from active include';await page.locator('.tree-file[title="chapter.tex"]').click();await documentTab();const editor=page.locator('.cm-content[contenteditable="true"]').first();await editor.waitFor({state:'visible'});const before=await editor.textContent();assert(before.includes('Included chapter'));await editor.click();await page.keyboard.press('Control+End');await compile();
 assert.equal(await page.locator('.tree-file[aria-current="true"]').getAttribute('title'),'chapter.tex');await documentTab();assert.equal(await editor.textContent(),before);assert.equal(await readFile(join(workspace,'chapter.tex'),'utf8'),chapter);
 const pdf=await readFile(join(workspace,'out/result.pdf'));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert((await readFile(join(workspace,'out/result.log'))).length>0);receipt.checks.push('custom real-engine command publishes configured PDF/log without changing active include');
 await settings();assert.equal(await page.getByLabel(/編譯引擎設定檔|Engine profile/).inputValue(),'custom');receipt.checks.push('trusted UI custom profile remains persisted after compilation');assert.deepEqual(receipt.pageErrors,[]);receipt.status='passed';
}catch(e){receipt.status='failed';receipt.stage=stage;receipt.error=String(e);receipt.stderr=stderr;if(page){receipt.body=(await page.locator('body').innerText().catch(()=>'' )).slice(-7000);await page.screenshot({path:join(evidence,'compile-config-native-e2e.png')}).catch(()=>{})}process.exitCode=1}
finally{
 clearTimeout(watchdog);
 if(page && !page.isClosed()){
  try{
   const cancel=page.getByRole('button',{name:/^(取消編譯|Cancel compilation)$/});
   if(await cancel.isVisible().catch(()=>false)){await cancel.click();await cancel.waitFor({state:'detached',timeout:15000});}
   await page.evaluate(()=>{location.hash='#/';});
   const remove=page.getByRole('button',{name:`移除 ${basename(workspace)} 的紀錄`,exact:true});
   await remove.waitFor({state:'visible',timeout:5000});await remove.click();await remove.waitFor({state:'detached',timeout:5000});
   receipt.testRecentRemoved=true;
  }catch(error){receipt.testRecentRemoved=false;receipt.recentCleanupError=String(error);receipt.status='failed';process.exitCode=1;}
 }
 if(browser)await browser.close().catch(()=>{});
 if(app.pid)await exec('taskkill.exe',['/PID',String(app.pid),'/T','/F']).catch(()=>{});
 await writeFile(join(evidence,'compile-config-native-e2e.json'),JSON.stringify(receipt,null,2));
 await rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:150}).catch(()=>{});console.log(JSON.stringify(receipt));
}
