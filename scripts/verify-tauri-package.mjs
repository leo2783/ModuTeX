import { createHash } from 'node:crypto';
import { open, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateVendorManifest } from './vendor/vendor-manifest.mjs';
import { verifyPackagedTectonicResources } from './vendor/tectonic-vendor.mjs';

const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const SOURCE_LOCK_PATH = 'apps/desktop-tauri/Cargo.lock';
const SOURCE_EXE_PATH = 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe';
const SOURCE_LICENSE_PATH = 'apps/desktop-tauri/LICENSE';
const SOURCE_NOTICE_PATH = 'apps/desktop-tauri/NOTICE';
const VENDOR_LOCK_PATH = 'vendor/vendor-lock.json';
const HOST_PACKAGE_NAME = 'modutex-desktop-tauri';
const PACKAGE_FORMAT = 'modutex-tauri-package-closure';
const SBOM_FORMAT = 'modutex-tauri-sbom-v1';
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const FILE_ROLES = new Set([
	'host-executable',
	'vendor-executable',
	'native-library',
	'runtime-file',
	'license',
	'notice',
	'third-party-license',
	'third-party-notice',
	'runtime-inventory',
	'sbom'
]);
const RUNTIME_ROLES = new Set(['host-executable', 'vendor-executable', 'native-library', 'runtime-file']);
const DOCUMENT_ROLES = new Set(['license', 'notice', 'third-party-license', 'third-party-notice']);
const PE_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.ocx', '.node', '.pyd', '.com']);
const NATIVE_LIBRARY_EXTENSIONS = new Set(['.dll', '.sys', '.ocx', '.node', '.pyd']);
const FORBIDDEN_SEGMENTS = new Set([
	'electron',
	'legacy',
	'texpile',
	'texpile-editor',
	'drawio',
	'draw.io',
	'node_modules',
	'.git',
	'.github',
	'.verification-artifacts',
	'orchestration',
	'agents',
	'scripts',
	'test',
	'tests',
	'example',
	'examples',
	'fixture',
	'fixtures',
	'cache',
	'caches',
	'archive',
	'archives',
	'source',
	'src',
	'target',
	'debug',
	'incremental'
]);
const FORBIDDEN_FILENAMES = new Set([
	'cargo.lock',
	'cargo.toml',
	'package.json',
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'vendor-lock.json',
	'source-identity.json',
	'tauri.conf.json',
	'dockerfile',
	'makefile'
]);

export class TauriPackageVerificationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TauriPackageVerificationError';
	}
}

const fail = (message) => {
	throw new TauriPackageVerificationError(message);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function exactRecord(value, fields, label) {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail(`${label}: expected a JSON object`);
	}
	const keys = Object.keys(value);
	if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
		fail(`${label}: expected exactly these fields: ${fields.join(', ')}`);
	}
	return value;
}

function arrayValue(value, label, maximum = 100_000) {
	if (!Array.isArray(value) || value.length > maximum) fail(`${label}: invalid array`);
	return value;
}

function textValue(value, label, maximum = 4096) {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim()) {
		fail(`${label}: invalid text`);
	}
	return value;
}

function hashValue(value, label) {
	if (typeof value !== 'string' || !HASH_PATTERN.test(value) || /^0{64}$/.test(value)) {
		fail(`${label}: expected a non-placeholder lowercase SHA-256`);
	}
	return value;
}

function sizeValue(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) fail(`${label}: expected a positive byte size`);
	return value;
}

function safeRelativePath(value, label) {
	const path = textValue(value, label, 4096);
	if (
		path.startsWith('/') ||
		/[\\:\x00-\x1f\x7f]/.test(path) ||
		path.includes('//')
	) {
		fail(`${label}: expected a safe relative path using forward slashes`);
	}
	for (const part of path.split('/')) {
		if (
			!part ||
			part === '.' ||
			part === '..' ||
			/[. ]$/.test(part) ||
			/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
		) {
			fail(`${label}: unsafe or ambiguous path segment`);
		}
	}
	return path;
}

function pathKey(path) {
	return path.normalize('NFC').toLowerCase();
}

function assertNoLeakPath(path, label) {
	const parts = path.split('/');
	const lowerParts = parts.map((part) => part.toLowerCase());
	if (
		lowerParts.some(
			(part) =>
				FORBIDDEN_SEGMENTS.has(part) ||
				/^(?:electron|texpile|drawio|legacy|orchestration)(?:[._-].*)?$/.test(part)
		)
	) {
		fail(`${label}: forbidden runtime/source artifact path (${path})`);
	}
	const filename = lowerParts.at(-1);
	if (
		FORBIDDEN_FILENAMES.has(filename) ||
		/^(?:readme|contributing|changelog)(?:[._-].*)?$/.test(filename) ||
		/\.(?:map|pdb|ilk|obj|lib|exp|zip|7z|tar|tgz|gz|provenance\.json)$/i.test(filename) ||
		/\.(?:rs|ts|tsx|mts|cts|jsx|c|cc|cpp|h|hpp|py|lua|sh|ps1)$/i.test(filename)
	) {
		fail(`${label}: forbidden runtime/source artifact path (${path})`);
	}
}

function assertNoLeakComponent(value, label) {
	if (/(?:electron|texpile|draw\s*\.?\s*io|legacy|orchestrat(?:ion|or))/i.test(value)) {
		fail(`${label}: forbidden legacy or orchestration component`);
	}
}

function parseJson(bytes, label) {
	try {
		let source = bytes.toString('utf8');
		if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
		return JSON.parse(source);
	} catch {
		fail(`${label}: invalid JSON`);
	}
}

async function readInputFile(path, label) {
	if (typeof path !== 'string' || path.length === 0) fail(`${label}: explicit input path required`);
	const absolute = resolve(path);
	let info;
	try {
		info = await lstat(absolute);
	} catch {
		fail(`${label}: file is unavailable`);
	}
	if (!info.isFile() || info.isSymbolicLink()) fail(`${label}: expected a regular non-linked file`);
	if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_INPUT_BYTES) {
		fail(`${label}: input file size is invalid`);
	}
	let bytes;
	let canonical;
	try {
		[bytes, canonical] = await Promise.all([readFile(absolute), realpath(absolute)]);
	} catch {
		fail(`${label}: file is unavailable`);
	}
	if (bytes.length !== info.size) fail(`${label}: file changed while being read`);
	return { bytes, canonical };
}

async function canonicalDirectory(path, label) {
	if (typeof path !== 'string' || path.length === 0) fail(`${label}: explicit directory path required`);
	const absolute = resolve(path);
	let info;
	try {
		info = await lstat(absolute);
	} catch {
		fail(`${label}: directory is unavailable`);
	}
	if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label}: expected a regular non-linked directory`);
	try {
		return await realpath(absolute);
	} catch {
		fail(`${label}: directory is unavailable`);
	}
}

function isInside(root, candidate) {
	const rel = relative(root, candidate);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readSourceFile(sourceRoot, value, label) {
	const path = safeRelativePath(value, label);
	let current = sourceRoot;
	const parts = path.split('/');
	for (let index = 0; index < parts.length; index += 1) {
		current = join(current, parts[index]);
		let info;
		let canonical;
		try {
			[info, canonical] = await Promise.all([lstat(current), realpath(current)]);
		} catch {
			fail(`${label}: source evidence is unavailable`);
		}
		if (info.isSymbolicLink() || !isInside(sourceRoot, canonical)) {
			fail(`${label}: linked or out-of-root source evidence is not allowed`);
		}
		const final = index === parts.length - 1;
		if ((final && !info.isFile()) || (!final && !info.isDirectory())) {
			fail(`${label}: source evidence has the wrong file/directory type`);
		}
	}
	let bytes;
	try {
		bytes = await readFile(current);
	} catch {
		fail(`${label}: source evidence is unreadable`);
	}
	if (bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) fail(`${label}: source evidence size is invalid`);
	return { bytes, canonical: current };
}

function parseSourceIdentity(value) {
	const input = exactRecord(
		value,
		['sourceGitCommit', 'cargoLockPath', 'cargoLockSha256', 'exePath', 'exeSha256', 'timestamp'],
		'source identity'
	);
	const sourceGitCommit = textValue(input.sourceGitCommit, 'sourceGitCommit', 64);
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceGitCommit)) {
		fail('source identity: invalid source Git commit SHA');
	}
	if (input.cargoLockPath !== SOURCE_LOCK_PATH) fail('source identity: unexpected Cargo.lock path');
	if (input.exePath !== SOURCE_EXE_PATH) fail('source identity: unexpected release executable path');
	const cargoLockSha256 = hashValue(input.cargoLockSha256, 'source identity cargoLockSha256');
	const exeSha256 = hashValue(input.exeSha256, 'source identity exeSha256');
	const timestamp = textValue(input.timestamp, 'source identity timestamp', 128);
	if (!Number.isFinite(Date.parse(timestamp))) fail('source identity: invalid timestamp');
	return { sourceGitCommit, cargoLockSha256, exeSha256 };
}

function parseCargoPackage(text) {
	let inPackage = false;
	let name;
	let version;
	for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (/^\[.*\]$/.test(trimmed)) {
			inPackage = trimmed === '[package]';
			continue;
		}
		if (!inPackage) continue;
		const match = /^(name|version)\s*=\s*"([^"]+)"(?:\s*#.*)?$/.exec(trimmed);
		if (!match) continue;
		if (match[1] === 'name') {
			if (name !== undefined) fail('Cargo.toml: duplicate package name');
			name = match[2];
		} else {
			if (version !== undefined) fail('Cargo.toml: duplicate package version');
			version = match[2];
		}
	}
	if (name !== HOST_PACKAGE_NAME || typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
		fail('Cargo.toml: expected the reviewed Tauri package name and exact semantic version');
	}
	return { name, version };
}

function parsePackageManifest(value) {
	const input = exactRecord(
		value,
		[
			'format',
			'schemaVersion',
			'targetTriple',
			'hostExecutable',
			'runtimeInventory',
			'sbom',
			'files',
			'vendors'
		],
		'package manifest'
	);
	if (input.format !== PACKAGE_FORMAT || input.schemaVersion !== 1) {
		fail('package manifest: unsupported format or schema version');
	}
	if (input.targetTriple !== TARGET_TRIPLE) fail('package manifest: only x86_64-pc-windows-msvc is accepted');
	const hostExecutable = safeRelativePath(input.hostExecutable, 'hostExecutable');
	const runtimeInventory = safeRelativePath(input.runtimeInventory, 'runtimeInventory');
	const sbom = safeRelativePath(input.sbom, 'sbom');
	if (runtimeInventory === sbom) fail('package manifest: runtime inventory and SBOM must be separate files');

	const files = arrayValue(input.files, 'package manifest files');
	if (files.length < 5) fail('package manifest: explicit expected-file inventory is incomplete');
	const fileMap = new Map();
	const foldedPaths = new Set();
	for (const [index, value] of files.entries()) {
		const row = exactRecord(value, ['path', 'size', 'sha256', 'role'], `package manifest files[${index}]`);
		const path = safeRelativePath(row.path, `package manifest files[${index}].path`);
		assertNoLeakPath(path, 'package manifest');
		const key = pathKey(path);
		if (foldedPaths.has(key)) fail(`package manifest: duplicate or case-colliding path (${path})`);
		foldedPaths.add(key);
		const role = textValue(row.role, `package manifest files[${index}].role`, 64);
		if (!FILE_ROLES.has(role)) fail(`package manifest: unknown file role (${role})`);
		fileMap.set(path, {
			path,
			size: sizeValue(row.size, `package manifest ${path} size`),
			sha256: hashValue(row.sha256, `package manifest ${path} sha256`),
			role
		});
	}

	const requireRole = (path, role) => {
		const row = fileMap.get(path);
		if (!row || row.role !== role) fail(`package manifest: ${path} must be listed with role ${role}`);
		return row;
	};
	const host = requireRole(hostExecutable, 'host-executable');
	if (extname(hostExecutable).toLowerCase() !== '.exe') fail('package manifest: host executable must be a PE .exe');
	if ([...fileMap.values()].filter((row) => row.role === 'host-executable').length !== 1) {
		fail('package manifest: exactly one host executable is required');
	}
	requireRole('LICENSE', 'license');
	requireRole('NOTICE', 'notice');
	requireRole(runtimeInventory, 'runtime-inventory');
	requireRole(sbom, 'sbom');

	for (const row of fileMap.values()) {
		const extension = extname(row.path).toLowerCase();
		const executableRole = ['host-executable', 'vendor-executable', 'native-library'].includes(row.role);
		if (PE_EXTENSIONS.has(extension) && !executableRole) {
			fail(`package manifest: executable payload has a non-executable role (${row.path})`);
		}
		if (executableRole && !PE_EXTENSIONS.has(extension)) {
			fail(`package manifest: executable role has a non-PE filename (${row.path})`);
		}
		if (['host-executable', 'vendor-executable'].includes(row.role) && extension !== '.exe') {
			fail(`package manifest: application and engine executables must use .exe (${row.path})`);
		}
		if (row.role === 'native-library' && !NATIVE_LIBRARY_EXTENSIONS.has(extension)) {
			fail(`package manifest: native-library role requires a DLL/library filename (${row.path})`);
		}
	}

	const vendors = arrayValue(input.vendors, 'package manifest vendors', 32);
	return {
		targetTriple: input.targetTriple,
		hostExecutable,
		runtimeInventory,
		sbom,
		files: [...fileMap.values()],
		fileMap,
		vendors
	};
}

function validateVendorDeclarations(manifest, vendorManifest) {
	const declarations = [];
	const seen = new Set();
	const vendorExecutablePaths = new Set();
	for (const [index, value] of manifest.vendors.entries()) {
		const spec = exactRecord(
			value,
			['artifact', 'binaryPath', 'versionPath', 'targetTriple', 'licensePath', 'noticePath'],
			`package manifest vendors[${index}]`
		);
		const artifact = textValue(spec.artifact, `vendors[${index}].artifact`, 128);
		if (seen.has(artifact)) fail(`package manifest: duplicate vendor artifact (${artifact})`);
		seen.add(artifact);
		if (artifact !== 'tectonic-windows-x64') {
			fail(`package manifest: unreviewed or prohibited vendor artifact (${artifact})`);
		}
		const entry = vendorManifest.artifacts[artifact];
		if (!entry) fail(`package manifest: vendor artifact is absent from the reviewed vendor manifest (${artifact})`);
		if (spec.targetTriple !== TARGET_TRIPLE) {
			fail(`package manifest: vendor target triple mismatch (${artifact})`);
		}
		if (
			spec.binaryPath !== 'vendor/tectonic/windows-x64/tectonic.exe' ||
			spec.versionPath !== 'vendor/tectonic/VERSION' ||
			spec.licensePath !== 'vendor/notices/TECTONIC-LICENSE.txt' ||
			spec.noticePath !== entry.notice ||
			spec.noticePath !== 'vendor/notices/TECTONIC-NOTICE.md'
		) {
			fail(`package manifest: Tectonic runtime or notice paths do not match the reviewed package profile`);
		}

		const binary = manifest.fileMap.get(spec.binaryPath);
		const version = manifest.fileMap.get(spec.versionPath);
		const license = manifest.fileMap.get(spec.licensePath);
		const notice = manifest.fileMap.get(spec.noticePath);
		if (!binary || binary.role !== 'vendor-executable' || binary.sha256 !== entry.sha256) {
			fail(`package manifest: Tectonic executable hash/role must match the reviewed vendor manifest`);
		}
		if (!version || version.role !== 'runtime-file') {
			fail('package manifest: Tectonic VERSION file is missing from the runtime inventory');
		}
		if (!license || license.role !== 'third-party-license') {
			fail('package manifest: Tectonic license text is missing');
		}
		if (!notice || notice.role !== 'third-party-notice') {
			fail('package manifest: Tectonic third-party notice is missing');
		}
		vendorExecutablePaths.add(spec.binaryPath);
		declarations.push({ spec, entry });
	}

	const listedVendorExecutables = new Set(
		manifest.files.filter((row) => row.role === 'vendor-executable').map((row) => row.path)
	);
	if (
		listedVendorExecutables.size !== vendorExecutablePaths.size ||
		[...listedVendorExecutables].some((path) => !vendorExecutablePaths.has(path))
	) {
		fail('package manifest: every bundled engine executable must have exactly one reviewed vendor declaration');
	}
	return declarations;
}

async function collectDistributionFiles(root) {
	const files = [];
	const folded = new Set();
	async function walk(directory, prefix = '') {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			fail('distribution: directory is unreadable');
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			safeRelativePath(path, 'distribution path');
			assertNoLeakPath(path, 'distribution');
			const key = pathKey(path);
			if (folded.has(key)) fail(`distribution: duplicate or case-colliding path (${path})`);
			folded.add(key);
			const candidate = join(directory, entry.name);
			let info;
			let canonical;
			try {
				[info, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
			} catch {
				fail(`distribution: path is unavailable (${path})`);
			}
			if (entry.isSymbolicLink() || info.isSymbolicLink()) {
				fail(`distribution: symbolic link or reparse point is not allowed (${path})`);
			}
			if (!isInside(root, canonical)) {
				fail(`distribution: reparse traversal escapes the distribution root (${path})`);
			}
			if (info.isDirectory()) {
				await walk(candidate, path);
			} else if (info.isFile()) {
				files.push(path);
			} else {
				fail(`distribution: unsupported filesystem entry (${path})`);
			}
		}
	}
	await walk(root);
	return files;
}

async function readAt(handle, position, length) {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) fail('package file: truncated while being inspected');
		offset += bytesRead;
	}
	return buffer;
}

async function assertAmd64Pe(handle, size, path) {
	if (size < 64) fail(`package executable is not a valid PE file (${path})`);
	const dos = await readAt(handle, 0, 64);
	if (dos[0] !== 0x4d || dos[1] !== 0x5a) fail(`package executable is missing the MZ header (${path})`);
	const peOffset = dos.readUInt32LE(0x3c);
	if (peOffset < 64 || peOffset + 6 > size) fail(`package executable has an invalid PE header offset (${path})`);
	const header = await readAt(handle, peOffset, 6);
	if (header[0] !== 0x50 || header[1] !== 0x45 || header[2] !== 0 || header[3] !== 0) {
		fail(`package executable is missing the PE signature (${path})`);
	}
	const machine = header.readUInt16LE(4);
	if (machine !== 0x8664) {
		fail(`package executable is not AMD64 PE (${path}, machine 0x${machine.toString(16)})`);
	}
}

async function inspectPackageFile(root, row, capture) {
	const fullPath = join(root, ...row.path.split('/'));
	let before;
	let canonicalBefore;
	try {
		[before, canonicalBefore] = await Promise.all([lstat(fullPath), realpath(fullPath)]);
	} catch {
		fail(`package file is unavailable (${row.path})`);
	}
	if (!before.isFile() || before.isSymbolicLink() || !isInside(root, canonicalBefore)) {
		fail(`package file is not a regular in-root file (${row.path})`);
	}
	if (!Number.isSafeInteger(before.size) || before.size <= 0) fail(`package file size is invalid (${row.path})`);
	if (capture && before.size > MAX_CAPTURE_BYTES) fail(`package metadata file is too large (${row.path})`);

	const extension = extname(row.path).toLowerCase();
	const executableRole = ['host-executable', 'vendor-executable', 'native-library'].includes(row.role);
	if (executableRole && !PE_EXTENSIONS.has(extension)) {
		fail(`package executable has an unsupported extension (${row.path})`);
	}
	if (PE_EXTENSIONS.has(extension) && !executableRole) {
		fail(`unexpected executable payload role (${row.path})`);
	}
	if (row.role === 'native-library' && !NATIVE_LIBRARY_EXTENSIONS.has(extension)) {
		fail(`native library has an invalid extension (${row.path})`);
	}

	let handle;
	try {
		handle = await open(fullPath, 'r');
	} catch {
		fail(`package file cannot be opened (${row.path})`);
	}
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size !== before.size || !Number.isSafeInteger(opened.size)) {
			fail(`package file changed while being opened (${row.path})`);
		}
		const prefix = await readAt(handle, 0, Math.min(64, opened.size));
		const startsWithMz = prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a;
		if (executableRole && !startsWithMz) fail(`package executable is missing the MZ header (${row.path})`);
		if (!executableRole && startsWithMz) fail(`unclassified PE executable payload (${row.path})`);
		// The pinned Tectonic verifier owns the engine PE/hash/version checks.
		if (executableRole && row.role !== 'vendor-executable') {
			await assertAmd64Pe(handle, opened.size, row.path);
		}

		const digest = createHash('sha256');
		const chunks = capture ? [] : null;
		const chunk = Buffer.alloc(64 * 1024);
		let position = 0;
		while (position < opened.size) {
			const requested = Math.min(chunk.length, opened.size - position);
			const { bytesRead } = await handle.read(chunk, 0, requested, position);
			if (bytesRead === 0) fail(`package file changed while being hashed (${row.path})`);
			const view = chunk.subarray(0, bytesRead);
			digest.update(view);
			if (chunks) chunks.push(Buffer.from(view));
			position += bytesRead;
		}
		const after = await handle.stat();
		if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
			fail(`package file changed while being inspected (${row.path})`);
		}
		const actualBytes = chunks ? Buffer.concat(chunks) : null;
		let afterPath;
		let afterRealPath;
		try {
			[afterPath, afterRealPath] = await Promise.all([lstat(fullPath), realpath(fullPath)]);
		} catch {
			fail(`package file changed while being inspected (${row.path})`);
		}
		if (
			afterPath.isSymbolicLink() ||
			!afterPath.isFile() ||
			!isInside(root, afterRealPath) ||
			!isInside(root, canonicalBefore)
		) {
			fail(`package file became linked or escaped the distribution root (${row.path})`);
		}
		return {
			size: opened.size,
			sha256: digest.digest('hex'),
			bytes: actualBytes
		};
	} finally {
		await handle.close().catch(() => {});
	}
}

function assertSamePaths(actual, expected, label) {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	for (const path of actualSet) {
		if (!expectedSet.has(path)) fail(`${label}: unexpected file (${path})`);
	}
	for (const path of expectedSet) {
		if (!actualSet.has(path)) fail(`${label}: missing file (${path})`);
	}
	if (actualSet.size !== expectedSet.size) fail(`${label}: duplicate file entry`);
}

function parseRuntimeInventory(value, manifest) {
	const input = exactRecord(value, ['schemaVersion', 'targetTriple', 'files'], 'runtime inventory');
	if (input.schemaVersion !== 1 || input.targetTriple !== TARGET_TRIPLE) {
		fail('runtime inventory: schema or target triple mismatch');
	}
	const rows = arrayValue(input.files, 'runtime inventory files');
	const inventory = new Map();
	for (const [index, value] of rows.entries()) {
		const row = exactRecord(value, ['path', 'size', 'sha256'], `runtime inventory files[${index}]`);
		const path = safeRelativePath(row.path, `runtime inventory files[${index}].path`);
		assertNoLeakPath(path, 'runtime inventory');
		const key = pathKey(path);
		if ([...inventory.keys()].some((candidate) => pathKey(candidate) === key)) {
			fail(`runtime inventory: duplicate or case-colliding path (${path})`);
		}
		inventory.set(path, {
			path,
			size: sizeValue(row.size, `runtime inventory ${path} size`),
			sha256: hashValue(row.sha256, `runtime inventory ${path} sha256`)
		});
	}
	const expectedRows = manifest.files.filter((row) => RUNTIME_ROLES.has(row.role));
	assertSamePaths([...inventory.keys()], expectedRows.map((row) => row.path), 'runtime inventory');
	for (const row of expectedRows) {
		const listed = inventory.get(row.path);
		if (listed.size !== row.size || listed.sha256 !== row.sha256) {
			fail(`runtime inventory: file metadata does not match the package manifest (${row.path})`);
		}
	}
	return inventory;
}

function componentPathArray(value, label, allowEmpty = false) {
	const values = arrayValue(value, label, 100_000);
	if (!allowEmpty && values.length === 0) fail(`${label}: at least one path is required`);
	const paths = values.map((item) => safeRelativePath(item, label));
	const keys = new Set(paths.map(pathKey));
	if (keys.size !== paths.length) fail(`${label}: duplicate or case-colliding path`);
	return paths;
}

function parseSbom(value, manifest, sourceIdentity, cargoPackage, vendorDeclarations) {
	const input = exactRecord(
		value,
		['format', 'schemaVersion', 'targetTriple', 'source', 'components'],
		'SBOM'
	);
	if (input.format !== SBOM_FORMAT || input.schemaVersion !== 1 || input.targetTriple !== TARGET_TRIPLE) {
		fail('SBOM: unsupported format, schema version, or target triple');
	}
	const source = exactRecord(input.source, ['sourceGitCommit', 'cargoLockSha256'], 'SBOM source');
	if (
		source.sourceGitCommit !== sourceIdentity.sourceGitCommit ||
		source.cargoLockSha256 !== sourceIdentity.cargoLockSha256
	) {
		fail('SBOM: source commit or Cargo.lock hash does not match the build evidence');
	}

	const values = arrayValue(input.components, 'SBOM components', 20_000);
	if (values.length === 0) fail('SBOM: explicit runtime components are required');
	const components = new Map();
	const documentReferences = new Set();
	const noticeReferences = new Set();
	const runtimeReferences = new Set();
	for (const [index, value] of values.entries()) {
		const component = exactRecord(
			value,
			['id', 'name', 'version', 'license', 'files', 'licenseFiles', 'noticeFiles'],
			`SBOM components[${index}]`
		);
		const id = textValue(component.id, `SBOM components[${index}].id`, 256);
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) fail(`SBOM: invalid component identifier (${id})`);
		if (components.has(id)) fail(`SBOM: duplicate component identifier (${id})`);
		const name = textValue(component.name, `SBOM component ${id} name`, 512);
		assertNoLeakComponent(`${id} ${name}`, 'SBOM');
		const version = textValue(component.version, `SBOM component ${id} version`, 128);
		if (/^(?:unknown|noassertion|none|tbd|n\/a)$/i.test(version)) {
			fail(`SBOM: component version is not explicit (${id})`);
		}
		const license = textValue(component.license, `SBOM component ${id} license`, 256);
		if (
			/^(?:unknown|noassertion|none|unlicensed|tbd|n\/a)$/i.test(license) ||
			!/^[A-Za-z0-9][A-Za-z0-9.+(): -]*$/.test(license)
		) {
			fail(`SBOM: component license is not explicit (${id})`);
		}
		const files = componentPathArray(component.files, `SBOM component ${id} files`);
		const licenseFiles = componentPathArray(component.licenseFiles, `SBOM component ${id} licenseFiles`);
		const noticeFiles = componentPathArray(
			component.noticeFiles,
			`SBOM component ${id} noticeFiles`,
			true
		);
		for (const path of files) {
			assertNoLeakPath(path, 'SBOM');
			const row = manifest.fileMap.get(path);
			if (!row || !RUNTIME_ROLES.has(row.role)) {
				fail(`SBOM: component references a file outside the runtime inventory (${path})`);
			}
			runtimeReferences.add(path);
		}
		const hostComponent = id === HOST_PACKAGE_NAME;
		for (const path of licenseFiles) {
			const row = manifest.fileMap.get(path);
			const expectedRole = hostComponent ? 'license' : 'third-party-license';
			if (!row || row.role !== expectedRole) {
				fail(`SBOM: license document has the wrong package role (${path})`);
			}
			documentReferences.add(path);
		}
		for (const path of noticeFiles) {
			const row = manifest.fileMap.get(path);
			const expectedRole = hostComponent ? 'notice' : 'third-party-notice';
			if (!row || row.role !== expectedRole) {
				fail(`SBOM: notice document has the wrong package role (${path})`);
			}
			noticeReferences.add(path);
		}
		components.set(id, { id, name, version, license, files, licenseFiles, noticeFiles });
	}

	const host = components.get(HOST_PACKAGE_NAME);
	if (!host) fail('SBOM: Tauri host component is missing');
	if (
		host.name !== cargoPackage.name ||
		host.version !== cargoPackage.version ||
		host.license !== 'Apache-2.0' ||
		host.files.length !== 1 ||
		host.files[0] !== manifest.hostExecutable ||
		host.licenseFiles.length !== 1 ||
		host.licenseFiles[0] !== 'LICENSE' ||
		host.noticeFiles.length !== 1 ||
		host.noticeFiles[0] !== 'NOTICE'
	) {
		fail('SBOM: Tauri host identity, Apache license evidence, or host file mapping mismatch');
	}

	for (const declaration of vendorDeclarations) {
		const { spec, entry } = declaration;
		const component = components.get(spec.artifact);
		if (!component) fail(`SBOM: bundled vendor component is missing (${spec.artifact})`);
		if (component.version !== entry.version || component.license !== entry.license) {
			fail(`SBOM: vendor version/license differs from the reviewed vendor manifest (${spec.artifact})`);
		}
		if (
			component.files.length !== 2 ||
			!component.files.includes(spec.binaryPath) ||
			!component.files.includes(spec.versionPath) ||
			component.licenseFiles.length !== 1 ||
			component.licenseFiles[0] !== spec.licensePath ||
			component.noticeFiles.length !== 1 ||
			component.noticeFiles[0] !== spec.noticePath
		) {
			fail(`SBOM: vendor payload, license, or notice mapping mismatch (${spec.artifact})`);
		}
	}

	const expectedRuntime = manifest.files
		.filter((row) => RUNTIME_ROLES.has(row.role))
		.map((row) => row.path);
	assertSamePaths([...runtimeReferences], expectedRuntime, 'SBOM runtime component inventory');
	const expectedLicenses = manifest.files
		.filter((row) => DOCUMENT_ROLES.has(row.role) && (row.role === 'license' || row.role === 'third-party-license'))
		.map((row) => row.path);
	const expectedNotices = manifest.files
		.filter((row) => row.role === 'notice' || row.role === 'third-party-notice')
		.map((row) => row.path);
	assertSamePaths([...documentReferences], expectedLicenses, 'SBOM license document inventory');
	assertSamePaths([...noticeReferences], expectedNotices, 'SBOM notice document inventory');
	return components;
}

function samePath(left, right) {
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function verifyTauriPackage({
	distributionRoot,
	manifestPath,
	sourceRoot,
	sourceIdentityPath,
	vendorManifestPath
}) {
	const distribution = await canonicalDirectory(distributionRoot, 'distribution');
	const source = await canonicalDirectory(sourceRoot, 'source root');
	const [manifestInput, identityInput, vendorInput] = await Promise.all([
		readInputFile(manifestPath, 'package manifest'),
		readInputFile(sourceIdentityPath, 'source identity'),
		readInputFile(vendorManifestPath, 'vendor manifest')
	]);
	for (const [label, input] of [
		['package manifest', manifestInput],
		['source identity', identityInput],
		['vendor manifest', vendorInput]
	]) {
		if (isInside(distribution, input.canonical)) {
			fail(`${label}: evidence must be supplied outside the extracted distribution`);
		}
	}

	const sourceVendor = await readSourceFile(source, VENDOR_LOCK_PATH, 'vendor manifest');
	if (!samePath(sourceVendor.canonical, vendorInput.canonical)) {
		fail(`vendor manifest: must be the source tree's ${VENDOR_LOCK_PATH}`);
	}
	let vendorManifest;
	try {
		vendorManifest = validateVendorManifest(parseJson(vendorInput.bytes, 'vendor manifest'));
	} catch (error) {
		if (error instanceof TauriPackageVerificationError) throw error;
		fail(`vendor manifest validation failed: ${error instanceof Error ? error.message : 'invalid manifest'}`);
	}

	const identity = parseSourceIdentity(parseJson(identityInput.bytes, 'source identity'));
	const lock = await readSourceFile(source, SOURCE_LOCK_PATH, 'Cargo.lock');
	if (sha256(lock.bytes) !== identity.cargoLockSha256) {
		fail('source identity: Cargo.lock SHA-256 does not match the source tree');
	}
	const cargoToml = await readSourceFile(source, 'apps/desktop-tauri/Cargo.toml', 'Cargo.toml');
	const cargoPackage = parseCargoPackage(cargoToml.bytes.toString('utf8'));

	const manifest = parsePackageManifest(parseJson(manifestInput.bytes, 'package manifest'));
	const hostRow = manifest.fileMap.get(manifest.hostExecutable);
	if (hostRow.sha256 !== identity.exeSha256) {
		fail('package manifest: host executable SHA-256 does not match source identity');
	}
	const vendorDeclarations = validateVendorDeclarations(manifest, vendorManifest);

	const actualFiles = await collectDistributionFiles(distribution);
	assertSamePaths(
		actualFiles,
		manifest.files.map((row) => row.path),
		'distribution file inventory'
	);

	const versionPaths = new Set(vendorDeclarations.map(({ spec }) => spec.versionPath));
	const inspection = new Map();
	const deferredMismatches = [];
	for (const row of manifest.files) {
		const capture =
			row.path === manifest.runtimeInventory ||
			row.path === manifest.sbom ||
			DOCUMENT_ROLES.has(row.role) ||
			versionPaths.has(row.path);
		const actual = await inspectPackageFile(distribution, row, capture);
		inspection.set(row.path, actual);
		if (actual.size !== row.size || actual.sha256 !== row.sha256) {
			const message = actual.size !== row.size ? `size mismatch for ${row.path}` : `SHA-256 mismatch for ${row.path}`;
			if (capture) fail(`package file ${message}`);
			deferredMismatches.push(message);
		}
	}
	const hostActual = inspection.get(manifest.hostExecutable);
	if (hostActual.sha256 !== identity.exeSha256) {
		fail('package host executable does not match the CI source-identity executable hash');
	}

	const sourceLicense = await readSourceFile(source, SOURCE_LICENSE_PATH, 'host LICENSE');
	const sourceNotice = await readSourceFile(source, SOURCE_NOTICE_PATH, 'host NOTICE');
	if (!inspection.get('LICENSE').bytes.equals(sourceLicense.bytes)) {
		fail(`package LICENSE bytes do not match ${SOURCE_LICENSE_PATH}`);
	}
	if (!inspection.get('NOTICE').bytes.equals(sourceNotice.bytes)) {
		fail(`package NOTICE bytes do not match ${SOURCE_NOTICE_PATH}`);
	}

	for (const { spec, entry } of vendorDeclarations) {
		const versionBytes = inspection.get(spec.versionPath).bytes;
		if (versionBytes.toString('utf8').trim() !== entry.version) {
			fail(`package Tectonic VERSION does not match the reviewed vendor manifest`);
		}
	}

	const runtime = parseRuntimeInventory(
		parseJson(inspection.get(manifest.runtimeInventory).bytes, 'runtime inventory'),
		manifest
	);
	const components = parseSbom(
		parseJson(inspection.get(manifest.sbom).bytes, 'SBOM'),
		manifest,
		identity,
		cargoPackage,
		vendorDeclarations
	);

	if (vendorDeclarations.length > 0) {
		try {
			// Reuse the reviewed Tectonic package verifier; do not invoke Electron after-pack.
			await verifyPackagedTectonicResources(distribution, 'modutex');
		} catch (error) {
			if (error instanceof TauriPackageVerificationError) throw error;
			fail(`packaged Tectonic resources failed verification: ${error instanceof Error ? error.message : 'invalid resources'}`);
		}
	}
	if (deferredMismatches.length > 0) fail(`package file ${deferredMismatches[0]}`);

	return {
		status: 'verified',
		scope: 'extracted-package-closure',
		targetTriple: TARGET_TRIPLE,
		sourceGitCommit: identity.sourceGitCommit,
		cargoLockSha256: identity.cargoLockSha256,
		hostExecutable: { path: manifest.hostExecutable, sha256: hostActual.sha256, machine: 'AMD64' },
		files: manifest.files.length,
		runtimeFiles: runtime.size,
		sbomComponents: components.size,
		vendors: vendorDeclarations.map(({ spec, entry }) => ({
			artifact: spec.artifact,
			version: entry.version,
			sha256: entry.sha256,
			targetTriple: spec.targetTriple
		}))
	};
}

function parseArguments(arguments_) {
	const keys = new Set(['--distribution', '--manifest', '--source-root', '--source-identity', '--vendor-manifest']);
	const options = {};
	for (let index = 0; index < arguments_.length; index += 1) {
		const key = arguments_[index];
		if (!keys.has(key)) fail('unknown command-line option');
		const value = arguments_[index + 1];
		if (!value || value.startsWith('--')) fail(`${key} requires a value`);
		if (Object.hasOwn(options, key)) fail(`duplicate ${key} option`);
		options[key] = value;
		index += 1;
	}
	for (const key of keys) {
		if (!Object.hasOwn(options, key)) fail(`${key} is required; no package or provenance inputs are inferred`);
	}
	return {
		distributionRoot: options['--distribution'],
		manifestPath: options['--manifest'],
		sourceRoot: options['--source-root'],
		sourceIdentityPath: options['--source-identity'],
		vendorManifestPath: options['--vendor-manifest']
	};
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	try {
		const report = await verifyTauriPackage(parseArguments(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} catch (error) {
		const message =
			error instanceof TauriPackageVerificationError
				? error.message
				: 'unexpected Tauri package verification failure';
		console.error(`Tauri package verification failed: ${message}`);
		process.exitCode = 1;
	}
}
