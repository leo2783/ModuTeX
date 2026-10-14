import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { resolveNpmCli, runChecks } from '../run-verification.mjs';

test('actual npm frontend:test failure stops aggregate verification before the next gate', { timeout: 60_000 }, async () => {
	const root = resolve(import.meta.dirname, '../..');
	const evidence = resolve(root, '.verification-artifacts');
	await mkdir(evidence, { recursive: true });
	const fixture = await mkdtemp(resolve(evidence, 'frontend-gate-negative-'));
	const marker = resolve(fixture, 'next-gate-ran');
	try {
		await writeFile(resolve(fixture, 'intentional-failure.test.ts'),
			"import { test } from 'node:test'; test('injected CI fault', () => { throw new Error('INTENTIONAL_FRONTEND_GATE_FAILURE'); });\n");
		const next = resolve(fixture, 'next.cjs');
		await writeFile(next, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
		const npmCli = resolveNpmCli();
		const failure = spawnSync(process.execPath, [npmCli, 'run', 'frontend:test', '--', fixture],
			{ cwd: root, encoding: 'utf8', timeout: 45_000 });
		assert.equal(failure.error, undefined); assert.equal(failure.status, 1);
		assert.match(failure.stdout + failure.stderr, /INTENTIONAL_FRONTEND_GATE_FAILURE/,
			'the failure must come from the injected testcase, not setup or missing dependencies');
		const status = runChecks([
			['new frontend', ['run', 'frontend:test', '--', fixture]],
			['must not execute', ['exec', '--no', '--', 'node', next]]
		], { cwd: root, npmCli, stdio: 'pipe' });
		assert.equal(status, 1, 'a real failing discovered frontend test must fail verification');
		await assert.rejects(readFile(marker), { code: 'ENOENT' });
	} finally { await rm(fixture, { recursive: true, force: true }); }
});
