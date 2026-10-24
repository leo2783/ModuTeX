import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
const gateDirectory = path.resolve(process.env.MODUTEX_LICENSE_GATE_DIR ?? path.join(root, 'scripts/licensing'));
const gate = await import(pathToFileURL(path.join(gateDirectory, 'verify-frontend-origin.mjs')));
const { inventoryFrontend } = await import(pathToFileURL(path.join(gateDirectory, 'frontend-artifacts.mjs')));

test('distribution policy cannot replace trusted Rust checks or exempt a third-party package', async () => {
	const policy = JSON.parse(await readFile(path.join(gateDirectory, '../../docs/licensing/frontend-distribution-policy.json'), 'utf8'));
	assert.doesNotThrow(() => gate.validateDistributionPolicy(policy));
	const changedChecker = structuredClone(policy);
	changedChecker.rustNoticeChecker = 'scripts/licensing/frontend-artifacts.mjs';
	assert.throws(() => gate.validateDistributionPolicy(changedChecker), /UNTRUSTED/);
	const changedFirstParty = structuredClone(policy);
	changedFirstParty.firstPartyPackages.push({ path: 'node_modules/pdfjs-dist', name: 'pdfjs-dist', license: 'Apache-2.0' });
	assert.throws(() => gate.validateDistributionPolicy(changedFirstParty), /UNTRUSTED/);
	assert.equal(gate.isFirstPartyPackage('node_modules/pdfjs-dist', { name: 'modutex-frontend', license: 'Apache-2.0' }), false);
});

test('bundled npm closure requires a locked identity, supported license and its complete notice', () => {
	const license = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.';
	const item = {
		path: 'node_modules/license-fixture',
		name: 'license-fixture',
		version: '1.2.3',
		declaredLicense: 'MIT',
		documents: [{ path: 'LICENSE', text: license }]
	};
	const lock = { packages: { [item.path]: { version: item.version, integrity: 'sha512-fixture' } } };
	const notice = `## ${item.name} ${item.version}\n\n${license}`;
	assert.deepEqual(gate.validateNpmPackageClosure([item], lock, notice), []);
	assert(gate.validateNpmPackageClosure([item], lock, '').some((item) => item.kind === 'package-license-text-not-in-notice'));
	assert(gate.validateNpmPackageClosure([item], { packages: {} }, notice).some((item) => item.kind === 'unlocked-bundled-package'));
	assert(
		gate
			.validateNpmPackageClosure([{ ...item, declaredLicense: 'AGPL-3.0-only' }], lock, notice)
			.some((item) => item.kind === 'forbidden-license-expression')
	);
	assert(
		gate
			.validateNpmPackageClosure([{ ...item, declaredLicense: 'LicenseRef-Unreviewed' }], lock, notice)
			.some((item) => item.kind === 'manual-review-required')
	);
});

test('Rust implementation evidence checks actual source hashes and rejects arbitrary nested path records', async () => {
	const origin = JSON.parse(await readFile(path.join(root, 'docs/licensing/tauri-origin.json'), 'utf8'));
	const record = origin.newImplementations.find((item) => item.scope === 'crates/document-core');
	assert(record);
	const source = record.files.find((item) => item.path === 'crates/document-core/src/source.rs');
	assert(source);
	const notice = await readFile(path.join(root, 'apps/frontend/src/features/document-core/generated/RUST_THIRD_PARTY_NOTICES.md'), 'utf8');
	assert.deepEqual(await gate.validateNewImplementationOrigin(root, origin, [source.path], notice), []);
	const forged = { newImplementations: [{ scope: 'other', nested: { path: source.path } }] };
	assert(
		(await gate.validateNewImplementationOrigin(root, forged, [source.path], notice)).some(
			(item) => item.kind === 'missing-rust-implementation-provenance'
		)
	);
	const changed = structuredClone(origin);
	changed.newImplementations.find((item) => item.scope === record.scope).files.find((item) => item.path === source.path).sha256 =
		'0'.repeat(64);
	assert(
		(await gate.validateNewImplementationOrigin(root, changed, [source.path], notice)).some(
			(item) => item.kind === 'rust-implementation-file-hash-mismatch'
		)
	);
});

async function bundleFixture(run) {
	const directory = await mkdtemp(path.join(root, '.verification-artifacts/license-gate-fixture-'));
	try {
		const source = 'export const answer = 42;\n';
		for (const dir of ['apps/frontend/src', 'apps/frontend/dist/.vite', 'apps/frontend/dist-tauri/.vite'])
			await mkdir(path.join(directory, dir), { recursive: true });
		await writeFile(
			path.join(directory, 'apps/frontend/package.json'),
			JSON.stringify({ name: 'modutex-frontend', version: '0.2.1', license: 'Apache-2.0' })
		);
		await writeFile(path.join(directory, 'apps/frontend/src/main.ts'), source);
		const map = { version: 3, file: 'index.js', names: [], sources: ['../src/main.ts'], sourcesContent: [source], mappings: 'AAAA' };
		for (const dist of ['dist', 'dist-tauri']) {
			const target = path.join(directory, 'apps/frontend', dist);
			await writeFile(path.join(target, 'index.js'), source + '//# sourceMappingURL=index.js.map\n');
			await writeFile(path.join(target, 'index.js.map'), JSON.stringify(map));
			await writeFile(
				path.join(target, '.vite/manifest.json'),
				JSON.stringify({ 'src/main.ts': { file: 'index.js', src: 'src/main.ts', isEntry: true } })
			);
		}
		await run(directory, map);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('inventory preserves the default distribution and rejects missing, empty and unrelated source maps', async () => {
	await bundleFixture(async (directory, map) => {
		const baseline = await inventoryFrontend(directory);
		assert.equal(baseline.scope, 'apps/frontend/dist');
		assert.deepEqual(baseline.unresolved, []);
		const explicit = await inventoryFrontend(directory, 'apps/frontend/dist-tauri');
		assert.equal(explicit.scope, 'apps/frontend/dist-tauri');
		assert.deepEqual(explicit.unresolved, []);
		const file = path.join(directory, 'apps/frontend/dist/index.js.map');
		for (const mutation of [
			{ ...map, sources: [], sourcesContent: [] },
			{ ...map, mappings: '' },
			{ ...map, file: 'unrelated.js' }
		]) {
			await writeFile(file, JSON.stringify(mutation));
			const result = await inventoryFrontend(directory);
			assert(result.unresolved.length > 0, 'invalid map must prevent origin closure');
		}
		await rm(file);
		assert((await inventoryFrontend(directory)).unresolved.some((item) => item.kind === 'invalid-source-map-reference'));
	});
});

test('an exact installed PDF worker URL asset is traced without pretending it is a normal mapped chunk', async () => {
	await bundleFixture(async (directory) => {
		const packageDirectory = path.join(directory, 'node_modules/pdfjs-dist');
		await mkdir(path.join(packageDirectory, 'build'), { recursive: true });
		await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: 'pdfjs-dist', version: '6.2.108', license: 'Apache-2.0' }));
		await writeFile(path.join(packageDirectory, 'LICENSE'), 'Apache License\nVersion 2.0\n');
		const worker = '/* PDF.js Apache License Version 2.0 */\nexport const workerFixture = true;\n';
		await writeFile(path.join(packageDirectory, 'build/pdf.worker.mjs'), worker);
		const dist = path.join(directory, 'apps/frontend/dist');
		await mkdir(path.join(dist, 'assets'), { recursive: true });
		await writeFile(path.join(dist, 'assets/pdf.worker.mjs'), worker);
		await writeFile(path.join(dist, 'index.js'), 'export default "./assets/pdf.worker.mjs";\n//# sourceMappingURL=index.js.map\n');
		await writeFile(path.join(dist, 'index.js.map'), JSON.stringify({ version: 3, file: 'index.js', names: [], sources: ['../../../node_modules/pdfjs-dist/build/pdf.worker.mjs?url'], sourcesContent: ['export default "__VITE_ASSET__proof__";'], mappings: 'AAAA' }));
		await writeFile(path.join(dist, '.vite/manifest.json'), JSON.stringify({ 'src/main.ts': { file: 'index.js', assets: ['assets/pdf.worker.mjs'], isEntry: true } }));
		const verified = await inventoryFrontend(directory);
		assert(verified.sources.some(item => item.generatedResources?.some(resource => resource.emitted.endsWith('/pdf.worker.mjs'))));
		assert.deepEqual(verified.unresolved.filter(item => item.path?.endsWith('/pdf.worker.mjs')), [], 'the exact traced URL resource must use its actual installed-package evidence');
		await writeFile(path.join(dist, 'assets/pdf.worker.mjs'), worker + '// changed bytes\n');
		const changed = await inventoryFrontend(directory);
		assert(changed.unresolved.some(item => item.kind === 'url-resource-unverified'), 'a changed worker must fail byte provenance');
	});
});
