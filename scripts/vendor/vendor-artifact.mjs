import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
	copyFile,
	link,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROVENANCE_FIELDS = [
	'archive',
	'artifact',
	'provenance',
	'schemaVersion',
	'sha256',
	'source',
	'url',
	'verifiedAt',
	'version'
];
const PROVENANCE_SOURCES = new Set(['explicit-archive', 'official-download']);

export class VendorVerificationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'VendorVerificationError';
	}
}

const fail = (message) => {
	throw new VendorVerificationError(message);
};

const sanitizeFsFailure = (artifact, action, error) => {
	if (error instanceof VendorVerificationError) throw error;
	fail(`${artifact}: ${action} failed`);
};

const assertSafeArchiveName = (artifact, archive) => {
	if (
		typeof archive !== 'string' ||
		basename(archive) !== archive ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(archive)
	) {
		fail(`${artifact}: unsafe archive filename`);
	}
};

const inspectDirectory = async (artifact, directory) => {
	try {
		const directoryInfo = await lstat(directory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
			fail(`${artifact}: selected directory must be a regular directory`);
		}
		return {
			canonical: await realpath(directory),
			entries: await readdir(directory)
		};
	} catch (error) {
		sanitizeFsFailure(artifact, 'selected directory inspection', error);
	}
};

const resolveExactFile = async (artifact, directory, filename, kind) => {
	assertSafeArchiveName(artifact, filename.replace(/\.provenance\.json$/, '.zip'));
	const inspected = await inspectDirectory(artifact, directory);
	if (!inspected.entries.includes(filename)) fail(`${artifact}: exact ${kind} filename required`);
	const candidate = resolve(directory, filename);
	try {
		const info = await lstat(candidate);
		if (!info.isFile() || info.isSymbolicLink()) {
			fail(`${artifact}: ${kind} must be a regular file inside the selected directory`);
		}
		const canonical = await realpath(candidate);
		if (dirname(canonical) !== inspected.canonical) {
			fail(`${artifact}: ${kind} must be a regular file inside the selected directory`);
		}
		return candidate;
	} catch (error) {
		sanitizeFsFailure(artifact, `${kind} inspection`, error);
	}
};

export const hashFileSha256 = async (file) => {
	const hash = createHash('sha256');
	await pipeline(createReadStream(file), hash);
	return hash.digest('hex');
};

const verifyHash = async (artifact, entry, file) => {
	let actual;
	try {
		actual = await hashFileSha256(file);
	} catch (error) {
		sanitizeFsFailure(artifact, 'archive hashing', error);
	}
	if (actual !== entry.sha256) fail(`${artifact}: SHA-256 mismatch`);
	return actual;
};

export const verifyArchiveDirectory = async (artifact, entry, directory) => {
	assertSafeArchiveName(artifact, entry.archive);
	const file = await resolveExactFile(artifact, directory, entry.archive, 'archive');
	const sha256 = await verifyHash(artifact, entry, file);
	return { artifact, file, sha256, source: 'explicit-archive' };
};

export const createProvenanceRecord = (
	artifact,
	entry,
	source,
	verifiedAt = new Date().toISOString()
) => ({
	schemaVersion: 1,
	artifact,
	archive: entry.archive,
	version: entry.version,
	url: entry.url,
	sha256: entry.sha256,
	provenance: entry.provenance,
	source,
	verifiedAt
});

const validateProvenanceRecord = (artifact, entry, record) => {
	if (record === null || typeof record !== 'object' || Array.isArray(record)) {
		fail(`${artifact}: cache provenance metadata is invalid`);
	}
	const fields = Object.keys(record).sort();
	if (fields.length !== PROVENANCE_FIELDS.length || fields.some((field, index) => field !== PROVENANCE_FIELDS[index])) {
		fail(`${artifact}: cache provenance metadata is invalid`);
	}
	if (
		record.schemaVersion !== 1 ||
		record.artifact !== artifact ||
		record.archive !== entry.archive ||
		record.version !== entry.version ||
		record.url !== entry.url ||
		record.sha256 !== entry.sha256 ||
		record.provenance !== entry.provenance ||
		!PROVENANCE_SOURCES.has(record.source) ||
		typeof record.verifiedAt !== 'string' ||
		Number.isNaN(Date.parse(record.verifiedAt)) ||
		new Date(record.verifiedAt).toISOString() !== record.verifiedAt
	) {
		fail(`${artifact}: cache provenance metadata does not match the reviewed manifest`);
	}
	return record;
};

const readProvenanceRecord = async (artifact, entry, directory) => {
	const filename = `${entry.archive}.provenance.json`;
	const file = await resolveExactFile(artifact, directory, filename, 'provenance metadata');
	try {
		return validateProvenanceRecord(artifact, entry, JSON.parse(await readFile(file, 'utf8')));
	} catch (error) {
		if (error instanceof SyntaxError) fail(`${artifact}: cache provenance metadata is invalid`);
		sanitizeFsFailure(artifact, 'cache provenance inspection', error);
	}
};

export const verifyCachedArtifact = async (artifact, entry, cacheDirectory) => {
	const provenance = await readProvenanceRecord(artifact, entry, cacheDirectory);
	const verified = await verifyArchiveDirectory(artifact, entry, cacheDirectory);
	return { ...verified, source: 'verified-cache', provenanceSource: provenance.source };
};

const writeProvenanceRecord = async (artifact, entry, cacheDirectory, source) => {
	const filename = `${entry.archive}.provenance.json`;
	const finalPath = join(cacheDirectory, filename);
	const temporary = join(cacheDirectory, `.${filename}.${process.pid}.tmp`);
	try {
		await writeFile(
			temporary,
			`${JSON.stringify(createProvenanceRecord(artifact, entry, source), null, 2)}\n`,
			{ encoding: 'utf8', flag: 'wx' }
		);
		await link(temporary, finalPath);
		await rm(temporary, { force: true });
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		sanitizeFsFailure(artifact, 'cache provenance write', error);
	}
};

const cachePresence = async (artifact, entry, cacheDirectory) => {
	try {
		await mkdir(cacheDirectory, { recursive: true });
		const { entries } = await inspectDirectory(artifact, cacheDirectory);
		return {
			archive: entries.includes(entry.archive),
			provenance: entries.includes(`${entry.archive}.provenance.json`)
		};
	} catch (error) {
		sanitizeFsFailure(artifact, 'cache inspection', error);
	}
};

export const importVerifiedArchive = async (artifact, entry, archiveDirectory, cacheDirectory) => {
	const verified = await verifyArchiveDirectory(artifact, entry, archiveDirectory);
	const presence = await cachePresence(artifact, entry, cacheDirectory);
	if (presence.archive || presence.provenance) {
		if (presence.archive && presence.provenance) return verifyCachedArtifact(artifact, entry, cacheDirectory);
		fail(`${artifact}: partial cache state requires manual removal`);
	}
	const destination = join(cacheDirectory, entry.archive);
	try {
		await copyFile(verified.file, destination, constants.COPYFILE_EXCL);
		await verifyHash(artifact, entry, destination);
		await writeProvenanceRecord(artifact, entry, cacheDirectory, 'explicit-archive');
		return { ...verified, file: destination, source: 'explicit-archive' };
	} catch (error) {
		sanitizeFsFailure(artifact, 'verified archive cache import', error);
	}
};

export const downloadVerifiedArtifact = async (artifact, entry, cacheDirectory) => {
	const presence = await cachePresence(artifact, entry, cacheDirectory);
	if (presence.archive || presence.provenance) {
		if (presence.archive && presence.provenance) return verifyCachedArtifact(artifact, entry, cacheDirectory);
		fail(`${artifact}: partial cache state requires manual removal`);
	}

	const finalPath = join(cacheDirectory, entry.archive);
	const temporary = join(cacheDirectory, `.${entry.archive}.${process.pid}.download`);
	try {
		const response = await fetch(entry.url, { redirect: 'follow' });
		if (!response.ok || response.body === null) fail(`${artifact}: official download failed`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
		await verifyHash(artifact, entry, temporary);
		await link(temporary, finalPath);
		await rm(temporary, { force: true });
		await writeProvenanceRecord(artifact, entry, cacheDirectory, 'official-download');
		return { artifact, file: finalPath, sha256: entry.sha256, source: 'official-download' };
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		if (error instanceof VendorVerificationError) throw error;
		fail(`${artifact}: official download failed`);
	}
};
