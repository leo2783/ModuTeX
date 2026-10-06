import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { validateVendorManifest } from './vendor-manifest.mjs';
import { VendorVerificationError, verifyCachedArtifact } from './vendor-artifact.mjs';

export const TECTONIC_VERSION = '0.17.0';
export const TECTONIC_ARCHIVE_SHA256 = 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f';
export const TECTONIC_EXECUTABLE_SHA256 = '99ffcfdbf1ebf8bdda9e791942e3d06aedb12463fddc33f07de6f5211c8bf08d';
export const TECTONIC_EXECUTABLE_SIZE = 51538432;
export const TECTONIC_NOTICE_SHA256 = 'bafde9758c0df7b77ac1c630c1b986d87859d12dc94e9753169594cf2ca05ce2';
export const TECTONIC_LICENSE_SHA256 = '814a258f76e420b25cb3c07172eb2b3956f34cefbf0a650413b78e65c425f306';

const EXPECTED_ARCHIVE = 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip';
const EXPECTED_EXECUTABLE = 'tectonic.exe';
const RETAINED_FILES = ['VERSION', 'windows-x64/tectonic.exe'];
const PACKAGED_NOTICE_FILES = ['TECTONIC-LICENSE.txt', 'TECTONIC-NOTICE.md'];
const MODUTEX_PACKAGED_NOTICE_FILES = ['DRAWIO-LICENSE.txt', 'DRAWIO-NOTICE.md', ...PACKAGED_NOTICE_FILES];
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 16;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const WINDOWS_REPARSE_ATTRIBUTE = 0x0400;
const WINDOWS_DIRECTORY_ATTRIBUTE = 0x0010;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMLINK_TYPE = 0xa000;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = join(repositoryRoot, 'vendor', 'vendor-lock.json');

export class TectonicVendorError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TectonicVendorError';
	}
}

const fail = (message) => {
	throw new TectonicVendorError(message);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) {
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	return value >>> 0;
});

const crc32 = (bytes) => {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
};

const requireRange = (bytes, offset, length, label) => {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
		fail(`invalid ${label}`);
	}
	if (offset + length > bytes.length) fail(`truncated ${label}`);
};

const readUInt16 = (bytes, offset, label) => {
	requireRange(bytes, offset, 2, label);
	return bytes.readUInt16LE(offset);
};

const readUInt32 = (bytes, offset, label) => {
	requireRange(bytes, offset, 4, label);
	return bytes.readUInt32LE(offset);
};

const findEndOfCentralDirectory = (bytes) => {
	const minimumOffset = Math.max(0, bytes.length - (22 + 0xffff));
	for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
		if (readUInt32(bytes, offset, 'ZIP end record') !== EOCD_SIGNATURE) continue;
		const commentLength = readUInt16(bytes, offset + 20, 'ZIP comment length');
		if (offset + 22 + commentLength === bytes.length) return offset;
	}
	fail('ZIP end record is missing or has trailing data');
};

const decodeEntryName = (nameBytes, flags) => {
	if (nameBytes.length === 0 || nameBytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
		fail('unsafe ZIP entry path');
	}
	if ((flags & 0x0800) !== 0) {
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
		} catch {
			fail('unsafe ZIP entry path');
		}
	}
	return nameBytes.toString('ascii');
};

const assertSafeWindowsEntryPath = (name) => {
	if (
		name.length === 0 ||
		name.startsWith('/') ||
		name.startsWith('\\') ||
		/^[A-Za-z]:/.test(name) ||
		name.includes(':') ||
		name.includes('/') ||
		name.includes('\\') ||
		name.endsWith('.') ||
		name.endsWith(' ')
	) {
		fail('unsafe ZIP entry path');
	}
	const stem = name.split('.')[0].toUpperCase();
	if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
		fail('unsafe ZIP entry path');
	}
};

const inspectCentralDirectory = (bytes) => {
	const eocdOffset = findEndOfCentralDirectory(bytes);
	const disk = readUInt16(bytes, eocdOffset + 4, 'ZIP disk number');
	const centralDisk = readUInt16(bytes, eocdOffset + 6, 'ZIP central disk number');
	const diskEntries = readUInt16(bytes, eocdOffset + 8, 'ZIP disk entry count');
	const totalEntries = readUInt16(bytes, eocdOffset + 10, 'ZIP entry count');
	const centralSize = readUInt32(bytes, eocdOffset + 12, 'ZIP central size');
	const centralOffset = readUInt32(bytes, eocdOffset + 16, 'ZIP central offset');
	if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
		fail('multi-disk ZIP archives are not allowed');
	}
	if (totalEntries === 0 || totalEntries === 0xffff || totalEntries > MAX_ENTRIES) {
		fail('unsupported ZIP entry count');
	}
	if (centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 archives are not allowed');
	if (centralOffset + centralSize !== eocdOffset) fail('invalid ZIP central directory bounds');
	requireRange(bytes, centralOffset, centralSize, 'ZIP central directory');

	const entries = [];
	const canonicalNames = new Set();
	let offset = centralOffset;
	for (let index = 0; index < totalEntries; index += 1) {
		if (readUInt32(bytes, offset, 'ZIP central entry') !== CENTRAL_SIGNATURE) {
			fail('invalid ZIP central entry');
		}
		requireRange(bytes, offset, 46, 'ZIP central entry');
		const versionMadeBy = readUInt16(bytes, offset + 4, 'ZIP creator version');
		const flags = readUInt16(bytes, offset + 8, 'ZIP flags');
		const method = readUInt16(bytes, offset + 10, 'ZIP method');
		const checksum = readUInt32(bytes, offset + 16, 'ZIP CRC-32');
		const compressedSize = readUInt32(bytes, offset + 20, 'ZIP compressed size');
		const uncompressedSize = readUInt32(bytes, offset + 24, 'ZIP uncompressed size');
		const nameLength = readUInt16(bytes, offset + 28, 'ZIP name length');
		const extraLength = readUInt16(bytes, offset + 30, 'ZIP extra length');
		const commentLength = readUInt16(bytes, offset + 32, 'ZIP entry comment length');
		const diskStart = readUInt16(bytes, offset + 34, 'ZIP entry disk');
		const externalAttributes = readUInt32(bytes, offset + 38, 'ZIP external attributes');
		const localOffset = readUInt32(bytes, offset + 42, 'ZIP local offset');
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
			fail('ZIP64 entries are not allowed');
		}
		if (diskStart !== 0) fail('multi-disk ZIP entries are not allowed');
		if ((flags & ~(0x0008 | 0x0800)) !== 0) fail('unsupported ZIP entry flags');
		if (method !== 0 && method !== 8) fail('unsupported ZIP compression method');
		if (uncompressedSize > MAX_UNCOMPRESSED_BYTES || compressedSize > MAX_ARCHIVE_BYTES) {
			fail('ZIP entry exceeds the size limit');
		}

		const variableLength = nameLength + extraLength + commentLength;
		requireRange(bytes, offset + 46, variableLength, 'ZIP central entry data');
		const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
		const name = decodeEntryName(nameBytes, flags);
		assertSafeWindowsEntryPath(name);
		const canonicalName = name.toLowerCase();
		if (canonicalNames.has(canonicalName)) fail('duplicate-case ZIP entry');
		canonicalNames.add(canonicalName);

		const creatorSystem = versionMadeBy >>> 8;
		const unixMode = externalAttributes >>> 16;
		if (creatorSystem === 3 && (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
			fail('symbolic-link ZIP entry is not allowed');
		}
		if ((externalAttributes & WINDOWS_REPARSE_ATTRIBUTE) !== 0) {
			fail('Windows reparse ZIP entry is not allowed');
		}
		if ((externalAttributes & WINDOWS_DIRECTORY_ATTRIBUTE) !== 0 || name.endsWith('/')) {
			fail('unreviewed ZIP inventory');
		}

		entries.push({
			name,
			nameBytes: Buffer.from(nameBytes),
			flags,
			method,
			checksum,
			compressedSize,
			uncompressedSize,
			localOffset
		});
		offset += 46 + variableLength;
	}
	if (offset !== centralOffset + centralSize) fail('invalid ZIP central directory size');
	return { entries, centralOffset };
};

const extractEntry = (bytes, entry, centralOffset) => {
	const offset = entry.localOffset;
	if (offset >= centralOffset || readUInt32(bytes, offset, 'ZIP local entry') !== LOCAL_SIGNATURE) {
		fail('invalid ZIP local entry');
	}
	requireRange(bytes, offset, 30, 'ZIP local entry');
	const flags = readUInt16(bytes, offset + 6, 'ZIP local flags');
	const method = readUInt16(bytes, offset + 8, 'ZIP local method');
	const checksum = readUInt32(bytes, offset + 14, 'ZIP local CRC-32');
	const compressedSize = readUInt32(bytes, offset + 18, 'ZIP local compressed size');
	const uncompressedSize = readUInt32(bytes, offset + 22, 'ZIP local uncompressed size');
	const nameLength = readUInt16(bytes, offset + 26, 'ZIP local name length');
	const extraLength = readUInt16(bytes, offset + 28, 'ZIP local extra length');
	if (flags !== entry.flags || method !== entry.method) fail('ZIP local and central metadata disagree');
	requireRange(bytes, offset + 30, nameLength + extraLength, 'ZIP local entry data');
	const localName = bytes.subarray(offset + 30, offset + 30 + nameLength);
	if (!localName.equals(entry.nameBytes)) fail('ZIP local and central entry names disagree');
	if ((flags & 0x0008) === 0) {
		if (checksum !== entry.checksum || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
			fail('ZIP local and central metadata disagree');
		}
	}
	const dataOffset = offset + 30 + nameLength + extraLength;
	requireRange(bytes, dataOffset, entry.compressedSize, 'ZIP entry payload');
	if (dataOffset + entry.compressedSize > centralOffset) fail('ZIP entry overlaps the central directory');
	const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
	let content;
	try {
		content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
	} catch {
		fail('ZIP entry decompression failed');
	}
	if (content.length !== entry.uncompressedSize) fail('ZIP uncompressed size mismatch');
	if (crc32(content) !== entry.checksum) fail('ZIP CRC-32 mismatch');
	return content;
};

export const verifyPeAmd64 = (bytes) => {
	if (!Buffer.isBuffer(bytes) || bytes.length < 0x100) fail('Tectonic executable is not a valid PE file');
	if (bytes.toString('ascii', 0, 2) !== 'MZ') fail('Tectonic executable is not a valid PE file');
	const peOffset = readUInt32(bytes, 0x3c, 'PE header offset');
	if (peOffset < 0x40 || peOffset + 24 > bytes.length) fail('Tectonic executable is not a valid PE file');
	if (bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
		fail('Tectonic executable is not a valid PE file');
	}
	const machine = readUInt16(bytes, peOffset + 4, 'PE machine');
	if (machine !== 0x8664) fail('PE machine is not AMD64');
	const sections = readUInt16(bytes, peOffset + 6, 'PE section count');
	const optionalSize = readUInt16(bytes, peOffset + 20, 'PE optional header size');
	if (sections === 0 || sections > 96 || optionalSize < 2 || peOffset + 24 + optionalSize > bytes.length) {
		fail('Tectonic executable has invalid PE headers');
	}
	if (readUInt16(bytes, peOffset + 24, 'PE optional header') !== 0x020b) {
		fail('Tectonic executable is not PE32+');
	}
	return { machine: 'AMD64', format: 'PE32+' };
};

export const inspectTectonicZipBuffer = (archiveBytes, policy) => {
	if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0 || archiveBytes.length > MAX_ARCHIVE_BYTES) {
		fail('Tectonic archive size is invalid');
	}
	if (
		policy === null ||
		typeof policy !== 'object' ||
		policy.executableName !== EXPECTED_EXECUTABLE ||
		!Number.isSafeInteger(policy.executableSize) ||
		policy.executableSize <= 0 ||
		!/^[0-9a-f]{64}$/.test(policy.executableSha256) ||
		/^0{64}$/.test(policy.executableSha256)
	) {
		fail('Tectonic executable policy is invalid');
	}
	const { entries, centralOffset } = inspectCentralDirectory(archiveBytes);
	if (entries.length !== 1 || entries[0].name !== EXPECTED_EXECUTABLE) {
		fail('unreviewed ZIP inventory');
	}
	const executable = extractEntry(archiveBytes, entries[0], centralOffset);
	if (executable.length !== policy.executableSize) fail('Tectonic executable size mismatch');
	const executableSha256 = sha256(executable);
	if (executableSha256 !== policy.executableSha256) fail('Tectonic executable SHA-256 mismatch');
	const pe = verifyPeAmd64(executable);
	return {
		executable,
		entryCount: entries.length,
		machine: pe.machine,
		format: pe.format,
		sha256: executableSha256,
		bytes: executable.length
	};
};

const assertRegularFile = async (file, label) => {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular file`);
		return info;
	} catch (error) {
		if (error instanceof TectonicVendorError) throw error;
		fail(`${label} is missing or unreadable`);
	}
};

const assertRegularDirectory = async (directory, label) => {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a regular directory`);
		await realpath(directory);
	} catch (error) {
		if (error instanceof TectonicVendorError) throw error;
		fail(`${label} is missing or unreadable`);
	}
};

const collectFiles = async (root) => {
	await assertRegularDirectory(root, 'Tectonic retained root');
	const files = [];
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const target = join(directory, entry.name);
			const info = await lstat(target);
			if (info.isSymbolicLink()) fail('symbolic link is not allowed in retained Tectonic files');
			if (info.isDirectory()) {
				await walk(target);
				continue;
			}
			if (!info.isFile()) fail('special file is not allowed in retained Tectonic files');
			files.push(relative(root, target).split(sep).join('/'));
		}
	};
	await walk(root);
	return files.sort();
};

const readAndHash = async (file, label) => {
	await assertRegularFile(file, label);
	try {
		const bytes = await readFile(file);
		return { bytes, sha256: sha256(bytes) };
	} catch {
		fail(`${label} is missing or unreadable`);
	}
};

const verifyNoticeFiles = async (root) => {
	const noticeRoot = join(root, 'vendor', 'notices');
	await assertRegularDirectory(noticeRoot, 'Tectonic notice directory');
	const notice = await readAndHash(join(noticeRoot, 'TECTONIC-NOTICE.md'), 'Tectonic notice');
	const license = await readAndHash(join(noticeRoot, 'TECTONIC-LICENSE.txt'), 'Tectonic license');
	if (notice.sha256 !== TECTONIC_NOTICE_SHA256) fail('Tectonic notice SHA-256 mismatch');
	if (license.sha256 !== TECTONIC_LICENSE_SHA256) fail('Tectonic license SHA-256 mismatch');
	return { noticeSha256: notice.sha256, licenseSha256: license.sha256 };
};

export const verifyTectonicInstallation = async (root) => {
	const normalizedRoot = root instanceof URL ? fileURLToPath(root) : root;
	await assertRegularDirectory(normalizedRoot, 'Tectonic resource root');
	await assertRegularDirectory(join(normalizedRoot, 'vendor'), 'Tectonic vendor directory');
	const tectonicRoot = join(normalizedRoot, 'vendor', 'tectonic');
	const files = await collectFiles(tectonicRoot);
	if (files.length !== RETAINED_FILES.length || files.some((file, index) => file !== RETAINED_FILES[index])) {
		fail('Tectonic retained inventory mismatch');
	}
	const version = await readAndHash(join(tectonicRoot, 'VERSION'), 'Tectonic VERSION');
	if (!version.bytes.equals(Buffer.from(`${TECTONIC_VERSION}\n`, 'utf8'))) {
		fail('Tectonic retained version mismatch');
	}
	const executable = await readAndHash(join(tectonicRoot, 'windows-x64', EXPECTED_EXECUTABLE), 'Tectonic executable');
	if (executable.bytes.length !== TECTONIC_EXECUTABLE_SIZE) fail('Tectonic executable size mismatch');
	if (executable.sha256 !== TECTONIC_EXECUTABLE_SHA256) {
		fail('Tectonic executable SHA-256 mismatch');
	}
	const pe = verifyPeAmd64(executable.bytes);
	return {
		version: TECTONIC_VERSION,
		files: files.length,
		executable: {
			bytes: executable.bytes.length,
			sha256: executable.sha256,
			machine: pe.machine,
			format: pe.format
		},
		notices: await verifyNoticeFiles(normalizedRoot)
	};
};

const loadReviewedTectonicEntry = async () => {
	let manifest;
	try {
		manifest = validateVendorManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
	} catch (error) {
		if (error instanceof TectonicVendorError) throw error;
		fail('reviewed vendor manifest is invalid');
	}
	const entry = manifest.artifacts['tectonic-windows-x64'];
	if (entry.version !== TECTONIC_VERSION || entry.archive !== EXPECTED_ARCHIVE || entry.sha256 !== TECTONIC_ARCHIVE_SHA256) {
		fail('reviewed Tectonic manifest evidence mismatch');
	}
	return entry;
};

const readVerifiedArchiveOnce = async (archivePath) => {
	const entry = await loadReviewedTectonicEntry();
	if (typeof archivePath !== 'string' || basename(archivePath) !== entry.archive) {
		fail('Tectonic archive filename mismatch');
	}
	let cached;
	try {
		cached = await verifyCachedArtifact('tectonic-windows-x64', entry, dirname(archivePath));
	} catch (error) {
		if (error instanceof VendorVerificationError) fail(error.message);
		fail('Tectonic archive provenance verification failed');
	}
	await assertRegularFile(cached.file, 'Tectonic archive');
	let bytes;
	try {
		bytes = await readFile(cached.file);
	} catch {
		fail('Tectonic archive is missing or unreadable');
	}
	if (sha256(bytes) !== entry.sha256) fail('Tectonic archive SHA-256 mismatch');
	return { entry, bytes };
};

export const installTectonicArchive = async (archivePath) => {
	const { entry, bytes } = await readVerifiedArchiveOnce(archivePath);
	const inspected = inspectTectonicZipBuffer(bytes, {
		executableName: EXPECTED_EXECUTABLE,
		executableSize: TECTONIC_EXECUTABLE_SIZE,
		executableSha256: TECTONIC_EXECUTABLE_SHA256
	});
	const target = join(repositoryRoot, 'vendor', 'tectonic');
	try {
		await lstat(target);
		const report = await verifyTectonicInstallation(repositoryRoot);
		return { status: 'already-verified', archiveSha256: entry.sha256, ...report };
	} catch (error) {
		if (error instanceof TectonicVendorError) throw error;
		if (error?.code !== 'ENOENT') fail('Tectonic retained target inspection failed');
	}

	const vendorRoot = join(repositoryRoot, 'vendor');
	await assertRegularDirectory(vendorRoot, 'vendor root');
	const temporary = await mkdtemp(join(vendorRoot, '.tectonic-install-'));
	try {
		await mkdir(join(temporary, 'windows-x64'));
		await writeFile(join(temporary, 'VERSION'), `${TECTONIC_VERSION}\n`, { flag: 'wx' });
		await writeFile(join(temporary, 'windows-x64', EXPECTED_EXECUTABLE), inspected.executable, {
			flag: 'wx'
		});
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
		if (error instanceof TectonicVendorError) throw error;
		const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
		fail(`Tectonic retained installation failed${code}`);
	}
	const report = await verifyTectonicInstallation(repositoryRoot);
	return { status: 'installed', archiveSha256: entry.sha256, ...report };
};

export const verifyPackagedTectonicResources = async (resourcesRoot, noticeProfile = 'tectonic') => {
	if (noticeProfile !== 'tectonic' && noticeProfile !== 'modutex') fail('unknown packaged notice profile');
	const expectedNotices = noticeProfile === 'modutex' ? MODUTEX_PACKAGED_NOTICE_FILES : PACKAGED_NOTICE_FILES;
	const canonicalResources = resolve(resourcesRoot);
	await assertRegularDirectory(canonicalResources, 'packaged resources root');
	const report = await verifyTectonicInstallation(canonicalResources);
	const packagedNotices = await collectFiles(join(canonicalResources, 'vendor', 'notices'));
	if (packagedNotices.length !== expectedNotices.length || packagedNotices.some((file, index) => file !== expectedNotices[index])) {
		fail('packaged Tectonic notice inventory mismatch');
	}
	return report;
};

const parseCli = (arguments_) => {
	const [command, option, value, ...rest] = arguments_;
	if (command === 'verify-retained' && option === undefined) return { command };
	if (rest.length !== 0 || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
		fail('invalid Tectonic vendor command');
	}
	if (command === 'install' && option === '--archive') return { command, archivePath: value };
	if (command === 'verify-packaged' && option === '--resources-dir') {
		return { command, resourcesRoot: value };
	}
	fail('invalid Tectonic vendor command');
};

const run = async () => {
	const options = parseCli(process.argv.slice(2));
	let report;
	if (options.command === 'install') report = await installTectonicArchive(options.archivePath);
	if (options.command === 'verify-retained') report = await verifyTectonicInstallation(repositoryRoot);
	if (options.command === 'verify-packaged') {
		report = await verifyPackagedTectonicResources(options.resourcesRoot);
	}
	console.log(JSON.stringify(report));
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	try {
		await run();
	} catch (error) {
		const message = error instanceof TectonicVendorError ? error.message : 'unexpected Tectonic vendor verification failure';
		console.error(`Tectonic vendor verification failed: ${message}`);
		process.exitCode = 1;
	}
}
