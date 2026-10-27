// SPDX-License-Identifier: Apache-2.0
// Actual release WebView2 flow; no mocked desktop adapter or production hooks.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, basename, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import { clickFileAction, waitForFileActions } from './helpers/app-file-actions.mjs';
import { createNativeCdpConfig } from './helpers/native-cdp-config.mjs';
import { waitNativeCdp } from './helpers/wait-native-cdp.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.verification-artifacts/tauri');
const releaseDirectory = join(root, 'apps/desktop-tauri/target/release');
const exe = resolve(root, process.env.MODUTEX_TEST_EXE ?? join(releaseDirectory, 'modutex-desktop-tauri.exe'));
assert(exe.startsWith(releaseDirectory + sep) && ['modutex-desktop-tauri.exe', 'modutex-mcp-rust-review.exe'].includes(basename(exe)), 'Only named application test binaries in the shared release directory are allowed');
const sandbox = await mkdtemp(join(tmpdir(), 'modutex-multiwindow-e2e-'));
const git = args => new Promise((ok, fail) => execFile('git', args, {cwd: root, windowsHide: true},
    (error, stdout) => error ? fail(error) : ok(stdout.trim())));
const sourceGitCommit = await git(['rev-parse', 'HEAD']);
assert(/^[a-f0-9]{40}$/.test(sourceGitCommit));
const workingTreeDirty = (await git(['status', '--porcelain', '--untracked-files=no'])).length > 0;
await mkdir(evidence, {recursive: true});
const nativeCdp = await createNativeCdpConfig(join(sandbox, 'webview'));
const spawnedAt = performance.now();
const app = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {...process.env, ...nativeCdp.env}
});
let browser, page, launchError, stderr = '', stage = 'launch';
app.once('error', error => { launchError = error; });
app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
const receipt = {createdAt: new Date().toISOString(), sourceGitCommit, workingTreeDirty, exe,
    sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
    scope: 'actual UI new document window, independent owners and documents, child close preserves main',
    status: 'running', checks: []};
const watchdog = setTimeout(() => {
    if (app.pid) execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'],
        {windowsHide: true, timeout: 10000}, () => process.exit(1));
}, 120000);
try {
    await waitNativeCdp({ app, port: nativeCdp.port, evidence, lane: 'multiwindow', stderr: () => stderr, launchError: () => launchError });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${nativeCdp.port}`, {timeout: 10000});
    page = browser.contexts()[0].pages()[0];
    assert(page, 'actual app page');
    const pageErrors = [], confirmations = [];
    receipt.pageErrors = pageErrors;
    receipt.confirmations = confirmations;
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', async dialog => {
        if (dialog.type() === 'confirm') confirmations.push(dialog.message());
        await dialog.dismiss();
    });
    await page.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
    await waitForFileActions(page);
    receipt.timings = {homeReadyObservedMs: Math.round(performance.now() - spawnedAt)};
    stage = 'new document';
    const documentStartedAt = performance.now();
    await clickFileAction(page, /^(新增文件|New document)$/);
    await page.getByRole('button', {name: /^(原始碼|Source)$/}).click();
    const editor = page.locator('.cm-content[contenteditable="true"]').first();
    await editor.waitFor({state: 'visible'});
    receipt.timings.sourceEditorReadyObservedMs = Math.round(performance.now() - documentStartedAt);
    const marker = '% ModuTeX E2E 中文測試 \ud840\udc00';
    stage = 'Unicode source edit';
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n' + marker + '\n');
    await page.waitForFunction(value => document.querySelector('.cm-content')?.textContent?.includes(value), marker);
    receipt.checks.push('new document and Unicode source edit');

    stage = 'new window from visible action';
    const originalPages = new Set(browser.contexts().flatMap(context => context.pages()));
    const more = page.locator('details.more-menu');
    if (!await more.evaluate(element => element.open)) await more.locator(':scope > summary').click();
    await more.getByRole('button', {name:/^(新增視窗|New window)$/}).click();
    let childPage;
    for (const until=Date.now()+15000;Date.now()<until;) {
        childPage=browser.contexts().flatMap(context=>context.pages()).find(candidate=>!originalPages.has(candidate));
        if(childPage)break;
        await delay(100);
    }
    assert(childPage,'New window action must create a second real WebView2 page');
    childPage.on('pageerror',error=>pageErrors.push(error.message));
    await waitForFileActions(childPage);
    const mainHealth=await page.evaluate(()=>globalThis.__TAURI_INTERNALS__.invoke('host_health'));
    const childHealth=await childPage.evaluate(()=>globalThis.__TAURI_INTERNALS__.invoke('host_health'));
    receipt.owners={main:mainHealth,child:childHealth};
    assert.notDeepEqual(childHealth,mainHealth,'Each real document window must have its own admitted owner');
    await clickFileAction(childPage, /^(新增文件|New document)$/);
    await childPage.getByRole('button',{name:/^(原始碼|Source)$/}).click();
    const childEditor=childPage.locator('.cm-content[contenteditable="true"]').first();
    await childEditor.click();await childPage.keyboard.press('Control+End');
    await childPage.keyboard.insertText('\nIndependent second document.\n');
    assert((await childEditor.innerText()).includes('Independent second document.'));
    assert(!(await childEditor.innerText()).includes(marker));
    assert((await editor.innerText()).includes(marker));
    assert(!(await editor.innerText()).includes('Independent second document.'));
    receipt.checks.push('UI creates a trusted independent owner and preserves both document contents');
    stage='close child without closing main';
    await childPage.evaluate(()=>globalThis.__TAURI_INTERNALS__.invoke('plugin:window|close',{
        label:globalThis.__TAURI_INTERNALS__.metadata.currentWindow.label
    }));
    const closeDialog=childPage.getByRole('dialog',{name:/^(儲存變更？|Save changes\?)$/});
    await closeDialog.waitFor({state:'visible'});
    await closeDialog.getByRole('button',{name:/^(取消|Cancel)$/}).click();
    assert(!childPage.isClosed());
    await childPage.evaluate(()=>globalThis.__TAURI_INTERNALS__.invoke('plugin:window|close',{
        label:globalThis.__TAURI_INTERNALS__.metadata.currentWindow.label
    }));
    await closeDialog.waitFor({state:'visible'});
    const closed=childPage.waitForEvent('close',{timeout:10000});
    await closeDialog.getByRole('button',{name:/^(不儲存|Don't save)$/}).click();
    await closed;
    assert(!page.isClosed(),'Closing the child window must preserve the main window');
    assert((await editor.innerText()).includes(marker),'Main unsaved document must survive child close');
    assert.deepEqual(pageErrors,[]);
    receipt.checks.push('Child cancel and discard preserve the main window and unsaved source');
    receipt.status='passed';
} catch (error) {
    receipt.status = 'failed';
    receipt.stage = stage;
    receipt.error = String(error);
    await page?.screenshot({path: join(evidence, 'native-multiwindow-e2e.png'), timeout: 3000}).catch(() => {});
    if (page) receipt.visibleState = await Promise.race([
        page.evaluate(() => ({url: location.href, text: document.body.innerText.slice(-12000)})).catch(() => null),
        delay(3000).then(() => ({inspectionTimedOut: true}))
    ]);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    await writeFile(join(evidence, 'native-multiwindow-e2e.json'), JSON.stringify(receipt, null, 2));
    if (app.exitCode === null && app.pid) await new Promise(ok =>
        execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}, ok));
    await browser?.close().catch(() => {});
    assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
    assert(basename(sandbox).startsWith('modutex-multiwindow-e2e-'));
    await rm(sandbox, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    console.log(JSON.stringify(receipt));
}
