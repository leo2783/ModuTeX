import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveNpmCli, runChecks } from '../run-verification.mjs';

const runner = fileURLToPath(new URL('../run-verification.mjs', import.meta.url));
const json = (value) => `${JSON.stringify(value, null, '\t')}\n`;

async function createFixture() {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-verification-'));
	const marker = join(directory, 'marker.txt');
	await writeFile(
		join(directory, 'package.json'),
		json({
			name: 'modutex-verification-fixture',
			private: true,
			scripts: {
				first: 'node first.cjs',
				second: 'node second.cjs',
				fail: 'node fail.cjs',
				'after-fail': 'node after-fail.cjs'
			}
		})
	);
	await writeFile(join(directory, 'first.cjs'), "require('node:fs').appendFileSync(process.env.MODUTEX_MARKER, 'first\\n');\n");
	await writeFile(join(directory, 'second.cjs'), "require('node:fs').appendFileSync(process.env.MODUTEX_MARKER, 'second\\n');\n");
	await writeFile(
		join(directory, 'fail.cjs'),
		"require('node:fs').appendFileSync(process.env.MODUTEX_MARKER, 'fail\\n'); process.exit(23);\n"
	);
	await writeFile(join(directory, 'after-fail.cjs'), "require('node:fs').appendFileSync(process.env.MODUTEX_MARKER, 'after-fail\\n');\n");
	return { directory, marker };
}

test('runs every real npm child in a successful sequence', async () => {
	const fixture = await createFixture();
	try {
		const status = runChecks(
			[
				['first', ['run', 'first']],
				['second', ['run', 'second']]
			],
			{
				npmCli: resolveNpmCli(),
				cwd: fixture.directory,
				env: { ...process.env, MODUTEX_MARKER: fixture.marker },
				stdio: 'ignore'
			}
		);
		assert.equal(status, 0);
		assert.equal(await readFile(fixture.marker, 'utf8'), 'first\nsecond\n');
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test('returns the real failing exit code and stops the sequence', async () => {
	const fixture = await createFixture();
	try {
		const status = runChecks(
			[
				['fail', ['run', 'fail']],
				['after fail', ['run', 'after-fail']]
			],
			{
				npmCli: resolveNpmCli(),
				cwd: fixture.directory,
				env: { ...process.env, MODUTEX_MARKER: fixture.marker },
				stdio: 'ignore'
			}
		);
		assert.equal(status, 23);
		assert.equal(await readFile(fixture.marker, 'utf8'), 'fail\n');
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test('requires an absolute existing regular npm CLI file', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-npm-cli-'));
	try {
		assert.throws(() => resolveNpmCli({}), /npm_execpath is required/);
		assert.throws(() => resolveNpmCli({ npm_execpath: 'npm-cli.js' }), /absolute path/);
		assert.throws(() => resolveNpmCli({ npm_execpath: join(directory, 'missing.js') }), /existing regular file/);
		assert.throws(() => resolveNpmCli({ npm_execpath: directory }), /existing regular file/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('rejects an invalid verification mode with exit code 2', () => {
	const result = spawnSync(process.execPath, [runner, 'invalid'], {
		encoding: 'utf8',
		env: { ...process.env, npm_execpath: resolveNpmCli() }
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Usage: node scripts\/run-verification\.mjs/);
});
