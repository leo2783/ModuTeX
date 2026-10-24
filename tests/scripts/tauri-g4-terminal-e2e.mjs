// SPDX-License-Identifier: Apache-2.0
// Real Tauri WebView2 + native folder picker + ConPTY. No mocked host transport.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { waitNativeCdp } from './helpers/wait-native-cdp.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.verification-artifacts/tauri');
const exe = resolve(process.env.MODUTEX_TEST_EXE ?? join(root, 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'modutex-terminal-e2e-'));
const workspace = join(scratch, `工作區 \ud840\udc00 ${basename(scratch)}`);
await mkdir(workspace);
await writeFile(join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}Terminal E2E\\end{document}\n');
const exec = (file, args) => new Promise((ok, fail) => execFile(file, args,
    { cwd: root, windowsHide: true, timeout: 30000 }, (error, out, err) => error ? fail(Error(`${error}: ${err}`)) : ok(out.trim())));
const sourceGitCommit = await exec('git', ['rev-parse', 'HEAD']);
const socket = createServer();
await new Promise((ok, fail) => socket.once('error', fail).listen(0, '127.0.0.1', ok));
const port = socket.address().port;
await new Promise(ok => socket.close(ok));
const app = spawn(exe, [], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(scratch, 'webview'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
let browser, page, launchError, stderr = '', stage = 'launch';
app.once('error', error => { launchError = error; });
app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
const receipt = { createdAt: new Date().toISOString(), sourceGitCommit, exe,
    sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
    scope: 'candidate native folder picker, terminal start, actual shell writes, resize, exit/restart and close; not full G0-G7 acceptance',
    status: 'running', checks: [], pageErrors: [] };
const watchdog = setTimeout(() => {
    if (app.pid) execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10000 }, () => process.exit(1));
}, 120000);
try {
    await waitNativeCdp({ app, port, evidence, lane: 'g4-terminal', stderr: () => stderr, launchError: () => launchError });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
    page = browser.contexts()[0].pages()[0];
    assert(page);
    page.on('pageerror', error => receipt.pageErrors.push(String(error)));
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    stage = 'native workspace picker';
    const selected = exec(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File',
        join(root, 'tests/scripts/helpers/select-owned-folder.ps1'), '-OwnedProcessId', String(app.pid), '-ExpectedExecutablePath', exe, '-FolderPath', workspace]);
    void selected.catch(() => {});
    await page.getByRole('button', { name: /^(開啟資料夾|Open folder)$/ }).click();
    receipt.picker = JSON.parse(await selected);
    await page.waitForFunction(() => document.body.innerText.includes('main.tex'));
    receipt.checks.push('native folder picker opened Unicode workspace');
    if (process.env.MODUTEX_WATCH_DIAGNOSTIC === '1') {
        const selectProbe = exec(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File',
            join(root, 'tests/scripts/helpers/select-owned-folder.ps1'), '-OwnedProcessId', String(app.pid), '-ExpectedExecutablePath', exe, '-FolderPath', workspace]);
        void selectProbe.catch(() => {});
        const probe = page.evaluate(async () => {
            const url = performance.getEntriesByType('resource').map(entry => entry.name)
                .find(name => /\/desktop-[^/]+\.js$/.test(name));
            if (!url) throw Error('Desktop module was not loaded');
            const { desktopFiles } = await import(url);
            const port = desktopFiles();
            const owned = await port.openWorkspace('folder');
            if (!owned) return { cancelled: true };
            try {
                const unsubscribe = await port.watchFiles(owned.id, () => {}, () => {});
                await unsubscribe();
                return { started: true };
            } catch (error) { return { started: false, error: String(error) }; }
            finally { await port.closeWorkspace(owned.id); }
        });
        void probe.catch(() => {});
        await selectProbe;
        receipt.nativeWatchContract = await probe;
    }
    stage = 'terminal start';
    await page.locator('[data-terminal-action="toggle"]').click();
    await page.locator('[data-terminal-action="start"]').click();
    await page.locator('.terminal-dock .xterm-helper-textarea').waitFor();
    const input = page.locator('.terminal-dock .xterm-helper-textarea');
    const marker = `native-terminal-${Date.now()}`;
    await input.focus();
    await page.keyboard.insertText(`echo ${marker}>terminal-proof.txt`);
    await page.keyboard.press('Enter');
    const proof = join(workspace, 'terminal-proof.txt');
    let diskValue = '';
    for (const until = Date.now() + 15000; Date.now() < until;) {
        diskValue = await readFile(proof, 'utf8').catch(() => '');
        if (diskValue.trim() === marker) break;
        await delay(100);
    }
    assert.equal(diskValue.trim(), marker, 'real shell must write inside the selected workspace');
    receipt.checks.push('actual ConPTY shell input wrote expected disk bytes');
    stage = 'terminal resize and exit';
    await page.setViewportSize({ width: 1100, height: 760 });
    await input.focus();
    await page.keyboard.insertText('exit');
    await page.keyboard.press('Enter');
    await page.locator('[data-terminal-action="restart"]').waitFor();
    await page.locator('[data-terminal-action="restart"]').click();
    await page.waitForFunction(() => /終端機已連線|Terminal connected/.test(document.querySelector('.terminal-status')?.textContent ?? ''));
    await page.locator('[data-terminal-action="close"]').click();
    await page.waitForFunction(() => document.querySelector('[data-terminal-action="toggle"]')?.getAttribute('aria-expanded') === 'false');
    receipt.checks.push('real shell exited, restarted and panel closed after cleanup');
    stage = 'native file watch';
    await writeFile(join(workspace, 'watch-proof.tex'), '% external file watcher proof\n');
    await page.getByText('watch-proof.tex', { exact: true }).waitFor({ timeout: 10000 });
    receipt.checks.push('native file watch refreshed external file creation');
    assert.deepEqual(receipt.pageErrors, []);
    await page.screenshot({ path: join(evidence, 'g4-terminal-e2e.png') });
    receipt.status = 'passed';
} catch (error) {
    receipt.status = 'failed'; receipt.stage = stage; receipt.error = String(error);
    receipt.visibleState = await page?.evaluate(() => document.body.innerText.slice(-10000)).catch(() => null);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    if (page && !page.isClosed()) {
        try {
            await page.evaluate(() => { location.hash = '#/'; });
            const remove = page.getByRole('button', { name: `移除 ${basename(workspace)} 的紀錄`, exact: true });
            await remove.waitFor({ state: 'visible', timeout: 5000 });
            await remove.click();
            await remove.waitFor({ state: 'detached', timeout: 5000 });
            receipt.testRecentRemoved = true;
        } catch (error) {
            receipt.testRecentRemoved = false;
            receipt.recentCleanupError = String(error);
            receipt.status = 'failed';
            process.exitCode = 1;
        }
    }
    await writeFile(join(evidence, 'g4-terminal-e2e.json'), JSON.stringify(receipt, null, 2));
    if (app.exitCode === null && app.pid) await new Promise(ok => execFile('taskkill.exe',
        ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, ok));
    await browser?.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
}
