// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedWorkspaceFileRequest } from '../../src/features/files/workspace-files-confirmation.ts';

test('confirmedWorkspaceFileRequest returns null until explicitly confirmed with a target', () => {
	let called = 0;
	const files = {
		async recycle() {
			called++;
		},
		async delete() {
			called++;
			return { token: 'tok-1', expiresInMs: 5000 };
		}
	};

	assert.equal(
		confirmedWorkspaceFileRequest(files, 'ws-1', { action: 'delete', path: 'a.tex' }, false),
		null
	);
	assert.equal(confirmedWorkspaceFileRequest(files, 'ws-1', null, true), null);
	assert.equal(called, 0);
});

test('confirmedWorkspaceFileRequest dispatches delete or recycle only when invoked', async () => {
	const log: string[] = [];
	const files = {
		async recycle(workspaceId: string, path: string) {
			log.push(`recycle:${workspaceId}:${path}`);
		},
		async delete(workspaceId: string, path: string) {
			log.push(`delete:${workspaceId}:${path}`);
			return { token: 'tok-2', expiresInMs: 5000 };
		}
	};

	const delReq = confirmedWorkspaceFileRequest(
		files,
		'ws-1',
		{ action: 'delete', path: 'chapters/intro.tex' },
		true
	);
	assert.ok(delReq);
	assert.equal(log.length, 0);
	const receipt = await delReq();
	assert.deepEqual(receipt, { token: 'tok-2', expiresInMs: 5000 });

	const recReq = confirmedWorkspaceFileRequest(
		files,
		'ws-1',
		{ action: 'recycle', path: 'draft.tex' },
		true
	);
	assert.ok(recReq);
	await recReq();

	assert.deepEqual(log, ['delete:ws-1:chapters/intro.tex', 'recycle:ws-1:draft.tex']);
});
