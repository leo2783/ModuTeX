// SPDX-License-Identifier: Apache-2.0
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

if (process.argv[2] === 'grandchild') {
	// Exercise startup beyond the old leader's unconditional 400 ms lifetime.
	setTimeout(() => {
		console.log('GRANDCHILD_NODE_UTF8_終端𠀀_READY_' + process.pid);
	}, 600);
	setInterval(() => {}, 3000);
} else {
	const child = spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'inherit' });
	console.log('LEADER_NODE_PID_' + process.pid + '_CHILD_' + child.pid);
	const release = path.join(__dirname, 'release-leader');
	setInterval(() => {
		if (existsSync(release)) process.exit(0);
	}, 10);
	// A failed test cannot leave the fixture running indefinitely.
	setTimeout(() => process.exit(1), 15000);
}
