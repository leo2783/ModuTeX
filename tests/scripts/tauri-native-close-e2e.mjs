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
const sandbox = await mkdtemp(join(tmpdir(), 'modutex-close-e2e-'));
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
    scope: 'actual WM_CLOSE, dirty cancel, repeated close and discard on the release WebView2',
    status: 'running', checks: []};
const watchdog = setTimeout(() => {
    if (app.pid) execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'],
        {windowsHide: true, timeout: 10000}, () => process.exit(1));
}, 120000);
try {
    await waitNativeCdp({ app, port: nativeCdp.port, evidence, lane: 'native-close', stderr: () => stderr, launchError: () => launchError });
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

    const requestNativeClose = () => new Promise((accept, reject) => execFile(
        process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe',
        ['-NoProfile', '-File', join(root, 'tests/scripts/helpers/request-owned-window-close.ps1'),
            '-OwnedProcessId', String(app.pid), '-ExpectedExecutable', exe],
        {windowsHide: true, timeout: 15000},
        (error, stdout, stderr) => error ? reject(Error(stderr + stdout)) : accept(stdout)
    ));
    const closeDialog = page.getByRole('dialog', {name: /^(儲存變更？|Save changes\?)$/});
    stage = 'native close preserves dirty document';
    const firstClose = requestNativeClose();
    void firstClose.catch(() => {});
    await closeDialog.waitFor({state: 'visible', timeout: 10000});
    await closeDialog.getByRole('button', {name: /^(取消|Cancel)$/}).click();
    await firstClose;
    await closeDialog.waitFor({state: 'hidden'});
    assert.equal(app.exitCode, null, 'cancel must keep the native application alive');
    assert((await editor.innerText()).includes(marker), 'cancel must preserve the actual source');
    receipt.checks.push('actual native close and cancel preserve the edited source');
    stage = 'repeated close and explicit discard';
    const secondClose = requestNativeClose();
    void secondClose.catch(() => {});
    await closeDialog.waitFor({state: 'visible', timeout: 10000});
    await closeDialog.getByRole('button', {name: /^(捨棄變更並關閉|Discard changes and close)$/}).click();
    await secondClose;
    await Promise.race([
        app.exitCode !== null ? Promise.resolve() : new Promise(accept => app.once('exit', accept)),
        delay(10000).then(() => { throw Error('Explicit discard did not close the native app'); })
    ]);
    assert.deepEqual(pageErrors, [], 'no uncaught frontend errors');
    receipt.checks.push('repeated native close followed by explicit discard exits the owned app');
    receipt.status = 'passed';
} catch (error) {
    receipt.status = 'failed';
    receipt.stage = stage;
    receipt.error = String(error);
    await page?.screenshot({path: join(evidence, 'native-close-e2e.png'), timeout: 3000}).catch(() => {});
    if (page) receipt.visibleState = await Promise.race([
        page.evaluate(() => ({url: location.href, text: document.body.innerText.slice(-12000)})).catch(() => null),
        delay(3000).then(() => ({inspectionTimedOut: true}))
    ]);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    await writeFile(join(evidence, 'native-close-e2e.json'), JSON.stringify(receipt, null, 2));
    if (app.exitCode === null && app.pid) await new Promise(ok =>
        execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}, ok));
    await browser?.close().catch(() => {});
    assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
    assert(basename(sandbox).startsWith('modutex-close-e2e-'));
    await rm(sandbox, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    console.log(JSON.stringify(receipt));
}
