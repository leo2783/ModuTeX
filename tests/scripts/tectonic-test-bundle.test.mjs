// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bundleZip, prepareBundle, sha256 } from './prepare-tectonic-test-bundle.mjs';

const data = Buffer.from('original TeX resource');
test('native verifier pins the prepared archive and its resources exclude generated formats', async () => {
	const manifest = JSON.parse(await readFile(new URL('../fixtures/tectonic-texlive2022-article.json', import.meta.url)));
	const verifier = await readFile(new URL('../../apps/desktop-tauri/tests/helpers/tectonic_bundle.rs', import.meta.url), 'utf8');
	assert(verifier.includes(`"${manifest.archive_sha256}"`));
	assert(manifest.files.some((file) => file.name === 'article.cls'));
	assert(manifest.files.some((file) => file.name === 'tectonic-format-latex.tex'));
	assert(!manifest.files.some((file) => /\.fmt$/i.test(file.name)));
});
function fixture() {
	const bundle_digest = 'a'.repeat(64);
	return {
		source_url: 'https://data1b.fullyjustified.net/tlextras-2022.0r0.tar',
		bundle_digest,
		files: [{ name: 'article.cls', offset: 512, length: data.length, sha256: sha256(data) }],
		archive_sha256: sha256(
			bundleZip([
				['SHA256SUM', Buffer.from(bundle_digest)],
				['article.cls', data]
			])
		)
	};
}
function response(bytes = data, range = `bytes 512-${511 + data.length}/2881562112`, status = 206) {
	return new Response(bytes, { status, headers: { 'content-range': range } });
}
test('prepares deterministic bundle from exact verified resource ranges', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-local-bundle-'));
	try {
		const manifest = fixture(),
			output = join(directory, 'bundle.zip');
		let calls = 0;
		await prepareBundle(manifest, output, async (url, options) => {
			calls++;
			assert.equal(url, manifest.source_url);
			assert.equal(options.headers.Range, `bytes=512-${511 + data.length}`);
			assert.equal(options.redirect, 'error');
			return response();
		});
		assert.equal(calls, 1);
		assert.equal(sha256(await readFile(output)), manifest.archive_sha256);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
for (const [name, alter, fetchResource, pattern] of [
	[
		'changed resource',
		() => {},
		async () => {
			const changed = Buffer.from(data);
			changed[0] ^= 1;
			return response(changed);
		},
		/SHA-256 mismatch/
	],
	['server ignoring ranges', () => {}, async () => response(data, '', 200), /unexpected byte range/],
	['incorrect range', () => {}, async () => response(data, 'bytes 0-19/2881562112'), /unexpected byte range/],
	[
		'archive checksum mismatch',
		(m) => {
			m.archive_sha256 = '0'.repeat(64);
		},
		async () => response(),
		/bundle SHA-256 mismatch/
	],
	[
		'traversal',
		(m) => {
			m.files[0].name = '../article.cls';
		},
		async () => response(),
		/Invalid bundle resource/
	],
	[
		'prebuilt format cache',
		(m) => {
			m.files[0].name = 'latex.fmt';
		},
		async () => response(),
		/Invalid bundle resource/
	],
	[
		'case aliases',
		(m) => {
			m.files.push({ ...m.files[0], name: 'ARTICLE.CLS' });
		},
		async () => response(),
		/Invalid bundle resource/
	],
	[
		'oversized range',
		(m) => {
			m.files[0].length = 32 * 1024 * 1024;
		},
		async () => response(),
		/Invalid bundle resource/
	]
])
	test(`rejects ${name} without publishing a bundle`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'modutex-local-bundle-'));
		try {
			const manifest = fixture(),
				output = join(directory, 'bundle.zip');
			alter(manifest);
			await assert.rejects(prepareBundle(manifest, output, fetchResource), pattern);
			await assert.rejects(readFile(output), { code: 'ENOENT' });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
