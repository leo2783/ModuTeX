// SPDX-License-Identifier: Apache-2.0
// Actual release WebView2 flow; no mocked desktop adapter or production hooks.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, basename, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {realPdf} from '../../apps/frontend/tests/helpers/pdf-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.verification-artifacts/tauri');
const releaseDirectory = join(root, 'apps/desktop-tauri/target/release');
const exe = resolve(root, process.env.MODUTEX_TEST_EXE ?? join(releaseDirectory, 'modutex-desktop-tauri.exe'));
assert(exe.startsWith(releaseDirectory + sep) && ['modutex-desktop-tauri.exe', 'modutex-mcp-rust-review.exe'].includes(basename(exe)), 'Only named application test binaries in the shared release directory are allowed');
const sandbox = await mkdtemp(join(tmpdir(), 'modutex-os-open-e2e-'));
const git = args => new Promise((ok, fail) => execFile('git', args, {cwd: root, windowsHide: true},
    (error, stdout) => error ? fail(error) : ok(stdout.trim())));
const sourceGitCommit = await git(['rev-parse', 'HEAD']);
assert(/^[a-f0-9]{40}$/.test(sourceGitCommit));
const workingTreeDirty = (await git(['status', '--porcelain', '--untracked-files=no'])).length > 0;
await mkdir(evidence, {recursive: true});
const socket = createServer();
await new Promise((ok, fail) => socket.once('error', fail).listen(0, '127.0.0.1', ok));
const port = socket.address().port;
await new Promise(ok => socket.close(ok));
const firstFile=join(sandbox,basename(sandbox)+'-first.tex');
const secondFile=join(sandbox,basename(sandbox)+'-second.tex');
const pdfFile=join(sandbox,basename(sandbox)+'-preview.pdf');
const verifyFormatting=process.env.MODUTEX_TEST_SOURCE_FORMAT==='1';
const firstSource=verifyFormatting?'\\documentclass{article}\n\\begin{document}\nInitial OS document.\n\\begin{itemize}\n\\item Item\n\\end{itemize}\n\\end{document}\n':'Initial OS document.\n';
await writeFile(firstFile,firstSource);
if(verifyFormatting)await writeFile(join(sandbox,'localSettings.yaml'),'x'.repeat(128*1024+1));
await writeFile(secondFile,'Second OS document.\n');
await writeFile(pdfFile,new Uint8Array(realPdf()));
const existing=await new Promise((accept,reject)=>execFile('pwsh.exe',['-NoProfile','-Command',"@(Get-Process -Name modutex-desktop-tauri -ErrorAction SilentlyContinue).Count"],{windowsHide:true},(error,stdout)=>error?reject(error):accept(Number(stdout.trim()))));
assert.equal(existing,0,'System-open acceptance requires no existing user ModuTeX process');
const spawnedAt = performance.now();
const app = spawn(exe, [firstFile], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {...process.env, WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`}
});
let browser, page, launchError, stderr = '', stage = 'launch';
app.once('error', error => { launchError = error; });
app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
const receipt = {createdAt: new Date().toISOString(), sourceGitCommit, workingTreeDirty, exe,
    sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
    scope: 'actual CLI startup file and second-instance handoff preserve an unsaved first document',
    status: 'running', checks: []};
const watchdog = setTimeout(() => {
    if (app.pid) execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'],
        {windowsHide: true, timeout: 10000}, () => process.exit(1));
}, 120000);
try {
    let ready=false;
    for(const until=Date.now()+30000;Date.now()<until;){
        if(launchError)throw launchError;
        if(app.exitCode!==null)throw Error('Startup process exited: '+stderr);
        try{ready=(await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(500)})).ok;}catch{}
        if(ready)break;await delay(100);
    }
    assert(ready);
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:10000});
    page=browser.contexts().flatMap(context=>context.pages())[0];
    assert(page);
    const pageErrors=[];receipt.pageErrors=pageErrors;
    page.on('pageerror',error=>pageErrors.push(error.message));
    stage='startup argv opens the file';
    await page.getByRole('button',{name:/^(原始碼|Source)$/}).click({timeout:15000});
    const editor=page.locator('.cm-content').first();
    await editor.waitFor({state:'visible'});
    assert((await editor.innerText()).includes('Initial OS document.'));
    if(verifyFormatting){
        stage='native formatter updates source with shared undo';
        const before=await editor.innerText();
        const format=page.getByRole('button',{name:/^(格式化 LaTeX|Format LaTeX)$/});
        await format.click();
        await page.waitForFunction(()=>/\n[\t ]+\\item Item/.test([...document.querySelectorAll('.cm-content .cm-line')].map(line=>line.textContent).join('\n')),null,{timeout:30000});
        assert.notEqual(await editor.innerText(),before);
        assert.equal(await readFile(firstFile,'utf8'),firstSource,'Formatting must preserve the disk file until Save');
        await editor.click();await page.keyboard.press('Control+z');
        assert.equal(await editor.innerText(),before,'Formatting must share source undo history');
        receipt.checks.push('Real latexindent ignores unselected sibling settings, preserves disk bytes and supports undo');
    }
    await editor.click();await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\nUNSAVED_FIRST_WINDOW\n');
    receipt.checks.push('Startup argv opens the actual owned file');
    stage='second instance hands off without losing dirty content';
    const oldPages=new Set(browser.contexts().flatMap(context=>context.pages()));
    await new Promise((accept,reject)=>execFile(exe,[secondFile],{cwd:root,windowsHide:true,timeout:15000},error=>error?reject(error):accept()));
    let next;
    for(const until=Date.now()+15000;Date.now()<until;){
        next=browser.contexts().flatMap(context=>context.pages()).find(candidate=>!oldPages.has(candidate));
        if(next)break;await delay(100);
    }
    assert(next,'Second-instance file handoff must open an independent window while the first is dirty');
    next.on('pageerror',error=>pageErrors.push(error.message));
    await next.getByRole('button',{name:/^(原始碼|Source)$/}).click({timeout:15000});
    assert((await next.locator('.cm-content').first().innerText()).includes('Second OS document.'));
    assert((await editor.innerText()).includes('UNSAVED_FIRST_WINDOW'));
    assert.equal(await readFile(firstFile,'utf8'),firstSource,'Opening another file must not silently save the first');
    stage='second-instance PDF handoff renders the selected file';
    const beforePdf=new Set(browser.contexts().flatMap(context=>context.pages()));
    await new Promise((accept,reject)=>execFile(exe,[pdfFile],{cwd:root,windowsHide:true,timeout:15000},error=>error?reject(error):accept()));
    let pdfPage;
    for(const until=Date.now()+15000;Date.now()<until;){
        pdfPage=browser.contexts().flatMap(context=>context.pages()).find(candidate=>!beforePdf.has(candidate));
        if(pdfPage)break;await delay(100);
    }
    assert(pdfPage,'PDF handoff must open its own document window');
    pdfPage.on('pageerror',error=>pageErrors.push(error.message));
    await pdfPage.waitForFunction(()=>{
        const canvas=document.querySelector('.pdf-scroll canvas');
        return canvas instanceof HTMLCanvasElement && canvas.width>0 && canvas.height>0;
    },null,{timeout:15000});
    assert((await editor.innerText()).includes('UNSAVED_FIRST_WINDOW'));
    receipt.checks.push('Actual PDF file handoff renders without replacing unsaved TeX');
    assert.deepEqual(pageErrors,[]);
    receipt.checks.push('Second instance opens its file and preserves unsaved content in the original window');
    receipt.status='passed';
} catch (error) {
    receipt.status = 'failed';
    receipt.stage = stage;
    receipt.error = String(error);
    await page?.screenshot({path: join(evidence, 'native-os-open-e2e.png'), timeout: 3000}).catch(() => {});
    if (page) receipt.visibleState = await Promise.race([
        page.evaluate(() => ({url: location.href, text: document.body.innerText.slice(-12000)})).catch(() => null),
        delay(3000).then(() => ({inspectionTimedOut: true}))
    ]);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    if (page && !page.isClosed()) {
        await page.evaluate(async names => {
            const invoke = globalThis.__TAURI_INTERNALS__.invoke;
            for (const item of await invoke('frontend_list_recent')) {
                if (names.includes(item.label)) await invoke('frontend_remove_recent', {id: item.id});
            }
        }, [basename(firstFile), basename(secondFile), basename(pdfFile)]).catch(error => {
            receipt.cleanupError = String(error);
            receipt.status = 'failed';
            process.exitCode = 1;
        });
    }
    await writeFile(join(evidence, 'native-os-open-e2e.json'), JSON.stringify(receipt, null, 2));
    if (app.exitCode === null && app.pid) await new Promise(ok =>
        execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}, ok));
    await browser?.close().catch(() => {});
    assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
    assert(basename(sandbox).startsWith('modutex-os-open-e2e-'));
    await rm(sandbox, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    console.log(JSON.stringify(receipt));
}
