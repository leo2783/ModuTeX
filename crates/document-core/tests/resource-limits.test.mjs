// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../../..');
const directory = path.resolve(root, process.env.MODUTEX_DOCUMENT_CORE_WASM_DIR ?? 'apps/frontend/src/features/document-core/generated');

function assertBoundedParse(limits) {
	const worker = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as core from ${JSON.stringify(pathToFileURL(path.join(directory, 'modutex_document_core.js')).href)};
core.initSync({module:await readFile(${JSON.stringify(path.join(directory, 'modutex_document_core_bg.wasm'))})});
const { command, repetitions, maxNodes, maxSteps, expectedCode } = ${JSON.stringify(limits)};
const source = command ? command.repeat(repetitions) + 'x' + '}'.repeat(repetitions) : 'a '.repeat(repetitions);
const document = core.SourceDocument.open(new TextEncoder().encode(source));
let projection;
try {
 projection = core.parseSourceWithLimits(document, maxNodes, maxSteps);
 const issues = JSON.parse(projection.issuesJson());
 assert.deepEqual([...new Set(issues.map(issue => issue.code))], [expectedCode], JSON.stringify(issues));
 const compact = projection.compactNodes();
 assert(compact.length > 0 && compact.length <= (maxNodes + 1) * 8, 'bounded projection output');
} finally {
 projection?.free();
 document.free();
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
}

test('Rust WASM parser reports DEPTH for nested commands with budget remaining', () => {
	assertBoundedParse({
		command: '\\textbf{', repetitions: 80, maxNodes: 256, maxSteps: 100_000, expectedCode: 'DEPTH'
	});
});

test('Rust WASM parser reports BUDGET for oversized input with no nesting', () => {
	assertBoundedParse({
		repetitions: 500_000, maxNodes: 64, maxSteps: 10_000, expectedCode: 'BUDGET'
	});
});
