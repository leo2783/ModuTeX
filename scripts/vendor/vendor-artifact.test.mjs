import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	createProvenanceRecord,
	downloadVerifiedArtifact,
	hashFileSha256,
	verifyArchiveDirectory,
	verifyCachedArtifact
} from './vendor-artifact.mjs';
import {
	DRAWIO_FIXTURE_FILES,
	DRAWIO_RETAINED_BYTES,
	DRAWIO_RETAINED_FILE_COUNT,
	DRAWIO_RETAINED_TREE_SHA256,
	verifyDrawioInstallation
} from '../verify-vendor.mjs';

const node = process.execPath;
const cli = fileURLToPath(new URL('../verify-vendor.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const vendorManifest = JSON.parse(await readFile(join(repositoryRoot, 'vendor', 'vendor-lock.json'), 'utf8'));

const readStagedVendorBlobs = () => {
	const listing = spawnSync('git', ['ls-files', '--stage', '--', 'vendor/drawio'], {
		encoding: 'utf8'
	});
	assert.equal(listing.status, 0, listing.stderr);
	const rows = listing.stdout
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const match = /^(\d+) ([0-9a-f]{40}) (\d+)\t(.+)$/.exec(line);
			assert.ok(match, `unexpected git ls-files --stage row: ${line}`);
			return { mode: match[1], oid: match[2], stage: match[3], path: match[4] };
		});
	assert.ok(rows.length > 3000, 'staged Draw.io inventory is unexpectedly small');

	const batch = spawnSync(
		'git',
		['cat-file', '--batch'],
		{
			input: `${rows.map(({ oid }) => oid).join('\n')}\n`,
			encoding: null,
			maxBuffer: 256 * 1024 * 1024
		}
	);
	assert.equal(batch.status, 0, batch.error?.message ?? batch.stderr?.toString());
	assert.ok(Buffer.isBuffer(batch.stdout));
	const blobs = new Map();
	let offset = 0;
	for (const row of rows) {
		const headerEnd = batch.stdout.indexOf(0x0a, offset);
		assert.notEqual(headerEnd, -1, `missing cat-file header for ${row.path}`);
		const [oid, type, sizeText] = batch.stdout.subarray(offset, headerEnd).toString('ascii').split(' ');
		assert.equal(oid, row.oid);
		assert.equal(type, 'blob');
		const size = Number(sizeText);
		const contentStart = headerEnd + 1;
		const contentEnd = contentStart + size;
		assert.ok(contentEnd < batch.stdout.length + 1);
		blobs.set(row.path, Buffer.from(batch.stdout.subarray(contentStart, contentEnd)));
		assert.equal(batch.stdout[contentEnd], 0x0a, `missing cat-file separator for ${row.path}`);
		offset = contentEnd + 1;
	}
	return rows.map((row) => ({ ...row, content: blobs.get(row.path) }));
};

const fixtureEntry = async (archive, bytes) => ({
	version: '1.2.3',
	archive,
	url: 'https://github.com/example/vendor/releases/download/v1.2.3/vendor-1.2.3.zip',
	sha256: await hashFileSha256(bytes),
	license: 'MIT',
	notice: 'vendor/notices/EXAMPLE.md',
	provenance: 'https://github.com/example/vendor/releases/tag/v1.2.3'
});

test('rejects a deliberate byte-level hash mismatch without leaking its directory', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-vendor-mismatch-'));
	const archive = 'drawio-31.1.8.zip';
	await writeFile(join(directory, archive), Buffer.from('deliberately wrong archive bytes'));

	await assert.rejects(
		verifyArchiveDirectory('drawio-offline', {
			archive,
			sha256: 'f315069ca6b326083b9f9b8dadfc8dbd29f4c2ef78c8e346c3f0f2e99a0603f7'
		}, directory),
		(error) => {
			assert.match(error.message, /drawio-offline: SHA-256 mismatch/);
			assert.doesNotMatch(error.message, new RegExp(directory.replaceAll('\\', '\\\\')));
			return true;
		}
	);
});

test('offline cache rehashes bytes and rejects tampering after provenance was recorded', async () => {
	const cacheDirectory = await mkdtemp(join(tmpdir(), 'modutex-vendor-cache-'));
	const archive = 'vendor-1.2.3.zip';
	const original = Buffer.from('verified fixture bytes');
	const fixturePath = join(cacheDirectory, archive);
	await writeFile(fixturePath, original);
	const entry = await fixtureEntry(archive, fixturePath);
	await writeFile(
		join(cacheDirectory, `${archive}.provenance.json`),
		`${JSON.stringify(createProvenanceRecord('example', entry, 'explicit-archive', '2026-08-13T00:00:00.000Z'), null, 2)}\n`
	);

	await writeFile(fixturePath, Buffer.from('tampered fixture bytes'));
	await assert.rejects(
		verifyCachedArtifact('example', entry, cacheDirectory),
		/example: SHA-256 mismatch/
	);
});

test('offline cache rejects provenance drift even when archive bytes still match', async () => {
	const cacheDirectory = await mkdtemp(join(tmpdir(), 'modutex-vendor-provenance-'));
	const archive = 'vendor-1.2.3.zip';
	const fixturePath = join(cacheDirectory, archive);
	await writeFile(fixturePath, Buffer.from('unchanged fixture bytes'));
	const entry = await fixtureEntry(archive, fixturePath);
	const record = createProvenanceRecord(
		'example',
		entry,
		'explicit-archive',
		'2026-08-13T00:00:00.000Z'
	);
	record.url = 'https://github.com/example/vendor/releases/download/v9.9.9/vendor-9.9.9.zip';
	await writeFile(
		join(cacheDirectory, `${archive}.provenance.json`),
		`${JSON.stringify(record, null, 2)}\n`
	);
	await assert.rejects(
		verifyCachedArtifact('example', entry, cacheDirectory),
		/example: cache provenance metadata does not match the reviewed manifest/
	);
});

test('download mode refuses a partial cache instead of silently replacing it', async () => {
	const cacheDirectory = await mkdtemp(join(tmpdir(), 'modutex-vendor-partial-'));
	const archive = 'vendor-1.2.3.zip';
	const fixturePath = join(cacheDirectory, archive);
	await writeFile(fixturePath, Buffer.from('partial cache bytes'));
	const entry = await fixtureEntry(archive, fixturePath);
	await assert.rejects(
		downloadVerifiedArtifact('example', entry, cacheDirectory),
		/example: partial cache state requires manual removal/
	);
});

test('rejects wrong-case archive filenames', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-vendor-path-'));
	const bytes = Buffer.from('fixture archive bytes');
	const expectedArchive = 'vendor-1.2.3.zip';
	const wrongCase = 'VENDOR-1.2.3.ZIP';
	await writeFile(join(directory, wrongCase), bytes);
	const entry = await fixtureEntry(expectedArchive, join(directory, wrongCase));
	await assert.rejects(
		verifyArchiveDirectory('example', entry, directory),
		/example: exact archive filename required/
	);
});

test('rejects archive junctions', async () => {
	const bytes = Buffer.from('fixture archive bytes');
	const expectedArchive = 'vendor-1.2.3.zip';
	const targetDirectory = await mkdtemp(join(tmpdir(), 'modutex-vendor-target-'));
	const target = join(targetDirectory, expectedArchive);
	await writeFile(target, bytes);
	const entry = await fixtureEntry(expectedArchive, target);
	const linkDirectory = await mkdtemp(join(tmpdir(), 'modutex-vendor-link-'));
	await symlink(targetDirectory, join(linkDirectory, expectedArchive), 'junction');
	await assert.rejects(
		verifyArchiveDirectory('example', entry, linkDirectory),
		/example: archive must be a regular file inside the selected directory/
	);
});

test('CLI mismatch exits nonzero and never prints the absolute archive directory', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-vendor-cli-'));
	await writeFile(join(directory, 'drawio-31.1.8.zip'), Buffer.from('wrong'));
	const result = spawnSync(node, [cli, '--archive-dir', directory, '--artifact', 'drawio-offline'], {
		encoding: 'utf8'
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /drawio-offline: SHA-256 mismatch/);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(directory.replaceAll('\\', '\\\\')));
});

test('CLI rejects ambiguous and incomplete directory modes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-vendor-cli-options-'));
	await mkdir(join(directory, 'archives'));
	const ambiguous = spawnSync(node, [cli, '--archive-dir', join(directory, 'archives'), '--download'], {
		encoding: 'utf8'
	});
	assert.notEqual(ambiguous.status, 0);
	assert.match(ambiguous.stderr, /--download requires --cache-dir/);

	const missing = spawnSync(node, [cli, '--artifact', 'drawio-offline'], { encoding: 'utf8' });
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /at least one verification directory is required/);
});

test('CLI never reflects an absolute path passed as an invalid option or artifact', async () => {
	const sensitivePath = join(tmpdir(), 'private-vendor-location');
	const invalidOption = spawnSync(node, [cli, sensitivePath], { encoding: 'utf8' });
	assert.notEqual(invalidOption.status, 0);
	assert.doesNotMatch(invalidOption.stderr, new RegExp(sensitivePath.replaceAll('\\', '\\\\')));

	const invalidArtifact = spawnSync(
		node,
		[cli, '--cache-dir', tmpdir(), '--artifact', sensitivePath],
		{ encoding: 'utf8' }
	);
	assert.notEqual(invalidArtifact.status, 0);
	assert.doesNotMatch(invalidArtifact.stderr, new RegExp(sensitivePath.replaceAll('\\', '\\\\')));
});

test('verifies the retained Draw.io webapp, notices, and real fixture inventory', async () => {
	const report = await verifyDrawioInstallation(repositoryRoot, vendorManifest.artifacts['drawio-offline']);
	assert.equal(report.version, '31.1.8');
	assert.equal(report.files, DRAWIO_RETAINED_FILE_COUNT);
	assert.equal(report.bytes, DRAWIO_RETAINED_BYTES);
	assert.equal(report.sha256, DRAWIO_RETAINED_TREE_SHA256);
	assert.deepEqual(report.fixtures.categories.sort(), Object.keys(DRAWIO_FIXTURE_FILES).sort());
	assert.equal(report.fixtures.files, 4);
});

test('staged Draw.io inventory preserves the reviewed raw-byte digest', () => {
	const rows = readStagedVendorBlobs();
	const hash = createHash('sha256');
	let bytes = 0;
	for (const row of rows
		.filter(({ path }) => path.startsWith('vendor/drawio/'))
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
		const relativePath = row.path.slice('vendor/drawio/'.length);
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(row.content.length));
		hash.update(Buffer.from(relativePath, 'utf8'));
		hash.update(Buffer.from([0]));
		hash.update(length);
		hash.update(row.content);
		bytes += row.content.length;
	}
	assert.equal(rows.length, DRAWIO_RETAINED_FILE_COUNT);
	assert.equal(bytes, DRAWIO_RETAINED_BYTES);
	assert.equal(hash.digest('hex'), DRAWIO_RETAINED_TREE_SHA256);

	const representative = spawnSync(
		'git',
		['ls-files', '--eol', '--', 'vendor/drawio/src/main/webapp/js/diagramly/GraphViewer.js'],
		{ encoding: 'utf8' }
	);
	assert.equal(representative.status, 0, representative.stderr);
	assert.match(representative.stdout, /i\/crlf\s+w\/crlf\s+attr\/\-text/);
});

test('rejects recovered Draw.io server content outside the static webapp boundary', async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), 'modutex-drawio-retention-'));
	const serverFile = join(temporaryRoot, 'vendor', 'drawio', 'src', 'main', 'server', 'blocked.java');
	await mkdir(resolve(serverFile, '..'), { recursive: true });
	await writeFile(serverFile, 'server content must never be retained');

	await assert.rejects(
		verifyDrawioInstallation(temporaryRoot, { version: '31.1.8' }),
		/drawio: retained tree escapes static webapp \(src\/main\/server\/blocked\.java\)/
	);
});

test('fails closed for server/runtime metadata and secret-bearing paths', async () => {
	const forbiddenPaths = [
		['src', 'main', 'webapp', 'WEB-INF', 'web.xml'],
		['src', 'main', 'webapp', 'META-INF', 'MANIFEST.MF'],
		['src', 'main', 'webapp', 'runtime', 'blocked.jar'],
		['src', 'main', 'webapp', 'server', 'runtime.js'],
		['src', 'main', 'webapp', 'config', 'client_secret'],
		['src', 'main', 'webapp', 'config', 'cloud_convert_api_key']
	];
	for (const relativeParts of forbiddenPaths) {
		const temporaryRoot = await mkdtemp(join(tmpdir(), 'modutex-drawio-forbidden-'));
		const forbiddenFile = join(temporaryRoot, 'vendor', 'drawio', ...relativeParts);
		await mkdir(resolve(forbiddenFile, '..'), { recursive: true });
		await writeFile(forbiddenFile, 'must never be retained');

		await assert.rejects(
			verifyDrawioInstallation(temporaryRoot, { version: '31.1.8' }),
			(error) => {
				assert.match(error.message, /drawio: forbidden (?:WEB-INF content|META-INF content|JAR content|server content|secret\/config content) in retained tree/);
				assert.match(error.message, new RegExp(relativeParts.join('\\/')));
				return true;
			}
		);
	}
});

test('keeps trailing-whitespace checks active for non-vendor source files', async () => {
	const serverAttribute = spawnSync(
		'git',
		['check-attr', 'whitespace', '--', 'vendor/drawio/src/main/server/blocked.java'],
		{ encoding: 'utf8' }
	);
	assert.equal(serverAttribute.status, 0, serverAttribute.stderr);
	assert.match(serverAttribute.stdout, /vendor\/drawio\/src\/main\/server\/blocked\.java: whitespace: unspecified/);

	const temporaryRoot = await mkdtemp(join(tmpdir(), 'modutex-whitespace-negative-'));
	const cleanFile = join(temporaryRoot, 'source-clean.txt');
	const dirtyFile = join(temporaryRoot, 'source-dirty.txt');
	await writeFile(cleanFile, 'source line\n');
	await writeFile(dirtyFile, 'source line \n');

	const result = spawnSync('git', ['diff', '--no-index', '--check', '--', cleanFile, dirtyFile], {
		encoding: 'utf8'
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /trailing whitespace/);
});
