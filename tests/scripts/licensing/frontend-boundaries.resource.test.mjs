// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
const inspector = pathToFileURL(path.join(root, 'scripts/licensing/frontend-boundaries.mjs')).href;

test('CSS boundary scanning has bounded time and memory for many unterminated url prefixes', async () => {
	const parent = path.join(root, '.verification-artifacts');
	const directory = await mkdtemp(path.join(parent, 'css-resource-fixture-'));
	try {
		for (const source of ['apps/frontend/src', 'packages/document-core/src', 'packages/frontend-contracts/src', 'docs/licensing'])
			await mkdir(path.join(directory, source), { recursive: true });
		await writeFile(path.join(directory, 'apps/frontend/tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' } }));
		await writeFile(path.join(directory, 'apps/frontend/vite.config.ts'), 'export default {};\n');
		await writeFile(path.join(directory, 'docs/licensing/frontend-origin.json'), JSON.stringify({ bundledDocuments: { files: [] }, generated: [] }));
		const cssPath = path.join(directory, 'apps/frontend/src/unclosed.css');
		await writeFile(cssPath, 'body { color: red; }');
		const code = `import {inspectFrontendBoundaries} from ${JSON.stringify(inspector)}; const result = await inspectFrontendBoundaries(${JSON.stringify(directory)}); process.stdout.write(JSON.stringify({findings:result.findings, references:result.references}));`;
		const baseline = spawnSync(process.execPath, ['--max-old-space-size=192', '--stack-size=512', '--input-type=module', '-e', code], {
			cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024
		});
		assert.ifError(baseline.error);
		assert.equal(baseline.status, 0, baseline.stderr);
		await writeFile(cssPath, 'url('.repeat(100_000));
		const result = spawnSync(process.execPath, ['--max-old-space-size=192', '--stack-size=512', '--input-type=module', '-e', code], {
			cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024
		});
		assert.ifError(result.error);
		assert.equal(result.signal, null, result.stderr);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).references, []);
		assert.doesNotMatch(result.stderr, /heap out of memory|Maximum call stack|FATAL ERROR/i);
	} finally {
		assert.equal(path.dirname(directory), parent);
		assert.ok(path.basename(directory).startsWith('css-resource-fixture-'));
		await rm(directory, { recursive: true, force: true });
	}
});
