import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { verifyTauriPackage } from '../../scripts/verify-tauri-package.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const SOURCE_LOCK_PATH = 'apps/desktop-tauri/Cargo.lock';
const SOURCE_EXE_PATH = 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe';
const SOURCE_FILES = [
	'apps/desktop-tauri/Cargo.toml',
	'apps/desktop-tauri/Cargo.lock',
	'apps/desktop-tauri/LICENSE',
	'apps/desktop-tauri/NOTICE',
	'vendor/vendor-lock.json',
	'vendor/notices/TECTONIC-LICENSE.txt',
	'vendor/notices/TECTONIC-NOTICE.md'
];

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function makePe(machine = 0x8664) {
	const bytes = Buffer.alloc(512);
	bytes.write('MZ', 0, 'ascii');
	bytes.writeUInt32LE(0x80, 0x3c);
	Buffer.from([0x50, 0x45, 0, 0]).copy(bytes, 0x80);
	bytes.writeUInt16LE(machine, 0x84);
	return bytes;
}

async function copySourceEvidence(sourceRoot) {
	for (const path of SOURCE_FILES) {
		const destination = join(sourceRoot, ...path.split('/'));
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(join(ROOT, ...path.split('/')), destination);
	}
}

async function makeFixture(t, options = {}) {
	const temporary = await mkdtemp(join(tmpdir(), 'modutex-tauri-package-'));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const sourceRoot = join(temporary, 'source');
	const distributionRoot = join(temporary, 'distribution');
	const inputRoot = join(temporary, 'inputs');
	await Promise.all([
		mkdir(sourceRoot, { recursive: true }),
		mkdir(distributionRoot, { recursive: true }),
		mkdir(inputRoot, { recursive: true })
	]);
	await copySourceEvidence(sourceRoot);

	const cargoToml = await readFile(join(sourceRoot, 'apps/desktop-tauri/Cargo.toml'), 'utf8');
	const packageName = /^name\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
	const packageVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
	assert.equal(packageName, 'modutex-desktop-tauri');
	assert.ok(packageVersion);

	const hostBytes = makePe(options.machine ?? 0x8664);
	const sourceIdentity = {
		sourceGitCommit: 'a'.repeat(40),
		cargoLockPath: SOURCE_LOCK_PATH,
		cargoLockSha256: hash(await readFile(join(sourceRoot, SOURCE_LOCK_PATH))),
		exePath: SOURCE_EXE_PATH,
		exeSha256: hash(hostBytes),
		timestamp: '2026-10-18T00:00:00.000Z'
	};
	const sourceIdentityPath = join(inputRoot, 'source-identity.json');
	await writeFile(sourceIdentityPath, jsonBytes(sourceIdentity));

	const payloads = new Map();
	const roles = new Map();
	const expectedHashes = new Map();
	const addPayload = (path, bytes, role, expectedHash = hash(bytes)) => {
		payloads.set(path, bytes);
		roles.set(path, role);
		expectedHashes.set(path, expectedHash);
	};
	addPayload('ModuTeX.exe', hostBytes, 'host-executable');
	addPayload('LICENSE', await readFile(join(sourceRoot, 'apps/desktop-tauri/LICENSE')), 'license');
	addPayload('NOTICE', await readFile(join(sourceRoot, 'apps/desktop-tauri/NOTICE')), 'notice');

	const vendors = [];
	const runtimePaths = ['ModuTeX.exe'];
	const sbomComponents = [
		{
			id: packageName,
			name: packageName,
			version: packageVersion,
			license: 'Apache-2.0',
			files: ['ModuTeX.exe'],
			licenseFiles: ['LICENSE'],
			noticeFiles: ['NOTICE']
		}
	];

	if (options.fixtureThirdParty === true) {
		// Synthetic test-only component data exercises explicit third-party document mapping.
		addPayload(
			'third-party/fixture-license.txt',
			Buffer.from('Test fixture only: explicit license document.\n'),
			'third-party-license'
		);
		addPayload(
			'third-party/fixture-notice.txt',
			Buffer.from('Test fixture only: explicit third-party notice.\n'),
			'third-party-notice'
		);
		sbomComponents.push({
			id: 'fixture-dependency',
			name: 'Fixture-only dependency',
			version: '1.0.0-test',
			license: 'LicenseRef-TestFixture',
			files: ['ModuTeX.exe'],
			licenseFiles: ['third-party/fixture-license.txt'],
			noticeFiles: ['third-party/fixture-notice.txt']
		});
	}

	if (options.fixtureTectonic === true) {
		const vendorLock = JSON.parse(await readFile(join(sourceRoot, 'vendor/vendor-lock.json'), 'utf8'));
		const entry = vendorLock.artifacts['tectonic-windows-x64'];
		const binaryPath = 'vendor/tectonic/windows-x64/tectonic.exe';
		const versionPath = 'vendor/tectonic/VERSION';
		const licensePath = 'vendor/notices/TECTONIC-LICENSE.txt';
		const noticePath = 'vendor/notices/TECTONIC-NOTICE.md';
		addPayload(binaryPath, makePe(), 'vendor-executable', entry.sha256);
		addPayload(versionPath, Buffer.from(`${entry.version}\n`), 'runtime-file');
		addPayload(licensePath, await readFile(join(sourceRoot, ...licensePath.split('/'))), 'third-party-license');
		addPayload(noticePath, await readFile(join(sourceRoot, ...noticePath.split('/'))), 'third-party-notice');
		runtimePaths.push(binaryPath, versionPath);
		vendors.push({
			artifact: 'tectonic-windows-x64',
			binaryPath,
			versionPath,
			targetTriple: options.vendorTargetTriple ?? TARGET_TRIPLE,
			licensePath,
			noticePath
		});
		sbomComponents.push({
			id: 'tectonic-windows-x64',
			name: 'Tectonic',
			version: entry.version,
			license: entry.license,
			files: [binaryPath, versionPath],
			licenseFiles: [licensePath],
			noticeFiles: [noticePath]
		});
	}

	const runtimeFiles = runtimePaths
		.map((path) => ({
			path,
			size: payloads.get(path).length,
			sha256: expectedHashes.get(path)
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	const runtimeInventoryPath = 'runtime-inventory.json';
	const sbomPath = 'sbom.json';
	addPayload(
		runtimeInventoryPath,
		jsonBytes({
			schemaVersion: 1,
			targetTriple: TARGET_TRIPLE,
			files: options.runtimeFiles ?? runtimeFiles
		}),
		'runtime-inventory'
	);
	addPayload(
		sbomPath,
		jsonBytes({
			format: 'modutex-tauri-sbom-v1',
			schemaVersion: 1,
			targetTriple: TARGET_TRIPLE,
			source: {
				sourceGitCommit: sourceIdentity.sourceGitCommit,
				cargoLockSha256: sourceIdentity.cargoLockSha256
			},
			components: sbomComponents
		}),
		'sbom'
	);

	for (const [path, bytes] of payloads) {
		const destination = join(distributionRoot, ...path.split('/'));
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, bytes);
	}

	const files = [...payloads.entries()]
		.map(([path, bytes]) => ({
			path,
			size: bytes.length,
			sha256: expectedHashes.get(path),
			role: roles.get(path)
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	const manifest = {
		format: 'modutex-tauri-package-closure',
		schemaVersion: 1,
		targetTriple: TARGET_TRIPLE,
		hostExecutable: 'ModuTeX.exe',
		runtimeInventory: runtimeInventoryPath,
		sbom: sbomPath,
		files,
		vendors
	};
	const manifestPath = join(inputRoot, 'tauri-package-manifest.json');
	await writeFile(manifestPath, jsonBytes(manifest));
	return {
		temporary,
		sourceRoot,
		distributionRoot,
		sourceIdentity,
		sourceIdentityPath,
		manifest,
		manifestPath,
		options: {
			distributionRoot,
			manifestPath,
			sourceRoot,
			sourceIdentityPath,
			vendorManifestPath: join(sourceRoot, 'vendor/vendor-lock.json')
		}
	};
}

async function persistManifest(fixture) {
	await writeFile(fixture.manifestPath, jsonBytes(fixture.manifest));
}

async function rewritePayload(fixture, path, value) {
	const bytes = jsonBytes(value);
	await writeFile(join(fixture.distributionRoot, ...path.split('/')), bytes);
	const row = fixture.manifest.files.find((item) => item.path === path);
	row.size = bytes.length;
	row.sha256 = hash(bytes);
	await persistManifest(fixture);
}

test('accepts an explicit extracted Windows x64 package tied to current source identity evidence', async (t) => {
	const fixture = await makeFixture(t);
	const report = await verifyTauriPackage(fixture.options);
	assert.equal(report.status, 'verified');
	assert.equal(report.targetTriple, TARGET_TRIPLE);
	assert.equal(report.sourceGitCommit, fixture.sourceIdentity.sourceGitCommit);
	assert.equal(report.cargoLockSha256, fixture.sourceIdentity.cargoLockSha256);
	assert.equal(report.hostExecutable.machine, 'AMD64');
	assert.equal(report.runtimeFiles, 1);
	assert.equal(report.vendors.length, 0);
});

test('requires explicit third-party license and notice references rather than assigning host Apache terms', async (t) => {
	const fixture = await makeFixture(t, { fixtureThirdParty: true });
	const report = await verifyTauriPackage(fixture.options);
	assert.equal(report.status, 'verified');
	assert.equal(report.sbomComponents, 2);

	const sbomPath = join(fixture.distributionRoot, 'sbom.json');
	const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
	sbom.components[1].noticeFiles = [];
	await rewritePayload(fixture, 'sbom.json', sbom);
	await assert.rejects(verifyTauriPackage(fixture.options), /SBOM notice document inventory/);
});

test('rejects x86 PE executables even when the explicit hashes agree', async (t) => {
	const fixture = await makeFixture(t, { machine: 0x014c });
	await assert.rejects(verifyTauriPackage(fixture.options), /not AMD64 PE/);
});

test('rejects missing, modified, and unexpected package payloads', async (t) => {
	await t.test('missing expected file', async (t) => {
		const fixture = await makeFixture(t);
		await rm(join(fixture.distributionRoot, 'NOTICE'));
		await assert.rejects(verifyTauriPackage(fixture.options), /distribution file inventory: missing file \(NOTICE\)/);
	});
	await t.test('modified host executable', async (t) => {
		const fixture = await makeFixture(t);
		await writeFile(join(fixture.distributionRoot, 'ModuTeX.exe'), Buffer.concat([makePe(), Buffer.from([1])]));
		await assert.rejects(verifyTauriPackage(fixture.options), /source-identity executable hash/);
	});
	await t.test('unexpected executable', async (t) => {
		const fixture = await makeFixture(t);
		await writeFile(join(fixture.distributionRoot, 'extra.exe'), makePe());
		await assert.rejects(verifyTauriPackage(fixture.options), /distribution file inventory: unexpected file \(extra.exe\)/);
	});
});

test('rejects runtime/SBOM drift and source identity mismatches', async (t) => {
	await t.test('runtime inventory omits an expected runtime file', async (t) => {
		const fixture = await makeFixture(t, { runtimeFiles: [] });
		await assert.rejects(verifyTauriPackage(fixture.options), /runtime inventory: missing file \(ModuTeX.exe\)/);
	});
	await t.test('SBOM source does not match the source-identity proof', async (t) => {
		const fixture = await makeFixture(t);
		const sbom = JSON.parse(await readFile(join(fixture.distributionRoot, 'sbom.json'), 'utf8'));
		sbom.source.cargoLockSha256 = 'b'.repeat(64);
		await rewritePayload(fixture, 'sbom.json', sbom);
		await assert.rejects(verifyTauriPackage(fixture.options), /SBOM: source commit or Cargo.lock hash/);
	});
	await t.test('source identity Cargo.lock hash differs from the supplied source tree', async (t) => {
		const fixture = await makeFixture(t);
		fixture.sourceIdentity.cargoLockSha256 = 'b'.repeat(64);
		await writeFile(fixture.sourceIdentityPath, jsonBytes(fixture.sourceIdentity));
		await assert.rejects(verifyTauriPackage(fixture.options), /Cargo.lock SHA-256 does not match/);
	});
});

test('rejects host license or notice bytes that do not match the Tauri source scope', async (t) => {
	const fixture = await makeFixture(t);
	const noticePath = join(fixture.distributionRoot, 'NOTICE');
	await writeFile(noticePath, Buffer.from('Modified NOTICE\n'));
	const noticeRow = fixture.manifest.files.find((row) => row.path === 'NOTICE');
	const noticeBytes = await readFile(noticePath);
	noticeRow.size = noticeBytes.length;
	noticeRow.sha256 = hash(noticeBytes);
	await persistManifest(fixture);
	await assert.rejects(verifyTauriPackage(fixture.options), /NOTICE bytes do not match/);
});

test('rejects Electron, Draw.io, legacy, orchestration, cache, and source leakage', async (t) => {
	for (const path of [
		'electron.exe',
		'vendor/drawio/app.js',
		'legacy/host.exe',
		'.github/workflows/tauri-ci.yml',
		'cache/old.exe',
		'src/lib.rs'
	]) {
		await t.test(path, async (t) => {
			const fixture = await makeFixture(t);
			const destination = join(fixture.distributionRoot, ...path.split('/'));
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, 'unexpected');
			await assert.rejects(verifyTauriPackage(fixture.options), /forbidden runtime\/source artifact path/);
		});
	}
});

test('rejects junction or symlink traversal outside the extracted distribution', async (t) => {
	const fixture = await makeFixture(t);
	const outside = join(fixture.temporary, 'outside');
	await mkdir(outside);
	await writeFile(join(outside, 'escaped.exe'), makePe());
	await symlink(
		outside,
		join(fixture.distributionRoot, 'external-link'),
		process.platform === 'win32' ? 'junction' : 'dir'
	);
	await assert.rejects(verifyTauriPackage(fixture.options), /symbolic link or reparse point|escapes the distribution root/);
});

test('validates bundled-engine target and pinned vendor hash without copying a real engine', async (t) => {
	await t.test('rejects a non-Windows-x64 target declaration', async (t) => {
		const fixture = await makeFixture(t, {
			fixtureTectonic: true,
			vendorTargetTriple: 'aarch64-pc-windows-msvc'
		});
		await assert.rejects(verifyTauriPackage(fixture.options), /vendor target triple mismatch/);
	});
	await t.test('rejects synthetic engine bytes against the reviewed Tectonic digest', async (t) => {
		const fixture = await makeFixture(t, { fixtureTectonic: true });
		await assert.rejects(
			verifyTauriPackage(fixture.options),
			/packaged Tectonic resources failed verification|SHA-256 mismatch/
		);
	});
});

test('uses the actual source vendor manifest and rejects malformed manifest input', async (t) => {
	const fixture = await makeFixture(t);
	const vendorPath = join(fixture.sourceRoot, 'vendor/vendor-lock.json');
	const vendorManifest = JSON.parse(await readFile(vendorPath, 'utf8'));
	vendorManifest.unreviewed = true;
	await writeFile(vendorPath, jsonBytes(vendorManifest));
	await assert.rejects(verifyTauriPackage(fixture.options), /vendor manifest validation failed/);
});
