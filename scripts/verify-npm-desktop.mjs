import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as asar from '@electron/asar';
import { verifyPackagedVendorResources } from './verify-packaged-vendor.mjs';

export const NPM_DESKTOP_BIN = 'modutex';
export const NPM_DESKTOP_INVENTORY = 'npm-desktop-inventory.json';
export const NPM_DESKTOP_INVENTORY_SHA = 'npm-desktop-inventory.sha256';
export const NPM_DESKTOP_PAYLOAD = 'app/win-unpacked';
export const NPM_DESKTOP_STRIPPED_ENV_PATTERN =
	'^(?:npm_|npm_token$|node_auth_token$|node_options$|electron_run_as_node$|electron_start_url$)';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_PAYLOAD_FILES = [
	'ModuTeX.exe',
	'resources/app.asar',
	'resources/app-dist/index.html',
	'resources/lua/walker.lua',
	'resources/lua/page-extract.lua',
	'resources/lua/texd-loop.lua',
	'resources/vendor/drawio/VERSION',
	'resources/vendor/drawio/LICENSE',
	'resources/vendor/drawio/src/main/webapp/index.html',
	'resources/vendor/drawio/src/main/webapp/js/app.min.js',
	'resources/vendor/tectonic/VERSION',
	'resources/vendor/tectonic/windows-x64/tectonic.exe',
	'resources/vendor/notices/DRAWIO-LICENSE.txt',
	'resources/vendor/notices/DRAWIO-NOTICE.md',
	'resources/vendor/notices/TECTONIC-LICENSE.txt',
	'resources/vendor/notices/TECTONIC-NOTICE.md',
	'resources/app.asar.unpacked/node_modules/node-pty/package.json',
	'resources/app.asar.unpacked/node_modules/node-pty/lib/index.js',
	'resources/app.asar.unpacked/node_modules/node-pty/lib/windowsTerminal.js',
	'resources/app.asar.unpacked/node_modules/node-pty/lib/windowsPtyAgent.js',
	'resources/app.asar.unpacked/node_modules/node-pty/lib/windowsConoutConnection.js',
	'resources/app.asar.unpacked/node_modules/node-pty/lib/conpty_console_list_agent.js',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe',
	'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/winpty.dll'
];

const EXPECTED_PACKAGE_FILES = [
	'package.json',
	'README.md',
	'LICENSE',
	'SOURCE-OFFER.md',
	'bin/modutex.cjs',
	'app/',
	NPM_DESKTOP_INVENTORY,
	NPM_DESKTOP_INVENTORY_SHA
];

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const NAME_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export class NpmDesktopVerificationError extends Error {
	constructor(code, message = code) {
		super(message);
		this.name = 'NpmDesktopVerificationError';
		this.code = code;
	}
}

function fail(code, message) {
	throw new NpmDesktopVerificationError(code, message ?? code);
}

function pathKey(value) {
	const normalized = path.resolve(value).replaceAll('\\', '/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isCredentialPath(relative) {
	const segments = relative.split('/');
	return segments.some((segment) =>
		/^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|\.env(?:\..*)?|\.npm|\.aws|\.ssh|\.azure|auth(?:entication)?\.(?:json|ya?ml|toml)|credentials?\.(?:json|ya?ml|toml)|secrets?\.(?:json|ya?ml|toml)|tokens?\.(?:json|ya?ml|toml)|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|.*\.(?:pem|pfx|p12|key))$/i.test(
			segment
		)
	);
}

function isDevelopmentPath(relative) {
	// These are mandatory bytes in the reviewed Draw.io retained tree. The full
	// verifyPackagedVendorResources gate below still verifies its exact SHA/count/bytes.
	const payloadRelative = relative.startsWith(`${NPM_DESKTOP_PAYLOAD}/`) ? relative.slice(NPM_DESKTOP_PAYLOAD.length + 1) : relative;
	if (
		[
			'resources/vendor/drawio/src/main/webapp/service-worker.js.map',
			'resources/vendor/drawio/src/main/webapp/workbox-05b6c01b.js.map'
		].includes(payloadRelative)
	)
		return false;
	const segments = relative.split('/').map((segment) => segment.toLowerCase());
	return (
		segments.some((segment) => ['.git', '.github', '__tests__', 'tests', 'test', 'fixtures', '.cache'].includes(segment)) ||
		/\.(?:map|pdb|iobj|ipdb|exp|lib|tlog|vcxproj(?:\.filters)?|sln|gypi|tsbuildinfo)$/i.test(relative) ||
		/\.(?:test|spec)\.[^.]+$/i.test(relative) ||
		/(?:^|\/)package-lock\.json$/i.test(relative)
	);
}

function assertAllowedNodeModules(relative) {
	const marker = '/node_modules/';
	const normalized = relative.replaceAll('\\', '/').toLowerCase();
	const index = normalized.indexOf(marker);
	if (index < 0) return;
	const allowedRoots = [
		'resources/app.asar.unpacked/node_modules/node-pty',
		'app/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty'
	];
	if (!allowedRoots.some((root) => normalized === root || root.startsWith(`${normalized}/`) || normalized.startsWith(`${root}/`))) {
		fail('UNEXPECTED_NODE_MODULE', 'Only the unpacked node-pty runtime may ship outside app.asar.');
	}
}

function normalizeAsarPath(entryPath) {
	if (typeof entryPath !== 'string') fail('INVALID_APP_ASAR', 'The app archive contains an invalid path entry.');
	const normalized = entryPath.replaceAll('\\', '/').replace(/^\/+/, '');
	if (!normalized || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
		fail('INVALID_APP_ASAR', 'The app archive contains an unsafe path entry.');
	}
	return normalized;
}

function assertAllowedAsarNodeModules(relative) {
	const segments = relative.toLowerCase().split('/');
	const index = segments.indexOf('node_modules');
	if (index < 0) return;
	if (index === 0 && (segments.length === 1 || segments[1] === 'node-pty')) return;
	fail('UNEXPECTED_NODE_MODULE', 'Only the bundled node-pty runtime may appear under app.asar/node_modules.');
}

function readAsarIndex(archivePath) {
	let listedPaths;
	let header;
	try {
		listedPaths = asar.listPackage(archivePath, { isPack: false }).map(normalizeAsarPath);
		header = asar.getRawHeader(archivePath).header;
	} catch {
		fail('INVALID_APP_ASAR', 'The packaged Electron app.asar index is missing or invalid.');
	}
	const listed = new Set(listedPaths);
	if (listed.size !== listedPaths.length) fail('INVALID_APP_ASAR', 'The app archive contains duplicate paths.');
	const metadataByPath = new Map();

	function visit(directory, prefix = '') {
		if (!directory || typeof directory !== 'object' || !directory.files || typeof directory.files !== 'object') {
			fail('INVALID_APP_ASAR', 'The app archive directory index is invalid.');
		}
		for (const [name, metadata] of Object.entries(directory.files)) {
			if (
				!name ||
				name.includes('/') ||
				name.includes('\\') ||
				name === '.' ||
				name === '..' ||
				!metadata ||
				typeof metadata !== 'object'
			) {
				fail('INVALID_APP_ASAR', 'The app archive contains an invalid path entry.');
			}
			const relative = prefix ? `${prefix}/${name}` : name;
			const normalized = normalizeAsarPath(relative);
			if ('link' in metadata) fail('ASAR_LINK', `The app archive contains a symlink entry at ${normalized}.`);
			if (isCredentialPath(normalized)) fail('CREDENTIAL_FILE', `Credential-like file is not allowed: app.asar/${normalized}.`);
			if (isDevelopmentPath(normalized)) fail('DEVELOPMENT_FILE', `Development-only file is not allowed: app.asar/${normalized}.`);
			assertAllowedAsarNodeModules(normalized);
			metadataByPath.set(normalized, metadata);
			if ('files' in metadata) visit(metadata, normalized);
		}
	}

	visit(header);
	if (metadataByPath.size !== listed.size || [...listed].some((relative) => !metadataByPath.has(relative))) {
		fail('INVALID_APP_ASAR', 'The app archive path listing differs from its indexed entries.');
	}
	return metadataByPath;
}

function extractAsarEntry(archivePath, metadataByPath, relative) {
	const metadata = metadataByPath.get(relative);
	if (!metadata || 'files' in metadata || 'link' in metadata || metadata.unpacked) {
		fail('INVALID_APP_ASAR_ENTRY', `Required app archive file is missing, linked, or unpacked: ${relative}.`);
	}
	try {
		const content = asar.extractFile(archivePath, path.join(...relative.split('/')), false);
		if (!Buffer.isBuffer(content) || content.length === 0 || content.length !== metadata.size) {
			fail('INVALID_APP_ASAR_ENTRY', `Required app archive file is empty or inconsistent: ${relative}.`);
		}
		return content;
	} catch (error) {
		if (error instanceof NpmDesktopVerificationError) throw error;
		fail('INVALID_APP_ASAR_ENTRY', `Required app archive file cannot be extracted: ${relative}.`);
	}
}

export function verifyPackagedAppAsar(archivePath, expectedVersion) {
	const absolute = path.resolve(archivePath);
	const metadataByPath = readAsarIndex(absolute);
	const packageBuffer = extractAsarEntry(absolute, metadataByPath, 'package.json');
	let appMetadata;
	try {
		appMetadata = JSON.parse(packageBuffer.toString('utf8'));
	} catch {
		fail('INVALID_APP_METADATA', 'The packaged Electron app metadata is invalid.');
	}
	if (
		appMetadata.name !== 'modutex-desktop' ||
		appMetadata.license !== 'AGPL-3.0-only' ||
		appMetadata.main !== 'electron/dist/main.js' ||
		appMetadata.dependencies?.['node-pty'] !== '1.1.0' ||
		(typeof expectedVersion === 'string' && appMetadata.version !== expectedVersion)
	) {
		fail('INVALID_APP_METADATA', 'The packaged Electron app metadata does not match the ModuTeX Windows desktop contract.');
	}
	for (const relative of [
		'electron/dist/main.js',
		'electron/dist/preload.js',
		'electron/dist/drawio-relay.js',
		'electron/dist/diagram-cpu-worker.js'
	]) {
		extractAsarEntry(absolute, metadataByPath, relative);
	}
	return { entryCount: metadataByPath.size, appVersion: appMetadata.version, main: appMetadata.main };
}

async function assertRegularDirectory(directory, code) {
	let info;
	try {
		info = await lstat(directory);
	} catch {
		fail(code, 'A required directory is missing or unreadable.');
	}
	if (!info.isDirectory() || info.isSymbolicLink()) fail(code, 'A required directory must not be a symlink or reparse point.');
	const canonical = await realpath(directory).catch(() => null);
	if (!canonical || pathKey(canonical) !== pathKey(directory))
		fail(code, 'A directory path must resolve without aliases or reparse points.');
}

async function walkFiles(root, { excluded = new Set(), relativePrefix = '' } = {}) {
	const files = [];
	const rootPath = path.resolve(root);
	await assertRegularDirectory(rootPath, 'INVALID_TREE_ROOT');

	async function visit(directory, relative) {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name);
			const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
			const fullRelative = relativePrefix ? `${relativePrefix}/${relativePath}` : relativePath;
			const info = await lstat(absolute);
			if (info.isSymbolicLink()) fail('REPARSE_POINT', `The payload contains a symlink or reparse point at ${fullRelative}.`);
			const canonical = await realpath(absolute).catch(() => null);
			if (!canonical || pathKey(canonical) !== pathKey(absolute) || !isWithin(rootPath, canonical)) {
				fail('PATH_ESCAPE', `The payload contains a path outside its root at ${fullRelative}.`);
			}
			if (isCredentialPath(fullRelative)) fail('CREDENTIAL_FILE', `Credential-like file is not allowed: ${fullRelative}.`);
			if (isDevelopmentPath(fullRelative)) fail('DEVELOPMENT_FILE', `Development-only file is not allowed: ${fullRelative}.`);
			assertAllowedNodeModules(fullRelative);
			if (info.isDirectory()) {
				await visit(absolute, relativePath);
			} else if (info.isFile()) {
				if (excluded.has(fullRelative)) continue;
				files.push({ absolute, path: fullRelative, size: info.size });
			} else {
				fail('NON_REGULAR_FILE', `The payload contains a non-regular filesystem entry at ${fullRelative}.`);
			}
		}
	}

	await visit(rootPath, '');
	return files;
}

async function assertRequiredFiles(root, relativeFiles, requiredFiles, code) {
	const available = new Set(relativeFiles);
	for (const relative of requiredFiles) {
		if (!available.has(relative)) fail(code, `Required production payload file is missing: ${relative}.`);
		const info = await lstat(path.join(root, ...relative.split('/')));
		if (!info.isFile() || info.size === 0) fail(code, `Required production payload file is empty or non-regular: ${relative}.`);
	}
}

async function assertPeX64(filename, relative) {
	let handle;
	try {
		handle = await open(filename, 'r');
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size < 0x40) fail('INVALID_PE', `Required Windows x64 binary is invalid: ${relative}.`);
		const dos = Buffer.alloc(0x40);
		const readDos = await handle.read(dos, 0, dos.length, 0);
		if (readDos.bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
			fail('INVALID_PE', `Required Windows x64 binary is invalid: ${relative}.`);
		}
		const headerOffset = dos.readUInt32LE(0x3c);
		if (headerOffset < 0x40 || headerOffset > stats.size - 6) fail('INVALID_PE', `Required Windows x64 binary is invalid: ${relative}.`);
		const header = Buffer.alloc(6);
		const readHeader = await handle.read(header, 0, header.length, headerOffset);
		if (readHeader.bytesRead !== header.length || header.toString('binary', 0, 4) !== 'PE\0\0') {
			fail('INVALID_PE', `Required Windows x64 binary is invalid: ${relative}.`);
		}
		if (header.readUInt16LE(4) !== 0x8664) fail('WRONG_ARCHITECTURE', `Required binary is not Windows x64: ${relative}.`);
	} catch (error) {
		if (error instanceof NpmDesktopVerificationError) throw error;
		fail('INVALID_PE', `Required Windows x64 binary is invalid: ${relative}.`);
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function verifyWindowsX64Binaries(payloadRoot) {
	const binaries = [
		'ModuTeX.exe',
		'resources/vendor/tectonic/windows-x64/tectonic.exe',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe',
		'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/winpty.dll'
	];
	for (const relative of binaries) await assertPeX64(path.join(payloadRoot, ...relative.split('/')), relative);
}

export function validateNpmPackageName(name) {
	if (typeof name !== 'string' || name.length < 1 || name.length > 214 || name !== name.toLowerCase()) {
		fail('INVALID_PACKAGE_NAME', 'Supply a valid lowercase npm package name.');
	}
	const segments = name.startsWith('@') ? name.slice(1).split('/') : [name];
	if ((name.startsWith('@') && segments.length !== 2) || (!name.startsWith('@') && segments.length !== 1)) {
		fail('INVALID_PACKAGE_NAME', 'Supply a valid lowercase npm package name.');
	}
	if (segments.some((segment) => !NAME_SEGMENT.test(segment) || segment.length > 100)) {
		fail('INVALID_PACKAGE_NAME', 'Supply a valid lowercase npm package name.');
	}
	if (['node_modules', 'favicon.ico'].includes(segments.at(-1))) fail('INVALID_PACKAGE_NAME', 'This npm package name is reserved.');
	return name;
}

export function validateNpmPackageVersion(version) {
	if (typeof version !== 'string' || version.length > 128 || !SEMVER.test(version)) {
		fail('INVALID_PACKAGE_VERSION', 'Supply an explicit semantic version such as 0.1.0.');
	}
	return version;
}

export function validateSourceCommit(commit) {
	if (typeof commit !== 'string' || !FULL_COMMIT.test(commit)) fail('INVALID_SOURCE_COMMIT', 'Supply the full source commit SHA.');
	return commit.toLowerCase();
}

export function createNpmDesktopPackageMetadata(packageName, version, sourceCommit) {
	return {
		name: validateNpmPackageName(packageName),
		version: validateNpmPackageVersion(version),
		description: 'Launch the ModuTeX Windows desktop application',
		license: 'AGPL-3.0-only',
		repository: { type: 'git', url: 'https://github.com/leo2783/latex.git' },
		os: ['win32'],
		cpu: ['x64'],
		modutexSourceCommit: validateSourceCommit(sourceCommit),
		engines: { node: '>=24.19.0', npm: '>=11.17.0' },
		bin: { [NPM_DESKTOP_BIN]: 'bin/modutex.cjs' },
		files: [...EXPECTED_PACKAGE_FILES]
	};
}

export function createNpmDesktopReadme(packageName, version) {
	const filename = `${validateNpmPackageName(packageName).replace(/^@/, '').replace('/', '-')}-${validateNpmPackageVersion(version)}.tgz`;
	return `# ModuTeX desktop for Windows x64\n\nRequires Node.js 24.19 or newer and npm 11.17 or newer. This package opens the desktop application; it is not a command-line TeX editor.\n\nDownload the fixed tarball and its SHA-256 record, verify the digest, then run from that download directory:\n\n\`\`\`powershell\nnpx --yes --package .\\${filename} -- modutex\n\`\`\`\n\nThis tarball is not evidence of an npm registry publication. After it is available in the npm cache, launching the bundled application does not need a development server or remote diagram assets.\n`;
}

export function createNpmDesktopSourceOffer(sourceCommit) {
	const commit = validateSourceCommit(sourceCommit);
	return `# ModuTeX desktop source\n\nThis package's recorded source revision is available at:\n\nhttps://github.com/leo2783/latex/tree/${commit}\n\nThe source is licensed under AGPL-3.0-only; see LICENSE. The staging verifier checks package contents and checkout identity; it does not attest that the application payload was built from this revision. The release owner must retain a trusted build record binding the production build and payload hashes to the source revision.\n`;
}

export function createNpmDesktopLauncher() {
	return `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function fail() {
\tconsole.error('Unable to launch the packaged ModuTeX Windows desktop application.');
\tprocess.exitCode = 1;
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
\tfail();
} else {
\tconst appRoot = path.resolve(__dirname, '..', 'app', 'win-unpacked');
\tconst executable = path.join(appRoot, 'ModuTeX.exe');
\ttry {
\t\tconst rootStat = fs.lstatSync(appRoot);
\t\tconst executableStat = fs.lstatSync(executable);
\t\tconst canonicalRoot = fs.realpathSync.native(appRoot);
\t\tconst canonicalExecutable = fs.realpathSync.native(executable);
\t\tconst relativeExecutable = path.relative(canonicalRoot, canonicalExecutable);
\t\tif (
\t\t\trootStat.isSymbolicLink() ||
\t\t\t!rootStat.isDirectory() ||
\t\t\texecutableStat.isSymbolicLink() ||
\t\t\t!executableStat.isFile() ||
\t\t\tpath.isAbsolute(relativeExecutable) ||
\t\t\trelativeExecutable.startsWith('..' + path.sep)
\t\t) {
\t\t\tfail();
\t\t} else {
\t\t\tconst env = { ...process.env };
\t\t\tconst removeEnvironmentKey = new RegExp(${JSON.stringify(NPM_DESKTOP_STRIPPED_ENV_PATTERN)}, 'i');
\t\t\tfor (const key of Object.keys(env)) {
\t\t\t\tif (removeEnvironmentKey.test(key)) delete env[key];
\t\t\t}
\t\t\tconst child = spawn(executable, process.argv.slice(2), {
\t\t\t\tcwd: process.cwd(),
\t\t\t\tdetached: true,
\t\t\t\tenv,
\t\t\t\tshell: false,
\t\t\t\tstdio: 'ignore',
\t\t\t\twindowsHide: false
\t\t\t});
\t\t\tchild.once('error', fail);
\t\t\tchild.unref();
\t\t}
\t} catch {
\t\tfail();
\t}
}
`;
}

async function verifyNodePtyVersion(payloadRoot) {
	const packagePath = path.join(payloadRoot, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'package.json');
	let packageJson;
	try {
		packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
	} catch {
		fail('INVALID_NODE_PTY', 'The packaged node-pty manifest is missing or invalid.');
	}
	if (packageJson.version !== '1.1.0') fail('INVALID_NODE_PTY', 'The packaged native terminal runtime must be node-pty 1.1.0.');
}

export async function verifyNpmDesktopPayload(payloadDirectory, { expectedVersion } = {}) {
	const payloadRoot = path.resolve(payloadDirectory);
	if (path.basename(payloadRoot).toLowerCase() !== 'win-unpacked') {
		fail('INVALID_PAYLOAD_ROOT', 'The payload must be the genuine electron-builder win-unpacked directory.');
	}
	await assertRegularDirectory(payloadRoot, 'INVALID_PAYLOAD_ROOT');
	const files = await walkFiles(payloadRoot);
	const relativeFiles = files.map(({ path: relative }) => relative);
	await assertRequiredFiles(payloadRoot, relativeFiles, REQUIRED_PAYLOAD_FILES, 'INCOMPLETE_PRODUCTION_PAYLOAD');
	await verifyWindowsX64Binaries(payloadRoot);
	await verifyNodePtyVersion(payloadRoot);
	const appArchive = verifyPackagedAppAsar(path.join(payloadRoot, 'resources', 'app.asar'), expectedVersion);
	const vendorReport = await verifyPackagedVendorResources(path.join(payloadRoot, 'resources'));
	return { fileCount: files.length, vendor: vendorReport, appArchive };
}

async function hashFile(filename) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest('hex');
}

async function packageFiles(packageRoot) {
	const excluded = new Set([NPM_DESKTOP_INVENTORY, NPM_DESKTOP_INVENTORY_SHA]);
	const files = await walkFiles(packageRoot, { excluded });
	const records = [];
	for (const file of files) {
		records.push({ path: file.path, bytes: file.size, sha256: await hashFile(file.absolute) });
	}
	records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return records;
}

export async function createNpmDesktopInventory(packageRoot, expected) {
	const packageMetadata = await verifyPackageMetadata(packageRoot, expected);
	const files = await packageFiles(packageRoot);
	const bytes = Buffer.from(`${JSON.stringify(expectedInventory(packageMetadata, files), null, 2)}\n`);
	const checksum = `${createHash('sha256').update(bytes).digest('hex')}\n`;
	return { bytes, checksum, fileCount: files.length };
}

function expectedInventory(packageMetadata, files) {
	return {
		schemaVersion: 1,
		package: {
			name: packageMetadata.name,
			version: packageMetadata.version,
			sourceCommit: packageMetadata.modutexSourceCommit
		},
		platform: 'win32',
		arch: 'x64',
		files
	};
}

async function verifyPackageMetadata(packageRoot, expected) {
	if (
		!expected ||
		typeof expected.packageName !== 'string' ||
		typeof expected.version !== 'string' ||
		typeof expected.sourceCommit !== 'string'
	) {
		fail('INVALID_EXPECTED_METADATA', 'Expected package name, version, and source commit are required.');
	}
	let packageMetadata;
	try {
		packageMetadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
	} catch {
		fail('INVALID_NPM_METADATA', 'The staged npm package manifest is missing or invalid.');
	}
	const expectedMetadata = createNpmDesktopPackageMetadata(expected.packageName, expected.version, expected.sourceCommit);
	if (JSON.stringify(packageMetadata) !== JSON.stringify(expectedMetadata)) {
		fail('INVALID_NPM_METADATA', 'The staged npm package manifest differs from the approved minimal launcher package.');
	}
	return expectedMetadata;
}

async function assertPackageLayout(packageRoot) {
	const rootEntries = await readdir(packageRoot, { withFileTypes: true });
	const expectedRootEntries = new Set([
		'LICENSE',
		'README.md',
		'SOURCE-OFFER.md',
		'package.json',
		'bin',
		'app',
		NPM_DESKTOP_INVENTORY,
		NPM_DESKTOP_INVENTORY_SHA
	]);
	if (rootEntries.length !== expectedRootEntries.size || rootEntries.some((entry) => !expectedRootEntries.has(entry.name))) {
		fail('UNEXPECTED_PACKAGE_ENTRY', 'The staged package contains an unexpected top-level entry.');
	}
	for (const entry of rootEntries) {
		const info = await lstat(path.join(packageRoot, entry.name));
		if (info.isSymbolicLink()) fail('REPARSE_POINT', 'The staged package contains a symlink or reparse point.');
		const shouldBeDirectory = entry.name === 'app' || entry.name === 'bin';
		if (shouldBeDirectory ? !info.isDirectory() : !info.isFile()) {
			fail('INVALID_PACKAGE_LAYOUT', 'The staged package has an invalid top-level entry type.');
		}
	}
	const appEntries = await readdir(path.join(packageRoot, 'app'), { withFileTypes: true });
	if (appEntries.length !== 1 || appEntries[0].name !== 'win-unpacked' || !appEntries[0].isDirectory() || appEntries[0].isSymbolicLink()) {
		fail('INVALID_PACKAGE_LAYOUT', 'The package must contain only the win-unpacked application payload under app/.');
	}
	const binEntries = await readdir(path.join(packageRoot, 'bin'), { withFileTypes: true });
	if (binEntries.length !== 1 || binEntries[0].name !== 'modutex.cjs' || !binEntries[0].isFile() || binEntries[0].isSymbolicLink()) {
		fail('INVALID_PACKAGE_LAYOUT', 'The package must contain only its declared launcher under bin/.');
	}
}

function assertInventoryShape(inventory, packageMetadata) {
	if (
		!inventory ||
		inventory.schemaVersion !== 1 ||
		inventory.platform !== 'win32' ||
		inventory.arch !== 'x64' ||
		inventory.package?.name !== packageMetadata.name ||
		inventory.package?.version !== packageMetadata.version ||
		inventory.package?.sourceCommit !== packageMetadata.modutexSourceCommit ||
		!Array.isArray(inventory.files)
	) {
		fail('INVALID_INVENTORY', 'The npm package inventory metadata is invalid.');
	}
	let previous = '';
	for (const item of inventory.files) {
		if (
			!item ||
			typeof item.path !== 'string' ||
			item.path.startsWith('/') ||
			item.path.includes('\\') ||
			item.path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
			!Number.isSafeInteger(item.bytes) ||
			item.bytes < 0 ||
			typeof item.sha256 !== 'string' ||
			!HEX_SHA256.test(item.sha256) ||
			(previous && item.path <= previous)
		) {
			fail('INVALID_INVENTORY', 'The npm package inventory contains an invalid or unsorted entry.');
		}
		previous = item.path;
	}
}

export async function verifyNpmDesktopPackage(packageDirectory, expected) {
	const packageRoot = path.resolve(packageDirectory);
	await assertRegularDirectory(packageRoot, 'INVALID_PACKAGE_ROOT');
	await assertPackageLayout(packageRoot);
	const packageMetadata = await verifyPackageMetadata(packageRoot, expected);
	const license = await readFile(path.join(packageRoot, 'LICENSE')).catch(() => null);
	const sourceLicense = await readFile(path.join(REPO_ROOT, 'LICENSE')).catch(() => null);
	if (!license?.length || !sourceLicense?.length || !license.equals(sourceLicense)) {
		fail('MISSING_LICENSE', 'The staged AGPL license must byte-match the repository LICENSE file.');
	}
	const readme = await readFile(path.join(packageRoot, 'README.md'), 'utf8').catch(() => '');
	if (readme !== createNpmDesktopReadme(packageMetadata.name, packageMetadata.version)) {
		fail('INVALID_README', 'The npm README differs from the explicit Windows x64 launch instructions.');
	}
	const sourceOffer = await readFile(path.join(packageRoot, 'SOURCE-OFFER.md'), 'utf8').catch(() => '');
	if (sourceOffer !== createNpmDesktopSourceOffer(packageMetadata.modutexSourceCommit)) {
		fail('MISSING_SOURCE_OFFER', 'The source offer must point to the exact source commit.');
	}
	const launcher = await readFile(path.join(packageRoot, 'bin', 'modutex.cjs'), 'utf8').catch(() => '');
	if (launcher !== createNpmDesktopLauncher()) {
		fail('INVALID_LAUNCHER', 'The npm bin must be a cwd-independent, argument-safe packaged-app launcher.');
	}
	const payloadRoot = path.join(packageRoot, ...NPM_DESKTOP_PAYLOAD.split('/'));
	const payload = await verifyNpmDesktopPayload(payloadRoot, { expectedVersion: packageMetadata.version });
	let inventoryBytes;
	try {
		inventoryBytes = await readFile(path.join(packageRoot, NPM_DESKTOP_INVENTORY));
	} catch {
		fail('MISSING_INVENTORY', 'The package inventory is required.');
	}
	const inventorySha = createHash('sha256').update(inventoryBytes).digest('hex');
	const expectedShaLine = `${inventorySha}\n`;
	const recordedSha = await readFile(path.join(packageRoot, NPM_DESKTOP_INVENTORY_SHA), 'utf8').catch(() => '');
	if (recordedSha !== expectedShaLine) fail('INVENTORY_CHECKSUM_MISMATCH', 'The package inventory checksum does not match.');
	let inventory;
	try {
		inventory = JSON.parse(inventoryBytes.toString('utf8'));
	} catch {
		fail('INVALID_INVENTORY', 'The package inventory is not valid JSON.');
	}
	assertInventoryShape(inventory, packageMetadata);
	const actualFiles = await packageFiles(packageRoot);
	if (JSON.stringify(actualFiles) !== JSON.stringify(inventory.files)) {
		fail('PACKAGE_INVENTORY_MISMATCH', 'Packaged files differ from the recorded path, size, or SHA-256 inventory.');
	}
	return {
		name: packageMetadata.name,
		version: packageMetadata.version,
		sourceCommit: packageMetadata.modutexSourceCommit,
		fileCount: actualFiles.length,
		inventorySha256: inventorySha,
		payload,
		files: actualFiles
	};
}

export async function verifyNpmDesktopTarball(tarballPath, expectedSha256) {
	if (typeof expectedSha256 !== 'string' || !HEX_SHA256.test(expectedSha256)) {
		fail('INVALID_TARBALL_CHECKSUM', 'Supply the externally recorded 64-character SHA-256 for the tarball.');
	}
	const absolute = path.resolve(tarballPath);
	if (path.extname(absolute).toLowerCase() !== '.tgz') fail('INVALID_TARBALL', 'The package archive must be an npm .tgz tarball.');
	let info;
	try {
		info = await lstat(absolute);
	} catch {
		fail('INVALID_TARBALL', 'The npm tarball is missing or unreadable.');
	}
	if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
		fail('INVALID_TARBALL', 'The npm tarball must be a non-empty regular file.');
	const canonical = await realpath(absolute).catch(() => null);
	if (!canonical || pathKey(canonical) !== pathKey(absolute))
		fail('INVALID_TARBALL', 'The npm tarball path must not contain an alias or reparse point.');
	const actualSha256 = await hashFile(absolute);
	if (actualSha256 !== expectedSha256.toLowerCase())
		fail('TARBALL_CHECKSUM_MISMATCH', 'The npm tarball differs from its separately recorded SHA-256.');
	return { path: absolute, bytes: info.size, sha256: actualSha256 };
}

export function parseVerifyArguments(args) {
	const values = new Map();
	const allowed = new Set(['--package-dir', '--package-name', '--version', '--source-commit', '--tarball', '--sha256']);
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
			fail(
				'INVALID_ARGUMENTS',
				'Usage: node scripts/verify-npm-desktop.mjs (--package-dir <dir> --package-name <name> --version <semver> --source-commit <sha> | --tarball <file.tgz> --sha256 <recorded-sha256>).'
			);
		}
		values.set(flag, value);
	}
	const packageFlags = ['--package-dir', '--package-name', '--version', '--source-commit'];
	const tarballFlags = ['--tarball', '--sha256'];
	const isPackageMode = values.size === packageFlags.length && packageFlags.every((flag) => values.has(flag));
	const isTarballMode = values.size === tarballFlags.length && tarballFlags.every((flag) => values.has(flag));
	if (!isPackageMode && !isTarballMode) {
		fail(
			'INVALID_ARGUMENTS',
			'Usage: node scripts/verify-npm-desktop.mjs (--package-dir <dir> --package-name <name> --version <semver> --source-commit <sha> | --tarball <file.tgz> --sha256 <recorded-sha256>).'
		);
	}
	if (isTarballMode) return { tarball: values.get('--tarball'), sha256: values.get('--sha256') };
	return {
		packageDir: values.get('--package-dir'),
		packageName: values.get('--package-name'),
		version: values.get('--version'),
		sourceCommit: values.get('--source-commit')
	};
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	try {
		const options = parseVerifyArguments(process.argv.slice(2));
		if (options.tarball) {
			const report = await verifyNpmDesktopTarball(options.tarball, options.sha256);
			console.log(`Verified npm tarball sha256 ${report.sha256} (${report.bytes} bytes): ${report.path}`);
		} else {
			const report = await verifyNpmDesktopPackage(options.packageDir, options);
			console.log(`Verified ${report.name}@${report.version}: ${report.fileCount} files; inventory sha256 ${report.inventorySha256}.`);
		}
	} catch (error) {
		console.error(`npm desktop verification failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
