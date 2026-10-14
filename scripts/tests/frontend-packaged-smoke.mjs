import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

// Test the real distributable, without Electron development selection or a Vite server.
const target = resolve(process.argv[2] ?? 'release/win-unpacked/ModuTeX.exe');
// GitHub Windows can put TEMP behind a junction; exercise the canonical path
// rather than weakening the host's rejection of aliases in document paths.
const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'modutex-packaged-'));
const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
const stable = !version.includes('-dev');
// Stable builds deliberately ignore test profile overrides. Exercise their real
// default profile only on an ephemeral GitHub runner, never a developer machine.
assert.ok(!stable || (process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true' && process.env.APPDATA),
 'Stable packaged acceptance must run on an ephemeral GitHub Actions Windows runner');
const profile = stable ? join(resolve(process.env.APPDATA), 'modutex-desktop') : fixture;
assert.ok(!stable || !existsSync(profile), 'Refuse to replace an existing stable user profile');
if (stable) mkdirSync(profile);
const workspace = join(fixture, 'workspace');
mkdirSync(workspace);
const file = join(workspace, 'main.tex');
const source = '\\documentclass{article}\n\\begin{document}\nPackaged 中文 document.\n\\end{document}\n';
writeFileSync(file, source);
writeFileSync(join(profile, 'frontend-recent-v1.json'), JSON.stringify({version:1,entries:[{id:randomUUID(),selected:file,kind:'file',openedAt:Date.now()}]}));
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const args = ['--disable-gpu', `--remote-debugging-port=${port}`];
const tarball = target.endsWith('.tgz');
// A fresh cache proves the downloaded archive works without warmed repo dependencies.
const npmCache = join(fixture, 'npm-cache');
const npxCli = process.env.MODUTEX_TEST_NPX_CLI ?? (process.env.npm_execpath ? join(dirname(process.env.npm_execpath),'npx-cli.js') : undefined);
assert.ok(!tarball || npxCli, 'Set MODUTEX_TEST_NPX_CLI to the pinned npm npx-cli.js');
const child = spawn(tarball ? process.execPath : target, tarball ? [npxCli, '--offline','--yes','--ignore-scripts','--cache',npmCache,'--loglevel','verbose','--package',target,'--','modutex',...args] : args, {
 cwd:tarball ? fixture : process.cwd(),
 windowsHide:true, env:{...process.env,TEXPILE_USER_DATA:fixture}, stdio:['ignore','pipe','pipe']
});
const launched = new Promise((resolveExit,reject) => {
 child.once('exit',(code)=>resolveExit(code)); child.once('error',reject);
});
let output='';
child.on('error', e => { output += e.message; });
child.stdout.on('data', b => {output += b.toString();});
child.stderr.on('data', b => {output += b.toString();});
let browser;
try {
 if(tarball) {
  console.log('stage: preparing offline npm tarball from a separate download directory');
  let timer;
  // Cold extraction of the 226 MB archive takes several minutes on Windows.
  // This preparation budget does not change the 45-second application startup check below.
  const code=await Promise.race([launched,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('npm tarball preparation timed out')),300000);})]).finally(()=>clearTimeout(timer));
  assert.equal(code,0,'npm launcher failed: '+output);
  console.log('stage: npm package prepared and launcher exited successfully');
 }
 const deadline=Date.now()+45000;
 let endpoint;
 while(Date.now()<deadline) {
  try {const response=await fetch(`http://127.0.0.1:${port}/json/version`); endpoint=(await response.json()).webSocketDebuggerUrl; if(endpoint) break;} catch {}
  await new Promise(r=>setTimeout(r,250));
 }
 assert.ok(endpoint, 'Packaged/npx startup failed: '+output);
 console.log('stage: packaged CDP ready');
 browser=await chromium.connectOverCDP(endpoint);
 const page=browser.contexts()[0].pages()[0];
 page.setDefaultTimeout(15000);
 await page.waitForURL('app://frontend/index.html');
 console.log('stage: packaged frontend origin ready');
 const errors=[];
 page.on('pageerror', e => errors.push(e.message));
 const bridge=await page.evaluate(()=>({files:typeof window.modutexFiles,legacy:['texpile','electronAPI'].filter(k=>k in window)}));
 assert.equal(bridge.files,'object'); assert.deepEqual(bridge.legacy,[]);
 await page.getByRole('button',{name:/開啟.*main.tex|Open.*main.tex/}).click();
 await page.getByRole('button',{name:/^(原始碼|Source)$/}).click();
 const editor=page.locator('.source-view .cm-content[contenteditable="true"]').first();
 await editor.click(); await page.keyboard.press('Control+End');
 await page.keyboard.insertText('% packaged save');
 await page.getByRole('button',{name:/^(儲存|Save)$/}).click();
 await page.waitForFunction(()=>!document.querySelector('footer.status-bar')?.textContent.includes('未儲存'));
 assert.equal(readFileSync(file,'utf8'),source+'% packaged save');
 console.log('stage: real file saved');
 // Exercise the lazy language menu from the packaged relative assets.
 await page.locator('.language-menu summary').click();
 await page.getByRole('button',{name:'English',exact:true}).click();
 await page.getByRole('button',{name:'Source',exact:true}).waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
 console.log('stage: English menu selected');
 await page.reload();
 await page.getByRole('link',{name:'Home',exact:true}).click();
 await page.getByRole('button',{name:/Open.*main.tex/}).click();
 await page.getByRole('button',{name:'Source',exact:true}).click();
 assert.match(await page.locator('.source-view .cm-content').first().textContent(), /% packaged save/);
 assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
 await page.getByRole('button',{name:'Compile PDF',exact:true}).click();
 await page.waitForFunction(()=>/Compilation completed/.test(document.querySelector('footer.status-bar')?.textContent??''),null,{timeout:330000});
 assert.equal(readFileSync(join(workspace,'output/main.pdf')).subarray(0,5).toString(),'%PDF-');
 await page.locator('.preview-pane canvas').first().waitFor({state:'visible'});
 console.log('stage: packaged PDF compiled and rendered');
 await page.screenshot({path:resolve('.verification-artifacts/packaged-'+(tarball?'npx':'exe')+'.png')});
 assert.deepEqual(errors,[]);
 await page.close();
 console.log(JSON.stringify({target,origin:'app://frontend/index.html',narrowIPC:true,saveReopen:true,englishMenu:true,compiledPdf:true,closed:true}));
} catch(error) {
 console.error('Packaged smoke failure:',error,output);
 if(browser) for(const page of browser.contexts()[0]?.pages()??[]) {
  console.error('Owned fixture window state:',await page.evaluate(()=>({
   url:location.href,locale:document.documentElement.lang,
   status:document.querySelector('footer.status-bar')?.textContent,
   alerts:Array.from(document.querySelectorAll('[role="alert"],.error-strip,.notice-strip')).map(e=>e.textContent?.slice(0,2048)),
   source:document.querySelector('.source-view .cm-content')?.textContent?.slice(0,512)
  })).catch(()=>({unavailable:true})), 'owned fixture disk:',readFileSync(file,'utf8'));
  await page.screenshot({path:resolve('.verification-artifacts/packaged-smoke-failure.png')}).catch(()=>{});
 }
 throw error;
} finally {
 if(browser) {for(const page of browser.contexts()[0]?.pages()??[]) await page.close().catch(()=>{}); await browser.close();}
 if(child.exitCode===null) child.kill();
 if (stable) {
  assert.equal(profile, join(resolve(process.env.APPDATA), 'modutex-desktop'));
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 }
 // Only generated test-owned paths are removed.
 await rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(error=>console.error('Fixture cleanup:',fixture,error.message));
}
