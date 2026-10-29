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

for (const failure of ['connection reset', 'body reset', 'timeout', 'HTTP 503']) {
	test(`retries ${failure} and publishes only the exact pinned archive`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'modutex-local-bundle-'));
		try {
			const manifest = fixture(),
				output = join(directory, 'bundle.zip');
			let calls = 0;
			await prepareBundle(manifest, output, async (_url, options) => {
				assert.equal(options.headers.Range, `bytes=512-${511 + data.length}`);
				assert.equal(options.redirect, 'error');
				if (++calls > 1) return response();
				if (failure === 'HTTP 503') return new Response('unavailable', { status: 503 });
				if (failure === 'timeout') throw new DOMException('request timed out', 'TimeoutError');
				const error = Object.assign(Error('read ECONNRESET'), { code: 'ECONNRESET' });
				if (failure === 'connection reset') throw new TypeError('fetch failed', { cause: error });
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(data.subarray(0, 5));
						},
						pull(controller) {
							controller.error(error);
						}
					}),
					{ status: 206, headers: { 'content-range': `bytes 512-${511 + data.length}/2881562112` } }
				);
			});
			assert.equal(calls, 2);
			assert.equal(sha256(await readFile(output)), manifest.archive_sha256);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const failure of ['permanent network error', 'HTTP 404', 'corrupt bytes', 'repeated reset']) {
	test(`bounds ${failure} without publishing or retrying integrity failures`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'modutex-local-bundle-'));
		try {
			let calls = 0;
			const output = join(directory, 'bundle.zip');
			await assert.rejects(
				prepareBundle(fixture(), output, async () => {
					calls++;
					if (failure === 'HTTP 404') return new Response('missing', { status: 404 });
					if (failure === 'corrupt bytes') return response(Buffer.alloc(data.length));
					throw new TypeError('fetch failed', {
						cause: Object.assign(Error(failure), { code: failure === 'repeated reset' ? 'ECONNRESET' : 'CERT_HAS_EXPIRED' })
					});
				})
			);
			assert.equal(calls, failure === 'repeated reset' ? 3 : 1);
			await assert.rejects(readFile(output), { code: 'ENOENT' });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test('retry backoff respects the shared preparation deadline', async (t) => {
	const originalTimeout = AbortSignal.timeout;
	t.mock.method(AbortSignal, 'timeout', (ms) => originalTimeout(ms === 240000 ? 50 : ms));
	const directory = await mkdtemp(join(tmpdir(), 'modutex-local-bundle-'));
	try {
		let calls = 0;
		const output = join(directory, 'bundle.zip');
		await assert.rejects(
			prepareBundle(fixture(), output, async () => {
				calls++;
				return new Response('unavailable', { status: 503 });
			}),
			/aborted/i
		);
		assert.equal(calls, 1, 'the exhausted shared deadline must prevent another request');
		await assert.rejects(readFile(output), { code: 'ENOENT' });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('a permanent resource failure aborts the other in-flight transfers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-local-bundle-'));
	try {
		const manifest = fixture(),
			output = join(directory, 'bundle.zip');
		manifest.files.push({ ...manifest.files[0], name: 'second.cls', offset: 1024 });
		let cancelled = false;
		await assert.rejects(
			prepareBundle(manifest, output, async (_url, options) => {
				if (options.headers.Range.startsWith('bytes=512-')) return response(Buffer.alloc(data.length));
				return new Promise((_accept, reject) =>
					options.signal.addEventListener(
						'abort',
						() => {
							cancelled = true;
							reject(options.signal.reason);
						},
						{ once: true }
					)
				);
			}),
			/SHA-256 mismatch/
		);
		assert.equal(cancelled, true);
		await assert.rejects(readFile(output), { code: 'ENOENT' });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
