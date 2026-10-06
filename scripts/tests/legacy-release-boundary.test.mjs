import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const removed = [
	'.github/workflows/release.yml',
	'.github/workflows/prerelease.yml',
	'.github/workflows/dl-worker.yml',
	'apps/texpile-editor/scripts/update-yml.mjs',
	'apps/texpile-editor/scripts/latest-json.mjs',
	'apps/texpile-editor/scripts/release-notes.mjs',
	'apps/texpile-editor/scripts/release.mjs'
];

const forbiddenReleaseSurface =
	/(?:release\.yml|git\s+push\s+--follow-tags|dl\.texpile\.com|updates\.texpile\.com|electron-updater|texpile-releases|gh\s+release\s+create|wrangler\s+r2|latest(?:-mac|-linux)?\.yml|\.blockmap)/i;

test('legacy release and updater entrypoints are absent', () => {
	for (const relative of removed) {
		assert.equal(existsSync(join(root, relative)), false, `${relative} must remain deleted`);
	}
});

test('legacy download worker directory is absent', () => {
	assert.throws(
		() => lstatSync(join(root, 'tools/dl-worker')),
		{ code: 'ENOENT' },
		'tools/dl-worker must not exist, including newly added files or symlinks'
	);
});

test('remaining workflows cannot publish a release or updater feed', () => {
	const workflowDir = join(root, '.github/workflows');
	const workflowText = readdirSync(workflowDir)
		.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
		.map((name) => readFileSync(join(workflowDir, name), 'utf8'))
		.join('\n');

	assert.doesNotMatch(workflowText, forbiddenReleaseSurface);
});

test('package scripts do not expose deleted release entrypoints', () => {
	for (const relative of ['package.json', 'apps/texpile-editor/package.json']) {
		const manifest = JSON.parse(readFileSync(join(root, relative), 'utf8'));
		const scripts = Object.values(manifest.scripts ?? {}).join('\n');
		assert.doesNotMatch(scripts, /(?:update-yml|latest-json|release-notes|release)\.mjs/);
		assert.doesNotMatch(scripts, forbiddenReleaseSurface);
	}
});

test('remaining production helpers do not describe or call the legacy publication path', () => {
	const roots = ['apps/texpile-editor/scripts', 'scripts'];
	const pending = roots.map((relative) => join(root, relative));
	const files = [];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const absolute = join(current, entry.name);
			if (entry.isDirectory() && absolute !== join(root, 'scripts/tests')) pending.push(absolute);
			else if (/\.(?:mjs|cjs|js|ts|md)$/i.test(entry.name)) files.push(absolute);
		}
	}

	for (const file of files) {
		assert.doesNotMatch(readFileSync(file, 'utf8'), forbiddenReleaseSurface, file);
	}
});
