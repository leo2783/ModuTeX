// SPDX-License-Identifier: Apache-2.0
// Real npm launch -> Tauri -> WebView2; no build, fake IPC or page replacement.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import { clickFileAction, waitForFileActions } from './helpers/app-file-actions.mjs';
import {assertNoUiEmoji} from './helpers/assert-no-ui-emoji.mjs';
const root=resolve(import.meta.dirname,'../..');
const npmCli=process.env.MODUTEX_TEST_NPM_CLI ?? process.env.npm_execpath ?? join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
await mkdir(join(root,'.verification-artifacts/tauri'),{recursive:true});
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert(!/cargo|frontend:build|npm run/.test(pkg.scripts.tauri),'normal launch must not rebuild');
const scratch=await mkdtemp(join(tmpdir(),'modutex-startup-e2e-'));
const socket=createServer();await new Promise((ok,fail)=>socket.once('error',fail).listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
const receipt={createdAt:new Date().toISOString(),scope:'real npm launch, visible native homepage and native SVG table resize',status:'running'};
let output='',browser;
const started=performance.now();
const child=spawn(process.execPath,[npmCli,'run','tauri','--silent'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(scratch,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
child.stdout.on('data',s=>output=(output+s).slice(-8192));child.stderr.on('data',s=>output=(output+s).slice(-8192));
let launchError;child.on('error',e=>launchError=e);
try{
 let ready=false;
 for(const until=Date.now()+30000;Date.now()<until;){if(launchError)throw launchError;if(child.exitCode!==null)throw Error(`npm exited ${child.exitCode}: ${output}`);try{ready=(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(400)})).ok}catch{}if(ready)break;await delay(100)}
 assert(ready,'native WebView2 must start');receipt.webviewReadyMs=Math.round(performance.now()-started);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:10000});let page;
 for(const until=Date.now()+10000;Date.now()<until;){page=browser.contexts().flatMap(context=>context.pages())[0];if(page)break;await delay(50)}
 assert(page,'native app must create its page after the DevTools endpoint starts');
 await waitForFileActions(page);
 receipt.homeReadyMs=Math.round(performance.now()-started);assert(!/vite build|cargo (run|build)|Compiling/.test(output),'npm start must launch the app directly');
 await assertNoUiEmoji(page);
 await clickFileAction(page, /^(新增文件|New document)$/);
 await page.locator('.insert-bar').getByRole('button',{name:/^(表格|Table)$/}).click();
 const handle=page.locator('.column-boundary').first();await handle.waitFor({state:'visible'});
 assert.equal(await handle.locator('svg path').count(),1);
 const before=await handle.evaluate(e=>parseFloat(e.style.left));await handle.focus();await page.keyboard.press('ArrowRight');assert((await handle.evaluate(e=>parseFloat(e.style.left)))>before);
 await assertNoUiEmoji(page);
 receipt.nativeSvgResize=true;receipt.visibleEmojiChecks=['homepage','editor and table'];receipt.status='passed';
}catch(e){receipt.status='failed';receipt.error=String(e);process.exitCode=1}
finally{
 if(browser)await browser.close().catch(()=>{});
 if(child.pid)await new Promise(ok=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>ok()));
 receipt.output=output;await writeFile(join(root,'.verification-artifacts/tauri/npm-tauri-startup-e2e.json'),JSON.stringify(receipt,null,2));
 await rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:150}).catch(()=>{});console.log(JSON.stringify(receipt));
}
