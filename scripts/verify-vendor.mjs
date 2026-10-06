import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { lstat, readdir, readFile as readTextFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';

import {
	downloadVerifiedArtifact,
	importVerifiedArchive,
	VendorVerificationError,
	verifyArchiveDirectory,
	verifyCachedArtifact
} from './vendor/vendor-artifact.mjs';
import { validateVendorManifest } from './vendor/vendor-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'vendor', 'vendor-lock.json');

export const DRAWIO_REQUIRED_WEBAPP_FILES = [
	'index.html',
	'js/app.min.js',
	'img/LICENSE',
	'js/libavoid-js/LICENSE',
	'shapes/LICENSE',
	'stencils/LICENSE',
	'templates/LICENSE'
];

export const DRAWIO_FIXTURE_FILES = {
	normal: 'normal.drawio',
	cjk: 'cjk.drawio',
	error: 'error.drawio',
	offline: 'offline.drawio'
};

// SHA-256 over sorted retained paths and raw bytes (path + NUL + uint64 byte length + bytes).
// This locks the installed static webapp to the bytes extracted from the reviewed archive.
export const DRAWIO_RETAINED_FILE_COUNT = 3378;
export const DRAWIO_RETAINED_BYTES = 145548999;
export const DRAWIO_RETAINED_TREE_SHA256 = '0adde8fa8b61f13f9fd903a13bd008221760cad0de78f006a6c6ca24fdc7f3b7';
const DRAWIO_NOTICE_SHA256 = '6a542bcfbf7b726798032fbe453cbebfe53af3802297e7edd6c182f14a851ab7';
const DRAWIO_LICENSE_SHA256 = 'aa96f93cf345d3419677ff9061de26e389ed511502ec2681e9d7e03fa980510d';

const DRAWIO_FORBIDDEN_RETAINED_PATHS = [
	{ pattern: /(?:^|\/)WEB-INF(?:\/|$)/iu, label: 'WEB-INF content' },
	{ pattern: /(?:^|\/)META-INF(?:\/|$)/iu, label: 'META-INF content' },
	{ pattern: /\.jar$/iu, label: 'JAR content' },
	{ pattern: /(?:^|\/)server(?:\/|$)/iu, label: 'server content' },
	{ pattern: /(?:^|\/)[^/]*(?:client_secret|api_key)[^/]*$/iu, label: 'secret/config content' }
];

const DRAWIO_ALLOWED_ROOT_FILES = new Set(['LICENSE', 'VERSION']);

const isRegularFile = async (path) => {
	try {
		const info = await lstat(path);
		return info.isFile() && !info.isSymbolicLink();
	} catch {
		return false;
	}
};

const walkFiles = async (directory, relativePath = '') => {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
		const childPath = resolve(directory, entry.name);
		if (entry.isSymbolicLink()) throw new VendorVerificationError(`drawio: symbolic link is not allowed (${childRelative})`);
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(childPath, childRelative)));
		} else if (entry.isFile()) {
			files.push(childRelative.replaceAll('\\', '/'));
		} else {
			throw new VendorVerificationError(`drawio: unsupported filesystem entry (${childRelative})`);
		}
	}
	return files;
};

const requireRegularFile = async (path, label) => {
	if (!(await isRegularFile(path))) throw new VendorVerificationError(`drawio: missing regular ${label}`);
};

const hashRetainedTree = async (vendorRoot, files) => {
	const hash = createHash('sha256');
	let bytes = 0;
	for (const file of [...files].sort()) {
		const content = await readFile(resolve(vendorRoot, file));
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(content.length));
		hash.update(Buffer.from(file, 'utf8'));
		hash.update(Buffer.from([0]));
		hash.update(length);
		hash.update(content);
		bytes += content.length;
	}
	return { bytes, sha256: hash.digest('hex') };
};

const verifyFixtureInventory = async (repositoryRoot) => {
	const fixtureRoot = resolve(repositoryRoot, 'apps', 'texpile-editor', 'tests', 'fixtures', 'diagram');
	const names = Object.values(DRAWIO_FIXTURE_FILES).sort();
	let entries;
	try {
		entries = await readdir(fixtureRoot, { withFileTypes: true });
	} catch {
		throw new VendorVerificationError('drawio: diagram fixture inventory is missing');
	}
	const actual = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.drawio'))
		.map((entry) => entry.name)
		.sort();
	if (actual.join('\n') !== names.join('\n')) {
		throw new VendorVerificationError('drawio: fixture inventory does not match normal/CJK/error/offline set');
	}
	for (const [category, name] of Object.entries(DRAWIO_FIXTURE_FILES)) {
		const path = resolve(fixtureRoot, name);
		await requireRegularFile(path, `${category} fixture`);
		const bytes = await readTextFile(path, 'utf8');
		if (bytes.trim().length === 0) throw new VendorVerificationError(`drawio: empty ${category} fixture`);
		if (category === 'cjk' && !/[\u3400-\u9fff]/u.test(bytes)) {
			throw new VendorVerificationError('drawio: CJK fixture has no CJK content');
		}
		if (category === 'error' && bytes.includes('</mxfile>')) {
			throw new VendorVerificationError('drawio: error fixture unexpectedly looks complete');
		}
		if (category === 'offline' && /https?:\/\//iu.test(bytes)) {
			throw new VendorVerificationError('drawio: offline fixture contains an external URL');
		}
		if (category !== 'error' && !bytes.includes('<mxfile')) {
			throw new VendorVerificationError(`drawio: ${category} fixture is not an mxfile`);
		}
	}
	return { categories: Object.keys(DRAWIO_FIXTURE_FILES), files: names.length };
};

// Runtime resources omit repository test fixtures, but retain the exact reviewed bytes.
export const verifyDrawioRuntimeResources = async (repositoryRoot, entry) => {
	const vendorRoot = resolve(repositoryRoot, 'vendor', 'drawio');
	for (const directory of [resolve(repositoryRoot, 'vendor'), vendorRoot]) {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new VendorVerificationError('drawio: retained root must be a regular directory');
	}
	const files = await walkFiles(vendorRoot);
	for (const file of files) {
		if (!DRAWIO_ALLOWED_ROOT_FILES.has(file) && !file.startsWith('src/main/webapp/')) {
			throw new VendorVerificationError(`drawio: retained tree escapes static webapp (${file})`);
		}
		const forbidden = DRAWIO_FORBIDDEN_RETAINED_PATHS.find(({ pattern }) => pattern.test(file));
		if (forbidden) {
			throw new VendorVerificationError(`drawio: forbidden ${forbidden.label} in retained tree (${file})`);
		}
	}
	await requireRegularFile(resolve(vendorRoot, 'LICENSE'), 'top-level license');
	await requireRegularFile(resolve(vendorRoot, 'VERSION'), 'version file');
	const version = (await readTextFile(resolve(vendorRoot, 'VERSION'), 'utf8')).trim();
	if (version !== entry.version) throw new VendorVerificationError(`drawio: VERSION mismatch (expected ${entry.version})`);
	for (const relativePath of DRAWIO_REQUIRED_WEBAPP_FILES) {
		if (!files.includes(`src/main/webapp/${relativePath}`)) {
			throw new VendorVerificationError(`drawio: exact webapp/${relativePath} filename required`);
		}
		await requireRegularFile(resolve(vendorRoot, 'src', 'main', 'webapp', relativePath), `webapp/${relativePath}`);
	}
	const retained = await hashRetainedTree(vendorRoot, files);
	if (files.length !== DRAWIO_RETAINED_FILE_COUNT) {
		throw new VendorVerificationError(`drawio: retained inventory count mismatch (expected ${DRAWIO_RETAINED_FILE_COUNT})`);
	}
	if (retained.bytes !== DRAWIO_RETAINED_BYTES) {
		throw new VendorVerificationError(`drawio: retained inventory byte count mismatch (expected ${DRAWIO_RETAINED_BYTES})`);
	}
	if (retained.sha256 !== DRAWIO_RETAINED_TREE_SHA256) {
		throw new VendorVerificationError('drawio: retained static webapp bytes do not match reviewed inventory');
	}
	const noticeDirectory = await lstat(resolve(repositoryRoot, 'vendor', 'notices'));
	if (!noticeDirectory.isDirectory() || noticeDirectory.isSymbolicLink()) {
		throw new VendorVerificationError('drawio: notice root must be a regular directory');
	}
	const notices = {};
	for (const [filename, expected] of [
		['DRAWIO-NOTICE.md', DRAWIO_NOTICE_SHA256],
		['DRAWIO-LICENSE.txt', DRAWIO_LICENSE_SHA256]
	]) {
		const path = resolve(repositoryRoot, 'vendor', 'notices', filename);
		await requireRegularFile(path, filename);
		const sha256 = createHash('sha256')
			.update(await readFile(path))
			.digest('hex');
		if (sha256 !== expected) throw new VendorVerificationError(`drawio: ${filename} SHA-256 mismatch`);
		notices[filename] = sha256;
	}
	return { files: files.length, bytes: retained.bytes, sha256: retained.sha256, version, notices };
};

// Source verification always requires fixtures; no caller-controlled weakening flag.
export const verifyDrawioInstallation = async (repositoryRoot, entry) => {
	const runtime = await verifyDrawioRuntimeResources(repositoryRoot, entry);
	const fixtures = await verifyFixtureInventory(repositoryRoot);
	return { ...runtime, fixtures };
};

export const verifyRetainedVendor = async (repositoryRoot = root) => {
	// Validate the exact reviewed manifest before touching either retained installation.
	const manifest = validateVendorManifest(JSON.parse(await readFile(resolve(repositoryRoot, 'vendor', 'vendor-lock.json'), 'utf8')));
	for (const [artifact, notice] of [
		['drawio-offline', 'DRAWIO-NOTICE.md'],
		['tectonic-windows-x64', 'TECTONIC-NOTICE.md']
	]) {
		if (manifest.artifacts[artifact].notice !== `vendor/notices/${notice}`) {
			throw new VendorVerificationError(`${artifact}: reviewed notice path mismatch`);
		}
	}
	const drawio = await verifyDrawioInstallation(repositoryRoot, manifest.artifacts['drawio-offline']);
	let tectonic;
	try {
		const { verifyTectonicInstallation } = await import('./vendor/tectonic-vendor.mjs');
		tectonic = await verifyTectonicInstallation(repositoryRoot);
	} catch (error) {
		throw new VendorVerificationError(error?.name === 'TectonicVendorError' ? error.message : 'tectonic: retained validator unavailable');
	}
	return Object.entries({ 'drawio-offline': drawio, 'tectonic-windows-x64': tectonic }).map(([artifact, installation]) => ({
		status: 'verified',
		artifact,
		source: 'retained-installation',
		version: manifest.artifacts[artifact].version,
		archiveSha256: manifest.artifacts[artifact].sha256,
		archiveEvidence: 'reviewed-manifest',
		installation
	}));
};

const parseArguments = (arguments_) => {
	const options = { download: false };
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--download') {
			if (options.download) throw new VendorVerificationError('duplicate --download option');
			options.download = true;
			continue;
		}
		if (!['--archive-dir', '--cache-dir', '--artifact'].includes(argument)) {
			throw new VendorVerificationError('unknown command-line option');
		}
		const value = arguments_[index + 1];
		if (!value || value.startsWith('--')) throw new VendorVerificationError(`${argument} requires a value`);
		const key = argument === '--archive-dir' ? 'archiveDirectory' : argument === '--cache-dir' ? 'cacheDirectory' : 'artifact';
		if (options[key]) throw new VendorVerificationError(`duplicate ${argument} option`);
		options[key] = value;
		index += 1;
	}
	if (!options.archiveDirectory && !options.cacheDirectory) {
		throw new VendorVerificationError('at least one verification directory is required');
	}
	if (options.download && !options.cacheDirectory) {
		throw new VendorVerificationError('--download requires --cache-dir');
	}
	if (options.download && options.archiveDirectory) {
		throw new VendorVerificationError('--download cannot be combined with --archive-dir');
	}
	return options;
};

const publicResult = (artifact, entry, result, installation) => ({
	status: 'verified',
	artifact,
	version: entry.version,
	archive: entry.archive,
	sha256: result.sha256,
	source: result.source,
	provenanceSource: result.provenanceSource,
	provenance: entry.provenance,
	...(installation ? { installation } : {})
});

const run = async () => {
	if (process.argv.length === 2) {
		for (const report of await verifyRetainedVendor()) console.log(JSON.stringify(report));
		return;
	}
	const options = parseArguments(process.argv.slice(2));
	const manifest = validateVendorManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
	const artifacts = options.artifact ? [options.artifact] : Object.keys(manifest.artifacts).sort();
	for (const artifact of artifacts) {
		const entry = manifest.artifacts[artifact];
		if (!entry) throw new VendorVerificationError('unknown artifact identifier');
		let result;
		if (options.archiveDirectory && options.cacheDirectory) {
			result = await importVerifiedArchive(artifact, entry, options.archiveDirectory, options.cacheDirectory);
		} else if (options.archiveDirectory) {
			result = await verifyArchiveDirectory(artifact, entry, options.archiveDirectory);
		} else if (options.download) {
			result = await downloadVerifiedArtifact(artifact, entry, options.cacheDirectory);
		} else {
			result = await verifyCachedArtifact(artifact, entry, options.cacheDirectory);
		}
		const installation = artifact === 'drawio-offline' ? await verifyDrawioInstallation(root, entry) : undefined;
		console.log(JSON.stringify(publicResult(artifact, entry, result, installation)));
	}
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	try {
		await run();
	} catch (error) {
		const message = error instanceof VendorVerificationError ? error.message : 'unexpected vendor verification failure';
		console.error(`Vendor verification failed: ${message}`);
		process.exitCode = 1;
	}
}
