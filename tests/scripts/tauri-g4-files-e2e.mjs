// SPDX-License-Identifier: Apache-2.0
// Real native workspace operations UI with independent disk-state verification.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { clickFileAction } from './helpers/app-file-actions.mjs';
import { createNativeCdpConfig } from './helpers/native-cdp-config.mjs';
import { waitNativeCdp } from './helpers/wait-native-cdp.mjs';
const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.verification-artifacts/tauri');
const exe = resolve(process.env.MODUTEX_TEST_EXE ?? join(root, 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'modutex-files-native-e2e-'));
const workspace = join(scratch, `files workspace 漢字 ${basename(scratch)}`);
await mkdir(workspace);
await writeFile(join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}Native Git.\\end{document}\n');
await writeFile(join(workspace, '章節.txt'), 'first Unicode revision\n');
const exec = (file, args, cwd = root) => new Promise((ok, fail) => execFile(file, args,
 { cwd, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? fail(Error(`${error}: ${stderr}`)) : ok(stdout.trim())));
const nativeCdp = await createNativeCdpConfig(join(scratch, 'webview'));
const app = spawn(exe, [], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
 ...process.env, ...nativeCdp.env
} });
let browser, page, launchError, stage = 'launch', stderr = '';
app.once('error', e => launchError = e);
app.stderr.on('data', data => stderr = (stderr + data).slice(-8192));
const receipt = { createdAt: new Date().toISOString(), exe,
 sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
 scope: 'real native workspace files UI: create Unicode/binary, search, rename/copy, confirmation/cancel/delete/undo with disk proof',
 status: 'running', checks: [], pageErrors: [] };
const watchdog = setTimeout(() => {
 if (app.pid) execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }, () => process.exit(1));
}, 150000);
try {
 await waitNativeCdp({ app, port: nativeCdp.port, evidence, lane: 'g4-files', stderr: () => stderr, launchError: () => launchError });
 browser = await chromium.connectOverCDP(`http://127.0.0.1:${nativeCdp.port}`, { timeout: 10000 });
 page = browser.contexts().flatMap(context => context.pages())[0];
 assert(page);
 page.on('pageerror', e => receipt.pageErrors.push(e.message));
 stage = 'owned picker';
 const selected = exec(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File',
  join(root, 'tests/scripts/helpers/select-owned-folder.ps1'), '-OwnedProcessId', String(app.pid),
  '-ExpectedExecutablePath', exe, '-FolderPath', workspace]);
 void selected.catch(() => {});
 await clickFileAction(page, /^(開啟資料夾|Open folder)$/);
 await selected;
 const dialog = page.locator('.workspace-files-dialog');
 stage = 'open native workspace operations';
 await page.getByRole('button', { name: /^(工作區檔案操作|Workspace file operations)$/ }).click();
 await dialog.waitFor({ state: 'visible' });
 const button = name => dialog.getByRole('button', { name });
 const form = () => dialog.locator('form');
 async function status(name) { await dialog.locator('.workspace-files-status').filter({ hasText: name }).waitFor(); }
 async function context(path, action) {
  await dialog.locator('.tree-file[title="' + path + '"]').click({ button: 'right' });
  await dialog.getByRole('group', { name: /^(檔案操作|File actions)$/ }).getByRole('button', { name: action }).click();
 }
 stage = 'create Unicode directory and file';
 await button(/^(新增資料夾|New folder)$/).click();
 await dialog.getByLabel(/^(工作區相對路徑|Workspace-relative path)$/).fill('資源');
 await form().getByRole('button', { name: /^(建立資料夾|Create folder)$/ }).click();
 await status('資源');
 await button(/^(新增檔案|New file)$/).click();
 await dialog.getByLabel(/^(工作區相對路徑|Workspace-relative path)$/).fill('資源/note.txt');
 const contents = 'Needle漢字 café\n';
 await dialog.getByLabel(/^UTF-8 /).fill(contents);
 await form().getByRole('button', { name: /^(建立檔案|Create file)$/ }).click();
 await status('資源/note.txt');
 assert.equal(await readFile(join(workspace, '資源/note.txt'), 'utf8'), contents);
 receipt.checks.push('UI creates real Unicode folder and exact UTF-8 file bytes');
 stage = 'create binary file';
 await button(/^(新增檔案|New file)$/).click();
 await dialog.getByLabel(/^(工作區相對路徑|Workspace-relative path)$/).fill('binary.dat');
 const binary = Buffer.from([0, 255, 128, 1, 13, 10]);
 await dialog.getByLabel(/^選擇二進位內容|^Select binary contents/).setInputFiles({ name: 'binary.dat', mimeType: 'application/octet-stream', buffer: binary });
 await form().getByRole('button', { name: /^(建立檔案|Create file)$/ }).click();
 await status('binary.dat');
 assert.deepEqual(await readFile(join(workspace, 'binary.dat')), binary);
 receipt.checks.push('UI binary upload preserves actual disk bytes');
 stage = 'native search';
 await button(/^(搜尋|Search)$/).click();
 await dialog.getByLabel(/^(搜尋文字|Search text)$/).fill('Needle漢字');
 await form().getByRole('button', { name: /^(搜尋|Search)$/ }).click();
 await dialog.locator('.workspace-files-results').getByRole('button', { name: /資源\/note.txt/ }).waitFor();
 receipt.checks.push('UI search finds native Unicode file contents');
 stage = 'rename and copy';
 await context('資源/note.txt', /^(重新命名…|Rename…)$/);
 await dialog.getByLabel(/^(目的地工作區相對路徑|Destination workspace-relative path)$/).fill('資源/renamed.txt');
 await form().getByRole('button', { name: /^(重新命名|Rename)$/ }).click();
 await status('資源/renamed.txt');
 assert.equal(await readFile(join(workspace, '資源/renamed.txt'), 'utf8'), contents);
 await assert.rejects(readFile(join(workspace, '資源/note.txt')), { code: 'ENOENT' });
 await context('資源/renamed.txt', /^(複製檔案…|Copy item…)$/);
 await dialog.getByLabel(/^(目的地工作區相對路徑|Destination workspace-relative path)$/).fill('copy.txt');
 await form().getByRole('button', { name: /^(複製|Copy)$/ }).click();
 await status('copy.txt');
 assert.equal(await readFile(join(workspace, 'copy.txt'), 'utf8'), contents);
 receipt.checks.push('UI rename and async copy publish exact expected disk state');
 stage = 'confirmed recoverable delete and undo';
 await context('copy.txt', /^(可復原刪除…|Recoverable delete…)$/);
 assert.equal(await readFile(join(workspace, 'copy.txt'), 'utf8'), contents);
 await dialog.locator('.workspace-files-confirm').getByRole('button', { name: /^(取消|Cancel)$/ }).click();
 assert.equal(await readFile(join(workspace, 'copy.txt'), 'utf8'), contents);
 await context('copy.txt', /^(可復原刪除…|Recoverable delete…)$/);
 await dialog.locator('.workspace-files-confirm').getByRole('button', { name: /^(可復原刪除|Delete recoverably)$/ }).click();
 await status(/已可復原刪除|Recoverably deleted/);
 await assert.rejects(readFile(join(workspace, 'copy.txt')), { code: 'ENOENT' });
 await dialog.locator('.workspace-files-undo').getByRole('button', { name: /^(復原|Undo)$/ }).click();
 await status(/已復原|Restored/);
 assert.equal(await readFile(join(workspace, 'copy.txt'), 'utf8'), contents);
 receipt.checks.push('UI cancel preserves bytes; confirmed delete and native undo restore them');
 assert.equal(await dialog.locator('[role="alert"]').count(), 0);
 assert.deepEqual(receipt.pageErrors, []);
 await button(/^(關閉檔案操作|Close workspace file operations)$/).click();
 receipt.status = 'passed';
} catch (error) {
 receipt.status = 'failed'; receipt.stage = stage; receipt.error = String(error); receipt.stderr = stderr;
 if (page) { receipt.body = (await page.locator('body').innerText().catch(() => '')).slice(-9000);
  await page.screenshot({ path: join(evidence, 'g4-files-native-e2e.png') }).catch(() => {}); }
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
 if (browser) await browser.close().catch(() => {});
 if (app.pid) await exec('taskkill.exe', ['/PID', String(app.pid), '/T', '/F']).catch(() => {});
 await writeFile(join(evidence, 'g4-files-native-e2e.json'), JSON.stringify(receipt, null, 2));
 await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }).catch(() => {});
 console.log(JSON.stringify(receipt));
}

