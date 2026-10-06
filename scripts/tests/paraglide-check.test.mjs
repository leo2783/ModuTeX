import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const editor = resolve(root, 'apps/texpile-editor');
// Use npm bundled with the Node running this test, never download a toolchain.
const npmCli = resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js');
const manifest = JSON.parse(await readFile(resolve(editor, 'package.json'), 'utf8'));

async function fixture(t) {
	const dir = await mkdtemp(resolve(root, 'apps/.issue-65-check-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(resolve(dir, 'project.inlang'));
	await mkdir(resolve(dir, 'src/lib'), { recursive: true });
	await cp(resolve(editor, 'scripts'), resolve(dir, 'scripts'), { recursive: true });
	await cp(resolve(editor, 'project.inlang/settings.json'), resolve(dir, 'project.inlang/settings.json'));
	await cp(resolve(editor, 'messages'), resolve(dir, 'messages'), { recursive: true });
	await writeFile(resolve(dir, 'package.json'), JSON.stringify(manifest));
	await cp(resolve(editor, 'tsconfig.json'), resolve(dir, 'tsconfig.json'));
	await writeFile(
		resolve(dir, 'src/App.svelte'),
		'<script lang="ts">\nimport { m } from "./lib/paraglide/messages.js";\nimport { getLocale } from "./lib/paraglide/runtime.js";\n</script>\n<p>{m.start_heading({}, { locale: getLocale() })}</p>\n'
	);
	// Blocking transport is the only instrumentation; SDK, compiler, npm and
	// svelte-check are all their installed production implementations.
	await writeFile(
		resolve(dir, 'offline.mjs'),
		'globalThis.fetch = async () => { throw new Error("HTTP blocked by #65 offline test"); };\n'
	);
	return dir;
}

function run(dir, args) {
	const result = spawnSync(process.execPath, args, {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(resolve(dir, 'offline.mjs')).href}` },
		encoding: 'utf8',
		timeout: 120_000,
		maxBuffer: 4 * 1024 * 1024
	});
	assert.ifError(result.error);
	return { status: result.status, output: result.stdout + result.stderr };
}

function check(dir) {
	return run(dir, [npmCli, 'run', 'check']);
}

test('real generation precedes Svelte check and produces usable modules and declarations offline', async (t) => {
	const dir = await fixture(t);
	const before = run(dir, [resolve(root, 'node_modules/svelte-check/bin/svelte-check'), '--tsconfig', './tsconfig.json']);
	assert.equal(before.status, 1, before.output);
	assert.match(before.output, /Cannot find module.*paraglide/);
	const result = check(dir);
	assert.equal(result.status, 0, result.output);
	assert.ok(result.output.indexOf('Paraglide generation complete') < result.output.indexOf('Loading svelte-check'), result.output);
	assert.match(result.output, /0 errors and 0 warnings/);
	assert.doesNotMatch(result.output, /Cannot find module.*paraglide/);
	for (const file of ['messages.js', 'messages.d.ts', 'runtime.js', 'runtime.d.ts']) {
		assert.ok((await readFile(resolve(dir, 'src/lib/paraglide', file), 'utf8')).length);
	}
	const { m } = await import(pathToFileURL(resolve(dir, 'src/lib/paraglide/messages.js')).href);
	for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'de']) {
		const source = JSON.parse(await readFile(resolve(dir, 'messages', `${locale}.json`), 'utf8'));
		assert.equal(m.start_heading({}, { locale }), source.start_heading);
	}
	// The new command must still propagate actual type failures after generation.
	await writeFile(resolve(dir, 'src/broken.ts'), 'const value: number = "wrong";\nexport { value };\n');
	const broken = check(dir);
	assert.equal(broken.status, 1, broken.output);
	assert.match(broken.output, /Type 'string' is not assignable to type 'number'/);
	assert.match(broken.output, /1 error and 0 warnings/);
	t.diagnostic('unchanged production tsconfig: missing modules resolved, 0 errors; deliberate type error exits 1');
});

test('real SDK plugin import failure stops check and removes previously generated output', async (t) => {
	const dir = await fixture(t);
	const good = check(dir);
	assert.equal(good.status, 0, good.output);
	const settingsPath = resolve(dir, 'project.inlang/settings.json');
	const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
	settings.modules[0] = '../../node_modules/@inlang/plugin-message-format/dist/missing.js';
	await writeFile(settingsPath, JSON.stringify(settings));
	const failed = check(dir);
	assert.equal(failed.status, 1, failed.output);
	assert.match(failed.output, /Inlang project loading failed/);
	assert.match(failed.output, /missing\.js/);
	assert.doesNotMatch(failed.output, /Loading svelte-check|svelte-check found/);
	await assert.rejects(readFile(resolve(dir, 'src/lib/paraglide/messages.js')), { code: 'ENOENT' });
});

test('malformed translation input fails generation rather than silently checking incomplete modules', async (t) => {
	const dir = await fixture(t);
	await writeFile(resolve(dir, 'messages/en.json'), '{ malformed JSON');
	const failed = check(dir);
	assert.equal(failed.status, 1, failed.output);
	assert.match(failed.output, /Inlang project loading failed|SyntaxError/);
	assert.doesNotMatch(failed.output, /Loading svelte-check|svelte-check found/);
	await assert.rejects(readFile(resolve(dir, 'src/lib/paraglide/messages.js')), { code: 'ENOENT' });
});

test('watch checks use the same generation prerequisite without weakening Svelte options', () => {
	assert.equal(manifest.scripts['check:watch'], `${manifest.scripts.check} --watch`);
});
