// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'scripts/licensing/rust-notices.mjs');
const output = 'apps/frontend/src/features/document-core/generated/RUST_THIRD_PARTY_NOTICES.md';

test('generated Rust notices retain exact locked runtime and Unicode license texts', async () => {
	const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	const metadata = spawnSync('cargo', ['metadata', '--locked', '--offline', '--manifest-path', 'crates/document-core/Cargo.toml', '--features', 'wasm', '--filter-platform', 'wasm32-unknown-unknown', '--format-version', '1'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
	assert.equal(metadata.status, 0, metadata.stderr);
	const packages = JSON.parse(metadata.stdout).packages;
	const notices = await readFile(join(root, output), 'utf8');
	for (const name of ['flate2', 'serde', 'serde_json', 'wasm-bindgen', 'unicode-ident']) {
		const pkg = packages.find(pkg => pkg.name === name);
		assert(pkg, `Missing locked dependency ${name}`);
		assert(notices.includes(`## ${name} ${pkg.version}\n`));
		assert(notices.includes(pkg.license));
		for (const filename of name === 'unicode-ident' ? ['LICENSE-APACHE', 'LICENSE-MIT', 'LICENSE-UNICODE'] : ['LICENSE-APACHE', 'LICENSE-MIT']) {
			const original = await readFile(join(dirname(pkg.manifest_path), filename), 'utf8');
			assert(notices.includes(original), `Changed or missing upstream text: ${name}/${filename}`);
		}
	}
});

async function isolatedGeneration(change) {
	const fixture = await mkdtemp(join(root, '.verification-artifacts', 'rust-notices-fixture-'));
	try {
		const cli = join(fixture, 'scripts/licensing/rust-notices.mjs');
		await mkdir(dirname(cli), { recursive: true });
		await copyFile(script, cli);
		const manifest = join(fixture, 'crates/document-core/Cargo.toml');
		await mkdir(dirname(manifest), { recursive: true });
		await writeFile(manifest, '[package]\nname="modutex-document-core"\nversion="0.1.0"\n');
		const dependency = join(fixture, 'registry/fixture');
		await mkdir(dependency, { recursive: true });
		await writeFile(join(dependency, 'LICENSE-MIT'), 'Original MIT fixture copyright text\n');
		await writeFile(join(dependency, 'LICENSE-APACHE'), 'Original Apache fixture copyright text\n');
		const own = { id: 'root', name: 'modutex-document-core', version: '0.1.0', manifest_path: manifest, source: null };
		const pkg = { id: 'dependency', name: 'fixture', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', manifest_path: join(dependency, 'Cargo.toml'), license: 'MIT OR Apache-2.0', license_file: null };
		const metadata = { packages: [own, pkg], resolve: { nodes: [{ id: 'root', deps: [{ pkg: 'dependency', dep_kinds: [{ kind: null }] }] }, { id: 'dependency', deps: [] }] } };
		await change({ metadata, pkg, dependency });
		const data = join(fixture, 'metadata.json');
		await writeFile(data, JSON.stringify(metadata));
		const preload = join(fixture, 'cargo-fixture.mjs');
		await writeFile(preload, `import cp from 'node:child_process'; import {readFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; cp.spawnSync = command => { if (command !== 'cargo') throw new Error('Unexpected command'); return {status:0, stdout:readFileSync(${JSON.stringify(data)},'utf8'), stderr:''}; }; syncBuiltinESMExports();`);
		const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--stack-size=512', '--import', pathToFileURL(preload).href, cli], {
			cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024
		});
		return { ...result, generated: result.status === 0 ? await readFile(join(fixture, output), 'utf8') : null };
	} finally {
		const owned = relative(join(root, '.verification-artifacts'), fixture);
		assert(owned.startsWith('rust-notices-fixture-') && !owned.includes(sep) && !owned.includes('..'));
		await rm(fixture, { recursive: true, force: true });
	}
}

test('Rust notices reject omitted local dependencies, copyleft metadata and missing required Unicode text', async () => {
	const baseline = await isolatedGeneration(async () => {});
	assert.equal(baseline.status, 0, baseline.stderr);
	const cases = [
		{ pattern: /Unsupported non-local package source/, mutate: async ({ metadata }) => {
			metadata.packages.push({ id: 'local', name: 'vendored', version: '1.0.0', source: null });
			metadata.resolve.nodes.push({ id: 'local', deps: [] });
			metadata.resolve.nodes[0].deps.push({ pkg: 'local', dep_kinds: [{ kind: null }] });
		} },
		{ pattern: /unexpected SPDX/, mutate: async ({ pkg }) => { pkg.license = 'AGPL-3.0-only'; } },
		{ pattern: /Missing license text/, mutate: async ({ pkg }) => { pkg.license = '(MIT OR Apache-2.0) AND Unicode-3.0'; } },
		{ pattern: /Unsafe license path/, mutate: async ({ pkg }) => { pkg.license_file = '../outside/LICENSE'; } }
	];
	for (const { pattern, mutate } of cases) {
		const result = await isolatedGeneration(mutate);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, pattern);
	}
});

test('Rust notice rendering handles many delimiter matches within bounded child memory, stack and time', async () => {
	const license = '`x~y'.repeat(150_000);
	const result = await isolatedGeneration(async ({ dependency }) => {
		await writeFile(join(dependency, 'LICENSE-MIT'), license);
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.generated.includes(license), 'license text remains exact without spreading all regex matches as arguments');
});

test('Rust notice rendering rejects oversized input before regex matching or output allocation', async () => {
	const result = await isolatedGeneration(async ({ dependency }) => {
		await writeFile(join(dependency, 'LICENSE-MIT'), '`'.repeat(2 * 1024 * 1024 + 1));
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /size|limit|large/i);
	assert.doesNotMatch(result.stderr, /heap out of memory|Maximum call stack|allocation failed|FATAL ERROR/i);
});
