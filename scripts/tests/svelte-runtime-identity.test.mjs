import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const CONSUMERS = [
	'apps/texpile-editor',
	'landing',
	'node_modules/svelte-check',
	'node_modules/@sveltejs/vite-plugin-svelte',
	'node_modules/@sveltejs/kit',
	'node_modules/@skeletonlabs/skeleton-svelte',
	'node_modules/@zag-js/svelte',
	'node_modules/@lucide/svelte',
	'landing/node_modules/@lucide/svelte',
	'node_modules/prettier-plugin-svelte',
	'node_modules/svelte-eslint-parser'
];

test('locked workspaces converge onto exactly one reviewed Svelte installation', async () => {
	const lock = JSON.parse(await readFile(resolve(ROOT, 'package-lock.json'), 'utf8'));
	const root = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
	assert.equal(root.overrides.svelte, '5.56.9');
	for (const workspace of ['apps/texpile-editor', 'landing']) {
		const manifest = JSON.parse(await readFile(resolve(ROOT, workspace, 'package.json'), 'utf8'));
		assert.equal(manifest.devDependencies.svelte, '5.56.9');
		assert.equal(lock.packages[workspace].devDependencies.svelte, '5.56.9');
	}
	const entries = Object.entries(lock.packages).filter(([name]) => name === 'node_modules/svelte' || name.endsWith('/node_modules/svelte'));
	assert.deepEqual(
		entries.map(([name]) => name),
		['node_modules/svelte']
	);
	assert.equal(entries[0][1].version, '5.56.9');
	assert.equal(entries[0][1].license, 'MIT');
	assert.equal(entries[0][1].resolved, 'https://registry.npmjs.org/svelte/-/svelte-5.56.9.tgz');
});

test('actual editor/landing/checker/peer runtime and compiler resolution share one real identity', async (context) => {
	const identities = [];
	for (const consumer of CONSUMERS) {
		const owner = resolve(ROOT, consumer, 'package.json');
		await readFile(owner); // require base must be a genuinely installed consumer
		const require = createRequire(owner);
		const identity = {
			consumer,
			package: await realpath(require.resolve('svelte/package.json')),
			runtime: await realpath(require.resolve('svelte')),
			compiler: await realpath(require.resolve('svelte/compiler'))
		};
		assert.equal(JSON.parse(await readFile(identity.package, 'utf8')).version, '5.56.9');
		identities.push(identity);
	}
	for (const key of ['package', 'runtime', 'compiler']) {
		assert.equal(
			new Set(identities.map((identity) => identity[key])).size,
			1,
			`${key} must have one realpath identity, not merely equal version strings`
		);
	}
	context.diagnostic(JSON.stringify({ consumers: identities.map(({ consumer }) => consumer), identity: identities[0] }));
});
