import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer acceptance requires an ephemeral CI runner');
assert.equal(process.env.CI, 'true');
assert.ok(process.env.RUNNER_TEMP);
const root = realpathSync.native(process.env.RUNNER_TEMP);
const fixture = await mkdtemp(join(root, 'modutex-install-'));
const install = join(fixture, 'application');
const within = relative(root, fixture);
assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
const installer = resolve(process.argv[2] ?? 'release/ModuTeX-Setup-0.2.1.exe');
function run(command, args, timeout = 420000) {
 return new Promise((done, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: 'inherit', timeout });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`${command}: exit ${code}, signal ${signal}`)));
 });
}
let installed = false;
try {
 // NSIS requires /D to be the final argument; the path is passed without shell interpolation.
 await run(installer, ['/S', `/D=${install}`]);
 installed = true;
 const exe = join(install, 'ModuTeX.exe');
 await access(exe);
 await run(process.execPath, ['scripts/tests/frontend-packaged-smoke.mjs', exe]);
 console.log('Installed application: open/save/reopen, language, PDF and close verified');
} finally {
 if (installed) {
  await run(join(install, 'Uninstall ModuTeX.exe'), ['/S']);
  // NSIS may hand off to a temporary uninstaller. Observe the application removal
  // before fixture cleanup so deletion cannot hide a failed uninstall.
  let removed = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
   try { await access(join(install, 'ModuTeX.exe')); }
   catch (error) { if (error.code === 'ENOENT') { removed = true; break; } throw error; }
   await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(removed, 'Uninstaller must remove the installed application');
 }
 assert.equal(relative(root, fixture), within);
 await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
