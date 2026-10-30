import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/distribution/generate-component-inventory.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(root, args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'modutex-inventory-'));
	const manifests = {
		'': {
			name: 'fixture-root',
			version: '1.0.0',
			license: 'Apache-2.0',
			dependencies: {},
			devDependencies: { typescript: '6.0.3' }
		},
		'apps/frontend': {
			name: 'fixture-frontend',
			version: '1.0.0',
			license: 'Apache-2.0',
			dependencies: { svelte: '5.56.9' },
			devDependencies: { vite: '8.2.1' }
		},
		landing: {
			name: 'fixture-landing',
			version: '1.0.0',
			license: 'Apache-2.0',
			dependencies: { 'landing-only': '1.0.0' }
		},
		'packages/frontend-contracts': {
			name: 'fixture-contracts',
			version: '1.0.0',
			license: 'Apache-2.0',
			dependencies: {}
		}
	};
	for (const path of Object.keys(manifests).filter(Boolean)) mkdirSync(join(root, path), { recursive: true });
	writeFileSync(join(root, 'package.json'), JSON.stringify(manifests['']));
	for (const path of Object.keys(manifests).filter(Boolean)) {
		writeFileSync(join(root, path, 'package.json'), JSON.stringify(manifests[path]));
	}
	const lockedPackages = { '': manifests[''] };
	for (const path of Object.keys(manifests).filter(Boolean)) lockedPackages[path] = manifests[path];
	for (const [path, version, license] of [
		['node_modules/landing-only', '1.0.0', 'MIT'],
		['node_modules/svelte', '5.56.9', 'MIT'],
		['node_modules/vite', '8.2.1', 'MIT'],
		['node_modules/typescript', '6.0.3', 'Apache-2.0']
	])
		lockedPackages[path] = { version, license, integrity: `sha512-${path}` };
	writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockedPackages }));
	mkdirSync(join(root, 'apps/desktop-tauri'), { recursive: true });
	writeFileSync(
		join(root, 'apps/desktop-tauri/Cargo.toml'),
		'[package]\nname = "fixture-host"\nversion = "1.0.0"\nlicense = "Apache-2.0"\n'
	);
	writeFileSync(join(root, 'apps/desktop-tauri/Cargo.lock'), 'version = 4\n\n[[package]]\nname = "fixture-host"\nversion = "1.0.0"\n');
	writeFileSync(
		join(root, 'apps/desktop-tauri/tauri.conf.json'),
		JSON.stringify({ productName: 'Fixture', version: '1.0.0', bundle: { targets: ['nsis'] } })
	);
	mkdirSync(join(root, 'vendor/tectonic/windows-x64'), { recursive: true });
	mkdirSync(join(root, 'vendor/notices'), { recursive: true });
	writeFileSync(join(root, 'vendor/tectonic/VERSION'), '0.17.0\n');
	writeFileSync(join(root, 'vendor/tectonic/windows-x64/tectonic.exe'), Buffer.from('MZfixture tectonic'));
	writeFileSync(
		join(root, 'vendor/notices/TECTONIC-LICENSE.txt'),
		'Tectonic is licensed under the MIT License. Elements are licensed under a wide variety of open-source licenses.\nPermission is hereby granted.\n'
	);
	writeFileSync(join(root, 'vendor/notices/TECTONIC-NOTICE.md'), '# Tectonic 0.17.0\nTerms are in `TECTONIC-LICENSE.txt`.\n');
	const id = 'fixture-host 1.0.0 (path+file:///fixture)';
	const metadata = {
		packages: [{ id, name: 'fixture-host', version: '1.0.0', license: 'Apache-2.0', source: null }],
		workspace_members: [id],
		resolve: { nodes: [{ id, dependencies: [], deps: [] }] }
	};
	writeFileSync(join(root, 'cargo-metadata.json'), JSON.stringify(metadata));
	const shim = join(root, 'cargo-shim.mjs');
	writeFileSync(
		shim,
		"import {readFileSync} from 'node:fs';\nif (!process.argv.includes('--offline')) process.exit(24);\nprocess.stdout.write(readFileSync(new URL('./cargo-metadata.json', import.meta.url)));\n"
	);
	git(root, ['init', '--quiet']);
	git(root, ['config', 'user.name', 'Inventory Fixture']);
	git(root, ['config', 'user.email', 'inventory@example.invalid']);
	git(root, ['add', '--all']);
	git(root, ['commit', '-m', 'fixture', '--quiet']);
	return { root, shim };
}

function run(root, shim, args = []) {
	return spawnSync(process.execPath, [script, '--root', root, ...args, '--cargo-bin', process.execPath, '--cargo-arg', shim], {
		encoding: 'utf8',
		windowsHide: true
	});
}

function cleanup(t, root) {
	t.after(() => rmSync(root, { recursive: true, force: true }));
}

test('default invocation builds source/build inventory without a payload receipt', (t) => {
	const { root, shim } = fixture();
	cleanup(t, root);
	const result = run(root, shim);
	assert.equal(result.status, 0, result.stderr);
	const output = join(root, '.verification-artifacts/tauri/component-inventory.json');
	assert.equal(existsSync(output), true);
	const inventory = JSON.parse(readFileSync(output, 'utf8'));
	assert.match(inventory.format, /not CycloneDX or SPDX/);
	assert.match(inventory.source.gitCommit, /^[a-f0-9]{40}$/);
	assert.equal(inventory.product.version, '1.0.0');
	assert.equal(inventory.payloadReceipt, null);
	assert.match(inventory.product.artifactStatus, /unverified/);
	assert.equal(inventory.npm.packages.find((item) => item.name === 'svelte').license, 'MIT');
	assert.equal(inventory.npm.packages.find((item) => item.name === 'vite').relationship, 'reachable in selected source/build graph');
	assert.equal(inventory.npm.sourceManifests[0].license, 'Apache-2.0');
	assert.equal(
		inventory.npm.sourceManifests.some((item) => item.path === 'packages/document-core/package.json'),
		false
	);
	const landing = inventory.npm.packages.find((item) => item.name === 'landing-only');
	assert.ok(landing);
	assert.ok(landing.reachableFrom.length > 0);
	assert.ok(landing.reachableFrom.every((scope) => scope.startsWith('landing-site:')));
	assert.equal(inventory.vendoredComponents[0].license, 'MIT');
	assert.equal(inventory.vendoredComponents[0].upstreamNotice.embeddedLicenseVarietyDisclosed, true);
	assert.equal(inventory.distributionEligibility.decision, 'not-established');
});

test('receipt hashes are checked when local artifacts exist and legal/signature claims stay declarations', (t) => {
	const { root, shim } = fixture();
	cleanup(t, root);
	mkdirSync(join(root, 'dist'));
	const app = Buffer.from('MZfixture application');
	const installer = Buffer.from('MZfixture installer');
	const runtime = Buffer.from('fixture WebView2 runtime');
	writeFileSync(join(root, 'dist/modutex.exe'), app);
	writeFileSync(join(root, 'dist/setup.exe'), installer);
	writeFileSync(join(root, 'dist/WebView2Loader.dll'), runtime);
	writeFileSync(
		join(root, 'payload-receipt.json'),
		JSON.stringify({
			installerPath: 'dist/setup.exe',
			installerSha256: sha(installer),
			bundledExeSha256: sha(app),
			files: [
				{ path: 'dist/modutex.exe', sha256: sha(app), sizeBytes: app.length, role: 'application-exe', license: 'Apache-2.0' },
				{ path: 'dist/setup.exe', sha256: sha(installer), sizeBytes: installer.length, role: 'installer' },
				{
					path: 'dist/WebView2Loader.dll',
					sha256: sha(runtime),
					sizeBytes: runtime.length,
					role: 'runtime-file',
					license: 'Microsoft Edge WebView2 Runtime Redistribution'
				}
			],
			thirdPartySignatures: [{ subject: 'Microsoft WebView2', status: 'signed' }]
		})
	);
	const result = run(root, shim, ['--payload-receipt', 'payload-receipt.json']);
	assert.equal(result.status, 0, result.stderr);
	const output = join(root, '.verification-artifacts/tauri/component-inventory.json');
	const inventory = JSON.parse(readFileSync(output, 'utf8'));
	assert.equal(inventory.payloadReceipt.installer.fileHashStatus, 'verified against local file');
	assert.equal(inventory.payloadReceipt.bundledExecutable.fileHashStatus, 'verified against local file');
	assert.equal(inventory.payloadReceipt.files[2].licenseStatus, 'receipt declaration; not independently evaluated');
	assert.match(inventory.payloadReceipt.webView2Review.classificationCandidate, /not established/);
	assert.equal(inventory.payloadReceipt.webView2Review.eligibilityDecision, 'not-established');
	assert.match(inventory.payloadReceipt.thirdPartySignatures[0].verificationStatus, /not cryptographically verified/);
});

for (const scenario of [
	{ role: 'main-executable', expectedExecutable: 'app', accepted: true },
	{ role: 'application-exe', expectedExecutable: 'app', accepted: true },
	{ role: 'main-executable', expectedExecutable: 'compiler', accepted: false }
]) {
	test(`payload inventory distinguishes ${scenario.role} from bundled tools when expected hash belongs to ${scenario.expectedExecutable}`, (t) => {
		const { root, shim } = fixture();
		cleanup(t, root);
		mkdirSync(join(root, 'dist'));
		const payload = [
			{ path: 'dist/modutex.exe', role: scenario.role, bytes: Buffer.from('MZapplication') },
			{ path: 'dist/tectonic.exe', role: 'bundled-tectonic-executable', bytes: Buffer.from('MZcompiler') },
			{ path: 'dist/WebView2Setup.exe', role: 'bundled-webview2-installer', bytes: Buffer.from('MZruntime installer') }
		];
		for (const item of payload) writeFileSync(join(root, item.path), item.bytes);
		const installer = Buffer.from('MZinstaller');
		writeFileSync(join(root, 'dist/setup.exe'), installer);
		writeFileSync(join(root, 'payload-receipt.json'), JSON.stringify({
			installerPath: 'dist/setup.exe',
			installerSha256: sha(installer),
			bundledExeSha256: sha(payload[scenario.expectedExecutable === 'app' ? 0 : 1].bytes),
			files: payload.map(({ path, role, bytes }) => ({ path, role, sha256: sha(bytes), sizeBytes: bytes.length }))
		}));
		const result = run(root, shim, ['--payload-receipt', 'payload-receipt.json']);
		const output = join(root, '.verification-artifacts/tauri/component-inventory.json');
		if (scenario.accepted) {
			assert.equal(result.status, 0, result.stderr);
			const inventory = JSON.parse(readFileSync(output, 'utf8'));
			assert.deepEqual(inventory.payloadReceipt.bundledExecutable.matchingFiles, ['dist/modutex.exe']);
			assert.equal(inventory.payloadReceipt.bundledExecutable.fileHashStatus, 'verified against local file');
		} else {
			assert.notEqual(result.status, 0, 'a third-party tool hash cannot replace the declared main executable');
			assert.match(result.stderr, /Declared application executable does not match bundledExeSha256/);
			assert.equal(existsSync(output), false);
		}
	});
}

test('malformed npm lock removes stale output and exits unsuccessfully', (t) => {
	const { root, shim } = fixture();
	cleanup(t, root);
	const output = join(root, '.verification-artifacts/tauri/component-inventory.json');
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, '{"stale":true}');
	writeFileSync(join(root, 'package-lock.json'), '{malformed');
	const result = run(root, shim);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /package-lock\.json/);
	assert.equal(existsSync(output), false);
});

test('nonzero Cargo metadata process fails without a stale receipt', (t) => {
	const { root, shim } = fixture();
	cleanup(t, root);
	const output = join(root, '.verification-artifacts/tauri/component-inventory.json');
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, '{"stale":true}');
	const result = spawnSync(
		process.execPath,
		[script, '--root', root, '--cargo-bin', process.execPath, '--cargo-arg=-e', '--cargo-arg=process.exit(23)'],
		{ encoding: 'utf8', windowsHide: true }
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Command exited 23/);
	assert.equal(existsSync(output), false);
});
