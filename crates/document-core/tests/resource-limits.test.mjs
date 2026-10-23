// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../../..');
const directory = path.resolve(root, process.env.MODUTEX_DOCUMENT_CORE_WASM_DIR ?? 'apps/frontend/src/features/document-core/generated');

test('Rust WASM parser bounds deep nesting and allocation under an exhausted parse budget', () => {
	const worker = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as core from ${JSON.stringify(pathToFileURL(path.join(directory, 'modutex_document_core.js')).href)};
core.initSync({module:await readFile(${JSON.stringify(path.join(directory, 'modutex_document_core_bg.wasm'))})});
const encoder=new TextEncoder();
for(const source of ['\\\\textbf{'.repeat(256)+'x'+'}'.repeat(256), 'a '.repeat(500000)]) {
 const document=core.SourceDocument.open(encoder.encode(source));
 let projection;
 try {
  projection=core.parseSourceWithLimits(document,64,10000);
  const issues=JSON.parse(projection.issuesJson());
  assert(issues.some(issue=>issue.code==='BUDGET'||issue.code==='depth-limit'), JSON.stringify(issues));
  const compact=projection.compactNodes();
  assert(compact.length<=65*8, 'bounded projection output');
 } finally {projection?.free();document.free();}
}
process.stdout.write('bounded');
`;
	const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--stack-size=512', '--input-type=module', '-e', worker], {
		cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, 'bounded');
	assert.doesNotMatch(result.stderr, /heap out of memory|Maximum call stack|FATAL ERROR/i);
});
