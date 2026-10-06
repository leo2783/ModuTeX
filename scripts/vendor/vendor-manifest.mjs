// SPDX-License-Identifier: Apache-2.0
// Original ModuTeX tool; licensing scope is recorded in ../../LICENSING.md.

const ARTIFACT_IDS = ['drawio-offline', 'tectonic-windows-x64'];
const MANIFEST_FIELDS = ['artifacts', 'schemaVersion'];
const ARTIFACT_FIELDS = [
	'archive',
	'license',
	'notice',
	'provenance',
	'sha256',
	'url',
	'version'
];
const ARTIFACT_POLICIES = {
	'drawio-offline': {
		version: '31.1.8',
		archive: 'drawio-31.1.8.zip',
		sha256: 'f315069ca6b326083b9f9b8dadfc8dbd29f4c2ef78c8e346c3f0f2e99a0603f7',
		license: 'Apache-2.0',
		url: 'https://github.com/jgraph/drawio/archive/refs/tags/v31.1.8.zip',
		provenance: 'https://github.com/jgraph/drawio/releases/tag/v31.1.8'
	},
	'tectonic-windows-x64': {
		version: '0.17.0',
		archive: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
		sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
		license: 'MIT',
		url: 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
		provenance: 'https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0'
	}
};

const assertRecord = (value, label) => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
};

const rejectUnknownFields = (value, allowed, label) => {
	for (const field of Object.keys(value)) {
		if (!allowed.includes(field)) throw new TypeError(`${label}: unknown field "${field}"`);
	}
};

const parsePinnedGithubUrl = (value, label, provenance = false) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError(`${label}: immutable HTTPS ${label.includes('provenance') ? 'provenance ' : ''}URL required`);
	}

	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		throw new TypeError(`${label}: immutable HTTPS ${label.includes('provenance') ? 'provenance ' : ''}URL required`);
	}

	const mutable = /\/(?:latest(?:[._-][^/]*)?|heads|main|master)(?:\/|$)/i.test(pathname);
	const pinnedPath = provenance
		? /\/releases\/tag\/[^/]+$/.test(pathname)
		: /\/archive\/refs\/tags\/[^/]+\.zip$/.test(pathname) ||
			/\/releases\/download\/[^/]+\/[^/]+$/.test(pathname);
	if (
		url.protocol !== 'https:' ||
		url.hostname !== 'github.com' ||
		url.port !== '' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		mutable ||
		!pinnedPath
	) {
		throw new TypeError(`${label}: immutable HTTPS ${label.includes('provenance') ? 'provenance ' : ''}URL required`);
	}
};

const validateArtifact = (name, entry) => {
	const policy = ARTIFACT_POLICIES[name];
	assertRecord(entry, name);
	rejectUnknownFields(entry, ARTIFACT_FIELDS, name);
	for (const field of ARTIFACT_FIELDS) {
		if (typeof entry[field] !== 'string' || entry[field].length === 0) {
			throw new TypeError(`${name}: ${field} is required`);
		}
	}

	if (!/^\d+\.\d+\.\d+$/.test(entry.version)) {
		throw new TypeError(`${name}: exact semantic version required`);
	}
	if (entry.version !== policy.version) {
		throw new TypeError(`${name}: reviewed evidence mismatch for version`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(entry.archive) || !entry.archive.includes(entry.version)) {
		throw new TypeError(`${name}: versioned safe ZIP filename required`);
	}
	if (entry.archive !== policy.archive) {
		throw new TypeError(`${name}: reviewed evidence mismatch for archive`);
	}
	if (!/^[a-f0-9]{64}$/.test(entry.sha256) || /^0{64}$/.test(entry.sha256)) {
		throw new TypeError(`${name}: lowercase non-placeholder SHA-256 required`);
	}
	if (entry.sha256 !== policy.sha256) {
		throw new TypeError(`${name}: reviewed evidence mismatch for sha256`);
	}
	if (entry.license !== policy.license) {
		throw new TypeError(`${name}: approved SPDX license identifier required`);
	}
	if (!/^vendor\/notices\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.notice)) {
		throw new TypeError(`${name}: repository-relative vendor/notices path required`);
	}

	parsePinnedGithubUrl(entry.url, `${name} url`);
	if (entry.url !== policy.url) {
		throw new TypeError(`${name}: reviewed evidence mismatch for url`);
	}
	parsePinnedGithubUrl(entry.provenance, `${name} provenance`, true);
	if (entry.provenance !== policy.provenance) {
		throw new TypeError(`${name}: reviewed evidence mismatch for provenance`);
	}
};

export const validateVendorManifest = (manifest) => {
	assertRecord(manifest, 'vendor manifest');
	rejectUnknownFields(manifest, MANIFEST_FIELDS, 'vendor manifest');
	if (manifest.schemaVersion !== 1) throw new TypeError('vendor manifest: schemaVersion must be 1');
	assertRecord(manifest.artifacts, 'vendor manifest artifacts');

	const actualIds = Object.keys(manifest.artifacts).sort();
	if (actualIds.length !== ARTIFACT_IDS.length || actualIds.some((id, index) => id !== ARTIFACT_IDS[index])) {
		throw new TypeError(`vendor manifest artifacts must be exactly: ${ARTIFACT_IDS.join(', ')}`);
	}

	const archives = ARTIFACT_IDS.map((name) => manifest.artifacts[name]?.archive);
	if (archives.every((archive) => typeof archive === 'string') && new Set(archives).size !== archives.length) {
		throw new TypeError(`vendor manifest: duplicate archive filename "${archives[0]}"`);
	}
	for (const name of ARTIFACT_IDS) validateArtifact(name, manifest.artifacts[name]);
	return manifest;
};
