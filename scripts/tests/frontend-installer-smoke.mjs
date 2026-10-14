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
const installer = resolve(process.argv[2] ?? 'release/ModuTeX-Setup-0.2.0.exe');
function run(command, args, timeout = 360000) {
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
 if (installed) await run(join(install, 'Uninstall ModuTeX.exe'), ['/S']);
 assert.equal(relative(root, fixture), within);
 await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
