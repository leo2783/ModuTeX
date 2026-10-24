// SPDX-License-Identifier: Apache-2.0
// Real native UI; Git CLI is used only to configure the test repository and verify disk state.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { waitNativeCdp } from './helpers/wait-native-cdp.mjs';
const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.verification-artifacts/tauri');
const exe = resolve(process.env.MODUTEX_TEST_EXE ?? join(root, 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'modutex-git-native-e2e-'));
const workspace = join(scratch, `git workspace 漢字 ${basename(scratch)}`);
await mkdir(workspace);
await writeFile(join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}Native Git.\\end{document}\n');
await writeFile(join(workspace, '章節.txt'), 'first Unicode revision\n');
const exec = (file, args, cwd = root) => new Promise((ok, fail) => execFile(file, args,
 { cwd, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? fail(Error(`${error}: ${stderr}`)) : ok(stdout.trim())));
const git = args => exec('git.exe', args, workspace);
const socket = createServer();
await new Promise((ok, fail) => socket.once('error', fail).listen(0, '127.0.0.1', ok));
const port = socket.address().port;
await new Promise(ok => socket.close(ok));
const app = spawn(exe, [], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
 ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(scratch, 'webview'),
 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
} });
let browser, page, launchError, stage = 'launch', stderr = '';
app.once('error', e => launchError = e);
app.stderr.on('data', data => stderr = (stderr + data).slice(-8192));
const receipt = { createdAt: new Date().toISOString(), exe,
 sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
 scope: 'real native Git UI initialize, status, stage/unstage, commit, Unicode diff/log/show and unchanged unstaged bytes',
 status: 'running', checks: [], pageErrors: [] };
const watchdog = setTimeout(() => {
 if (app.pid) execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }, () => process.exit(1));
}, 150000);
try {
 await waitNativeCdp({ app, port, evidence, lane: 'g4-git', stderr: () => stderr, launchError: () => launchError });
 browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
 page = browser.contexts().flatMap(context => context.pages())[0];
 assert(page);
 page.on('pageerror', e => receipt.pageErrors.push(e.message));
 stage = 'owned picker';
 const selected = exec(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File',
  join(root, 'tests/scripts/helpers/select-owned-folder.ps1'), '-OwnedProcessId', String(app.pid),
  '-ExpectedExecutablePath', exe, '-FolderPath', workspace]);
 void selected.catch(() => {});
 await page.getByRole('button', { name: /^(開啟資料夾|Open folder)$/ }).click();
 await selected;
 const panel = page.locator('.git-panel');
 const button = name => panel.getByRole('button', { name });
 async function idle() { await page.waitForFunction(() => document.querySelector('.git-panel')?.getAttribute('aria-busy') === 'false'); }
 stage = 'initialize through native UI';
 await button(/^(初始化 Git 儲存庫|Initialize Git repository)$/).click();
 await idle();
 assert.equal(await git(['rev-parse', '--is-inside-work-tree']), 'true');
 await git(['config', '--local', 'user.name', 'ModuTeX E2E']);
 await git(['config', '--local', 'user.email', 'native-test@example.invalid']);
 receipt.checks.push('UI initialized the real test repository');
 stage = 'stage and unstage before first commit';
 await button(/^(暫存全部|Stage all)$/).click(); await idle();
 assert((await git(['diff', '--cached', '--name-only', '-z'])).includes('章節.txt'));
 await button(/^(取消全部暫存|Unstage all)$/).click(); await idle();
 assert.equal(await git(['diff', '--cached', '--name-only']), '');
 await button(/^(暫存全部|Stage all)$/).click(); await idle();
 receipt.checks.push('UI stages and unstages real Unicode paths before HEAD exists');
 stage = 'commit exact message';
 const message = 'Native Unicode 漢字 commit';
 await panel.getByLabel(/^(提交訊息|Commit message)$/).fill(message);
 await button(/^(提交已暫存變更|Commit staged changes)$/).click(); await idle();
 assert.equal(await git(['log', '-1', '--format=%B']), message);
 assert.equal(await git(['status', '--porcelain']), '');
 receipt.checks.push('UI commit persisted exact message and staged bytes');
 stage = 'working diff and history';
 await writeFile(join(workspace, '章節.txt'), 'second Unicode revision 漢字\n');
 await button(/^(重新整理|Refresh)$/).click(); await idle();
 await panel.getByRole('checkbox', { name: /^(選取 |Select )章節.txt$/ }).check();
 await button(/^(工作區差異|Worktree diff)$/).click(); await idle();
 assert((await panel.locator('textarea.git-output-viewer').inputValue()).includes('second Unicode revision'));
 await button(/^(Git 紀錄|Git log)$/).click(); await idle();
 assert((await panel.locator('textarea.git-output-viewer').inputValue()).includes(message));
 await button(/^(顯示 HEAD|Show HEAD)$/).click(); await idle();
 assert((await panel.locator('textarea.git-output-viewer').inputValue()).includes(message));
 assert.equal(await readFile(join(workspace, '章節.txt'), 'utf8'), 'second Unicode revision 漢字\n');
 assert.equal(await panel.locator('[role="alert"]').count(), 0);
 assert.deepEqual(receipt.pageErrors, []);
 receipt.checks.push('UI reads native diff/log/show without mutating unstaged Unicode file');
 receipt.status = 'passed';
} catch (error) {
 receipt.status = 'failed'; receipt.stage = stage; receipt.error = String(error); receipt.stderr = stderr;
 if (page) { receipt.body = (await page.locator('body').innerText().catch(() => '')).slice(-9000);
  await page.screenshot({ path: join(evidence, 'g4-git-native-e2e.png') }).catch(() => {}); }
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
 await writeFile(join(evidence, 'g4-git-native-e2e.json'), JSON.stringify(receipt, null, 2));
 await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }).catch(() => {});
 console.log(JSON.stringify(receipt));
}
