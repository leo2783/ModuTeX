// SPDX-License-Identifier: Apache-2.0
const { spawn } = require('node:child_process');
const { existsSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const trace = phase => appendFileSync(path.join(__dirname, 'startup-trace.jsonl'), JSON.stringify({ phase, pid: process.pid, at: Date.now() }) + '\n');
process.on('exit', code => trace('exit-' + code));

if (process.argv[2] === 'grandchild') {
	trace('grandchild-start');
	// Exercise startup beyond the old leader's unconditional 400 ms lifetime.
	setTimeout(() => {
		process.stdout.write('GRANDCHILD_NODE_UTF8_終端𠀀_READY_' + process.pid + '\n', () => trace('grandchild-marker-flushed'));
	}, 600);
	setInterval(() => {}, 3000);
} else {
	trace('leader-start');
	const child = spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'inherit' });
	child.on('spawn', () => trace('child-spawned'));
	child.on(require('node:events').errorMonitor, () => trace('child-spawn-error'));
	child.on('exit', code => trace('child-exit-' + code));
	process.stdout.write('LEADER_NODE_PID_' + process.pid + '_CHILD_' + child.pid + '\n', () => trace('leader-marker-flushed'));
	const release = path.join(__dirname, 'release-leader');
	setInterval(() => {
		if (existsSync(release)) process.exit(0);
	}, 10);
	// A failed test cannot leave the fixture running indefinitely.
	setTimeout(() => process.exit(1), 15000);
}
