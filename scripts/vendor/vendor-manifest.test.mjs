// SPDX-License-Identifier: Apache-2.0
// Original ModuTeX tests; licensing scope is recorded in ../../LICENSING.md.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateVendorManifest } from './vendor-manifest.mjs';

const validManifest = {
	schemaVersion: 1,
	artifacts: {
		'drawio-offline': {
			version: '31.1.8',
			archive: 'drawio-31.1.8.zip',
			url: 'https://github.com/jgraph/drawio/archive/refs/tags/v31.1.8.zip',
			sha256: 'f315069ca6b326083b9f9b8dadfc8dbd29f4c2ef78c8e346c3f0f2e99a0603f7',
			license: 'Apache-2.0',
			notice: 'vendor/notices/DRAWIO-NOTICE.md',
			provenance: 'https://github.com/jgraph/drawio/releases/tag/v31.1.8'
		},
		'tectonic-windows-x64': {
			version: '0.17.0',
			archive: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
			url: 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
			sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
			license: 'MIT',
			notice: 'vendor/notices/TECTONIC-NOTICE.md',
			provenance: 'https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0'
		}
	}
};

const clone = (value) => structuredClone(value);

test('accepts the reviewed Draw.io and Tectonic manifest', () => {
	assert.deepEqual(validateVendorManifest(validManifest), validManifest);
});

test('validates the checked-in manifest', async () => {
	const manifest = JSON.parse(
		await readFile(new URL('../../vendor/vendor-lock.json', import.meta.url), 'utf8')
	);
	assert.deepEqual(manifest, validManifest);
	assert.deepEqual(validateVendorManifest(manifest), manifest);
});

test('rejects every Draw.io reviewed-evidence change explicitly', async (t) => {
	const mutations = {
		version: '31.1.9',
		archive: 'drawio-alternate-31.1.8.zip',
		url: 'https://github.com/jgraph/drawio/archive/refs/tags/v31.1.9.zip',
		provenance: 'https://github.com/jgraph/drawio/releases/tag/v31.1.9',
		sha256: 'a'.repeat(64)
	};
	for (const [field, value] of Object.entries(mutations)) {
		await t.test(field, () => {
			const manifest = clone(validManifest);
			manifest.artifacts['drawio-offline'][field] = value;
			assert.throws(
				() => validateVendorManifest(manifest),
				new RegExp(`drawio-offline: reviewed evidence mismatch for ${field}`)
			);
		});
	}
});

test('rejects every Tectonic reviewed-evidence change explicitly', async (t) => {
	const mutations = {
		version: '0.17.1',
		archive: 'tectonic-alternate-0.17.0-x86_64-pc-windows-msvc.zip',
		url: 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.1/tectonic-0.17.1-x86_64-pc-windows-msvc.zip',
		provenance: 'https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.1',
		sha256: 'b'.repeat(64)
	};
	for (const [field, value] of Object.entries(mutations)) {
		await t.test(field, () => {
			const manifest = clone(validManifest);
			manifest.artifacts['tectonic-windows-x64'][field] = value;
			assert.throws(
				() => validateVendorManifest(manifest),
				new RegExp(`tectonic-windows-x64: reviewed evidence mismatch for ${field}`)
			);
		});
	}
});

test('rejects unknown top-level and artifact fields', () => {
	const topLevel = clone(validManifest);
	topLevel.comment = 'not part of the reviewed schema';
	assert.throws(() => validateVendorManifest(topLevel), /unknown field "comment"/);

	const artifact = clone(validManifest);
	artifact.artifacts['drawio-offline'].checksum = 'sha256';
	assert.throws(() => validateVendorManifest(artifact), /unknown field "checksum"/);
});

test('rejects duplicate archive filenames', () => {
	const manifest = clone(validManifest);
	manifest.artifacts['drawio-offline'].archive = 'vendor-31.1.8-0.17.0.zip';
	manifest.artifacts['tectonic-windows-x64'].archive = 'vendor-31.1.8-0.17.0.zip';
	assert.throws(() => validateVendorManifest(manifest), /duplicate archive filename/);
});

test('rejects mutable and non-HTTPS artifact or provenance URLs', () => {
	for (const candidate of [
		'https://github.com/jgraph/drawio/releases/latest/download/drawio.zip',
		'https://github.com/jgraph/drawio/releases/download/latest-v31.1.8/drawio-31.1.8.zip',
		'https://github.com/jgraph/drawio/archive/refs/heads/main.zip',
		'http://github.com/jgraph/drawio/archive/refs/tags/v31.1.8.zip'
	]) {
		const manifest = clone(validManifest);
		manifest.artifacts['drawio-offline'].url = candidate;
		assert.throws(() => validateVendorManifest(manifest), /immutable HTTPS URL/);
	}

	const manifest = clone(validManifest);
	manifest.artifacts['drawio-offline'].provenance =
		'https://github.com/jgraph/drawio/releases/latest';
	assert.throws(() => validateVendorManifest(manifest), /immutable HTTPS provenance URL/);
});

test('rejects malformed or uppercase SHA-256 values', () => {
	for (const candidate of ['0'.repeat(64), 'a'.repeat(63), 'A'.repeat(64)]) {
		const manifest = clone(validManifest);
		manifest.artifacts['drawio-offline'].sha256 = candidate;
		assert.throws(() => validateVendorManifest(manifest), /lowercase non-placeholder SHA-256/);
	}
});

test('rejects non-SPDX license identifiers', () => {
	for (const candidate of ['Apache 2', 'Not-A-License']) {
		const manifest = clone(validManifest);
		manifest.artifacts['drawio-offline'].license = candidate;
		assert.throws(() => validateVendorManifest(manifest), /approved SPDX license identifier/);
	}
});

test('rejects archive and notice path traversal', () => {
	const archive = clone(validManifest);
	archive.artifacts['drawio-offline'].archive = '../drawio.zip';
	assert.throws(() => validateVendorManifest(archive), /safe ZIP filename/);

	for (const candidate of [
		'../DRAWIO-NOTICE.md',
		'vendor/notices/../secrets.txt',
		'C:\\vendor\\notices\\DRAWIO-NOTICE.md'
	]) {
		const manifest = clone(validManifest);
		manifest.artifacts['drawio-offline'].notice = candidate;
		assert.throws(() => validateVendorManifest(manifest), /vendor\/notices/);
	}
});

test('requires exactly the two approved artifact identifiers', () => {
	const missing = clone(validManifest);
	delete missing.artifacts['drawio-offline'];
	assert.throws(() => validateVendorManifest(missing), /exactly: drawio-offline, tectonic-windows-x64/);

	const extra = clone(validManifest);
	extra.artifacts.other = clone(validManifest.artifacts['drawio-offline']);
	assert.throws(() => validateVendorManifest(extra), /exactly: drawio-offline, tectonic-windows-x64/);
});
