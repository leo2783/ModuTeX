import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
	TECTONIC_EXECUTABLE_SHA256,
	TECTONIC_EXECUTABLE_SIZE,
	TECTONIC_NOTICE_SHA256,
	TECTONIC_LICENSE_SHA256,
	installTectonicArchive,
	inspectTectonicZipBuffer,
	verifyPeAmd64,
	verifyPackagedTectonicResources,
	verifyTectonicInstallation
} from './tectonic-vendor.mjs';
import { createProvenanceRecord } from './vendor-artifact.mjs';

const repositoryRoot = new URL('../../', import.meta.url);
const vendorManifest = JSON.parse(await readFile(new URL('../../vendor/vendor-lock.json', import.meta.url), 'utf8'));
const tectonicEntry = vendorManifest.artifacts['tectonic-windows-x64'];
const tectonicArchivePath = (directory) => join(directory, tectonicEntry.archive);
const writeTectonicProvenance = async (
	directory,
	record = createProvenanceRecord('tectonic-windows-x64', tectonicEntry, 'explicit-archive', '2026-09-30T00:00:00.000Z')
) => writeFile(join(directory, `${tectonicEntry.archive}.provenance.json`), `${JSON.stringify(record, null, 2)}\n`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

const crc32 = (bytes) => {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
};

const createPe = (machine = 0x8664) => {
	const bytes = Buffer.alloc(512);
	bytes.write('MZ', 0, 'ascii');
	bytes.writeUInt32LE(0x80, 0x3c);
	bytes.write('PE\0\0', 0x80, 'binary');
	bytes.writeUInt16LE(machine, 0x84);
	bytes.writeUInt16LE(1, 0x86);
	bytes.writeUInt16LE(0xf0, 0x94);
	bytes.writeUInt16LE(0x2022, 0x96);
	bytes.writeUInt16LE(0x20b, 0x98);
	return bytes;
};

const unixMode = (mode) => (mode << 16) >>> 0;

const createZip = (entries) => {
	const localParts = [];
	const centralParts = [];
	let localOffset = 0;

	for (const entry of entries) {
		const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8');
		const data = Buffer.from(entry.data);
		const compressed = entry.method === 0 ? data : deflateRawSync(data);
		const method = entry.method ?? 8;
		const checksum = entry.crc32 ?? crc32(data);
		const flags = entry.flags ?? 0x0800;
		const externalAttributes = entry.externalAttributes ?? unixMode(0o100644);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(externalAttributes, 38);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(central, name);
		localOffset += local.length + name.length + compressed.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
};

const policyFor = (executable) => ({
	executableName: 'tectonic.exe',
	executableSize: executable.length,
	executableSha256: sha256(executable)
});

const createRetainedVendorCopy = async (vendorRoot) => {
	const tectonicRoot = join(vendorRoot, 'tectonic');
	const executableRoot = join(tectonicRoot, 'windows-x64');
	const noticeRoot = join(vendorRoot, 'notices');
	await mkdir(executableRoot, { recursive: true });
	await mkdir(noticeRoot);
	await writeFile(join(tectonicRoot, 'VERSION'), '0.17.0\n');
	await copyFile(new URL('../../vendor/tectonic/windows-x64/tectonic.exe', import.meta.url), join(executableRoot, 'tectonic.exe'));
	await copyFile(new URL('../../vendor/notices/TECTONIC-LICENSE.txt', import.meta.url), join(noticeRoot, 'TECTONIC-LICENSE.txt'));
	await copyFile(new URL('../../vendor/notices/TECTONIC-NOTICE.md', import.meta.url), join(noticeRoot, 'TECTONIC-NOTICE.md'));
	return { tectonicRoot };
};

test('accepts one reviewed deflated PE32+ AMD64 executable and returns its exact bytes', () => {
	const executable = createPe();
	const result = inspectTectonicZipBuffer(createZip([{ name: 'tectonic.exe', data: executable }]), policyFor(executable));
	assert.deepEqual(result.executable, executable);
	assert.equal(result.entryCount, 1);
	assert.equal(result.machine, 'AMD64');
	assert.equal(result.sha256, sha256(executable));
});

test('rejects unsafe Windows paths before inventory acceptance', () => {
	const executable = createPe();
	const unsafeNames = [
		'/tectonic.exe',
		'\\tectonic.exe',
		'C:\\tectonic.exe',
		'..\\tectonic.exe',
		'safe/../tectonic.exe',
		'tectonic.exe:payload',
		'CON',
		'aux.txt',
		'tectonic.exe.',
		'tectonic.exe '
	];
	for (const name of unsafeNames) {
		assert.throws(
			() => inspectTectonicZipBuffer(createZip([{ name, data: executable }]), policyFor(executable)),
			/unsafe ZIP entry path/,
			name
		);
	}

	const nulName = Buffer.from('tectonic.exe\0payload', 'binary');
	assert.throws(
		() => inspectTectonicZipBuffer(createZip([{ name: nulName, data: executable }]), policyFor(executable)),
		/unsafe ZIP entry path/
	);
});

test('rejects case-insensitive duplicate entry names', () => {
	const executable = createPe();
	assert.throws(
		() =>
			inspectTectonicZipBuffer(
				createZip([
					{ name: 'tectonic.exe', data: executable },
					{ name: 'TECTONIC.EXE', data: executable }
				]),
				policyFor(executable)
			),
		/duplicate-case ZIP entry/
	);
});

test('rejects symbolic-link and Windows reparse entries', () => {
	const executable = createPe();
	assert.throws(
		() =>
			inspectTectonicZipBuffer(
				createZip([
					{
						name: 'tectonic.exe',
						data: executable,
						externalAttributes: unixMode(0o120777)
					}
				]),
				policyFor(executable)
			),
		/symbolic-link ZIP entry/
	);
	assert.throws(
		() =>
			inspectTectonicZipBuffer(
				createZip([
					{
						name: 'tectonic.exe',
						data: executable,
						externalAttributes: (unixMode(0o100644) | 0x0400) >>> 0
					}
				]),
				policyFor(executable)
			),
		/Windows reparse ZIP entry/
	);
});

test('rejects every unreviewed executable, DLL, and additional archive entry', () => {
	const executable = createPe();
	for (const name of ['helper.exe', 'payload.dll', 'README.txt']) {
		assert.throws(
			() =>
				inspectTectonicZipBuffer(
					createZip([
						{ name: 'tectonic.exe', data: executable },
						{ name, data: Buffer.from('unreviewed') }
					]),
					policyFor(executable)
				),
			/unreviewed ZIP inventory/,
			name
		);
	}
});

test('rejects corrupt content and a non-AMD64 PE without writing it', () => {
	const executable = createPe();
	const corruptZip = createZip([{ name: 'tectonic.exe', data: executable, crc32: (crc32(executable) + 1) >>> 0 }]);
	assert.throws(() => inspectTectonicZipBuffer(corruptZip, policyFor(executable)), /CRC-32 mismatch/);
	assert.throws(
		() =>
			inspectTectonicZipBuffer(createZip([{ name: 'tectonic.exe', data: executable }]), {
				...policyFor(executable),
				executableSha256: sha256(Buffer.from('wrong executable digest'))
			}),
		/Tectonic executable SHA-256 mismatch/
	);
	assert.throws(() => verifyPeAmd64(createPe(0x014c)), /PE machine is not AMD64/);
});

test('archive SHA-256 mismatch fails before the retained installation can change', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-archive-mismatch-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const archive = tectonicArchivePath(directory);
	await writeFile(archive, Buffer.from('unverified archive bytes'));
	await writeTectonicProvenance(directory);

	await assert.rejects(installTectonicArchive(archive), /tectonic-windows-x64: SHA-256 mismatch/);
	const report = await verifyTectonicInstallation(repositoryRoot);
	assert.equal(report.executable.sha256, TECTONIC_EXECUTABLE_SHA256);
});

test('installer requires the Issue #40 provenance sidecar before reading the archive', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-no-provenance-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const archive = tectonicArchivePath(directory);
	await writeFile(archive, Buffer.from('unverified archive bytes'));

	await assert.rejects(installTectonicArchive(archive), /tectonic-windows-x64: exact provenance metadata filename required/);
});

test('installer rejects provenance URL, archive-name, and SHA drift on the production path', async (context) => {
	for (const [field, value] of [
		['version', '0.17.1'],
		['url', 'https://github.com/attacker/tectonic/releases/download/forged.zip'],
		['archive', 'tectonic-0.17.0-forged.zip'],
		['sha256', '0'.repeat(64)],
		['provenance', 'https://github.com/attacker/tectonic/releases/tag/forged']
	]) {
		const directory = await mkdtemp(join(tmpdir(), `modutex-tectonic-provenance-${field}-`));
		context.after(() => rm(directory, { recursive: true, force: true }));
		await writeFile(tectonicArchivePath(directory), Buffer.from('unverified archive bytes'));
		const record = createProvenanceRecord('tectonic-windows-x64', tectonicEntry, 'explicit-archive', '2026-09-30T00:00:00.000Z');
		record[field] = value;
		await writeTectonicProvenance(directory, record);

		await assert.rejects(
			installTectonicArchive(tectonicArchivePath(directory)),
			/tectonic-windows-x64: cache provenance metadata does not match the reviewed manifest/,
			`provenance ${field} drift`
		);
	}
});

test('installer rejects a non-manifest archive filename before cache verification', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-wrong-name-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const archive = join(directory, 'tectonic-forged.zip');
	await writeFile(archive, Buffer.from('unverified archive bytes'));

	await assert.rejects(installTectonicArchive(archive), /Tectonic archive filename mismatch/);
});

test('installer rejects a junction at the cached archive path before extraction', async (context) => {
	const cacheDirectory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-archive-junction-'));
	const targetDirectory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-archive-junction-target-'));
	context.after(async () => {
		await rm(cacheDirectory, { recursive: true, force: true });
		await rm(targetDirectory, { recursive: true, force: true });
	});
	await writeTectonicProvenance(cacheDirectory);
	await symlink(targetDirectory, tectonicArchivePath(cacheDirectory), 'junction');

	await assert.rejects(
		installTectonicArchive(tectonicArchivePath(cacheDirectory)),
		/tectonic-windows-x64: archive must be a regular file inside the selected directory/
	);
});

test('retained installation has exact inventory, version, notices, PE identity, and hashes', async () => {
	const report = await verifyTectonicInstallation(repositoryRoot);
	assert.equal(report.version, '0.17.0');
	assert.equal(report.files, 2);
	assert.equal(report.executable.bytes, TECTONIC_EXECUTABLE_SIZE);
	assert.equal(report.executable.sha256, TECTONIC_EXECUTABLE_SHA256);
	assert.equal(report.executable.machine, 'AMD64');
	assert.equal(report.notices.noticeSha256, TECTONIC_NOTICE_SHA256);
	assert.equal(report.notices.licenseSha256, TECTONIC_LICENSE_SHA256);
});

test('retained verifier rejects a junction in the executable path', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'modutex-tectonic-link-'));
	const tectonicRoot = join(root, 'vendor', 'tectonic');
	const linkedDirectory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-link-target-'));
	context.after(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(linkedDirectory, { recursive: true, force: true });
	});
	await mkdir(tectonicRoot, { recursive: true });
	await writeFile(join(tectonicRoot, 'VERSION'), '0.17.0\n');
	await writeFile(join(linkedDirectory, 'tectonic.exe'), createPe());
	await symlink(linkedDirectory, join(tectonicRoot, 'windows-x64'), 'junction');
	await assert.rejects(verifyTectonicInstallation(root), /symbolic link is not allowed/);
});

test('packaged resource verifier rejects a junction at the vendor boundary', async (context) => {
	const resourcesRoot = await mkdtemp(join(tmpdir(), 'modutex-tectonic-packaged-link-'));
	const targetRoot = await mkdtemp(join(tmpdir(), 'modutex-tectonic-packaged-target-'));
	context.after(async () => {
		await rm(resourcesRoot, { recursive: true, force: true });
		await rm(targetRoot, { recursive: true, force: true });
	});
	await createRetainedVendorCopy(join(targetRoot, 'vendor'));
	await symlink(join(targetRoot, 'vendor'), join(resourcesRoot, 'vendor'), 'junction');

	await assert.rejects(verifyPackagedTectonicResources(resourcesRoot), /Tectonic vendor directory must be a regular directory/);
});

test('packaged verifier accepts an exact retained tree and rejects extra Tectonic files', async (context) => {
	const resourcesRoot = await mkdtemp(join(tmpdir(), 'modutex-tectonic-packaged-'));
	context.after(() => rm(resourcesRoot, { recursive: true, force: true }));
	const vendorRoot = join(resourcesRoot, 'vendor');
	const { tectonicRoot } = await createRetainedVendorCopy(vendorRoot);

	const report = await verifyPackagedTectonicResources(resourcesRoot);
	assert.equal(report.executable.sha256, TECTONIC_EXECUTABLE_SHA256);
	await writeFile(join(tectonicRoot, 'unexpected.dll'), Buffer.from('unreviewed'));
	await assert.rejects(verifyPackagedTectonicResources(resourcesRoot), /Tectonic retained inventory mismatch/);
});

test('reviewed executable constants are not placeholders', async () => {
	assert.match(TECTONIC_EXECUTABLE_SHA256, /^[0-9a-f]{64}$/);
	assert.notEqual(TECTONIC_EXECUTABLE_SHA256, '0'.repeat(64));
	assert.ok(TECTONIC_EXECUTABLE_SIZE > 50_000_000);
	const notice = await readFile(new URL('../../vendor/notices/TECTONIC-NOTICE.md', import.meta.url));
	const license = await readFile(new URL('../../vendor/notices/TECTONIC-LICENSE.txt', import.meta.url));
	assert.equal(sha256(notice), TECTONIC_NOTICE_SHA256);
	assert.equal(sha256(license), TECTONIC_LICENSE_SHA256);
});

test('staged Tectonic executable is the reviewed raw blob with a path-scoped binary rule', () => {
	const path = 'vendor/tectonic/windows-x64/tectonic.exe';
	const listing = spawnSync('git', ['ls-files', '--stage', '--', path], { encoding: 'utf8' });
	assert.equal(listing.status, 0, listing.stderr);
	assert.match(listing.stdout, /^100644 [0-9a-f]{40} 0\tvendor\/tectonic\/windows-x64\/tectonic\.exe\r?\n$/);

	const staged = spawnSync('git', ['show', `:${path}`], {
		encoding: null,
		maxBuffer: 64 * 1024 * 1024
	});
	assert.equal(staged.status, 0, staged.stderr?.toString());
	assert.equal(staged.stdout.length, TECTONIC_EXECUTABLE_SIZE);
	assert.equal(sha256(staged.stdout), TECTONIC_EXECUTABLE_SHA256);

	const attribute = spawnSync('git', ['check-attr', 'text', '--', path], { encoding: 'utf8' });
	assert.equal(attribute.status, 0, attribute.stderr);
	assert.equal(attribute.stdout.trim(), `${path}: text: unset`);
});
