// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceUrl = 'https://data1b.fullyjustified.net/tlextras-2022.0r0.tar';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, value) => {
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

// A deterministic stored ZIP keeps resource bytes unchanged and needs no archiver dependency.
export function bundleZip(entries) {
	const local = [],
		central = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const filename = Buffer.from(name);
		let crc = 0xffffffff;
		for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
		crc = (crc ^ 0xffffffff) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt16LE(21537, 12);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(filename.length, 26);
		local.push(header, filename, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0x800, 8);
		directory.writeUInt16LE(21537, 14);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(filename.length, 28);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, filename);
		offset += header.length + filename.length + data.length;
	}
	const directory = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

export async function prepareBundle(manifest, output, fetchResource = fetch) {
	if (
		manifest.source_url !== sourceUrl ||
		!/^[a-f0-9]{64}$/.test(manifest.archive_sha256) ||
		!/^[a-f0-9]{64}$/.test(manifest.bundle_digest)
	) {
		throw Error('Invalid pinned bundle identity');
	}
	const files = manifest.files;
	const names = new Set(['sha256sum']);
	let total = 0;
	for (const file of files) {
		if (
			!/^[a-zA-Z0-9_.+-]+$/.test(file.name) ||
			/\.fmt$/i.test(file.name) ||
			names.has(file.name.toLowerCase()) ||
			!Number.isSafeInteger(file.offset) ||
			file.offset < 0 ||
			!Number.isSafeInteger(file.length) ||
			file.length < 1 ||
			file.length > 8 * 1024 * 1024 ||
			file.offset + file.length > 2881562112 ||
			!/^[a-f0-9]{64}$/.test(file.sha256)
		)
			throw Error('Invalid bundle resource');
		names.add(file.name.toLowerCase());
		total += file.length;
	}
	if (total > 32 * 1024 * 1024 || files.length < 1 || files.length > 1000) throw Error('Bundle resource budget exceeded');
	const deadline = AbortSignal.timeout(240000);
	const contents = new Array(files.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			while (cursor < files.length) {
				const index = cursor++,
					file = files[index];
				const range = `bytes=${file.offset}-${file.offset + file.length - 1}`;
				const response = await fetchResource(sourceUrl, {
					headers: { Range: range },
					redirect: 'error',
					signal: AbortSignal.any([deadline, AbortSignal.timeout(30000)])
				});
				if (response.status !== 206 || response.headers.get('content-range') !== `${range.replace('=', ' ')}/2881562112`) {
					await response.body?.cancel();
					throw Error(`Bundle resource ${file.name} returned an unexpected byte range`);
				}
				const chunks = [];
				let length = 0;
				for await (const chunk of response.body) {
					length += chunk.length;
					if (length > file.length) throw Error(`Bundle resource ${file.name} exceeded its size`);
					chunks.push(chunk);
				}
				const data = Buffer.concat(chunks);
				if (length !== file.length || sha256(data) !== file.sha256) throw Error(`Bundle resource ${file.name} SHA-256 mismatch`);
				contents[index] = [file.name, data];
			}
		})
	);
	const archive = bundleZip([['SHA256SUM', Buffer.from(manifest.bundle_digest)], ...contents]);
	if (sha256(archive) !== manifest.archive_sha256) throw Error('Local test bundle SHA-256 mismatch');
	const destination = resolve(output),
		temporary = `${destination}.${randomUUID()}.tmp`;
	await mkdir(dirname(destination), { recursive: true });
	try {
		await writeFile(temporary, archive, { flag: 'wx' });
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
	return archive.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const manifest = JSON.parse(await readFile(new URL('../fixtures/tectonic-texlive2022-article.json', import.meta.url)));
	const size = await prepareBundle(manifest, resolve('.verification-artifacts/tectonic-test-bundle.zip'));
	console.log(`Verified local Tectonic bundle: ${manifest.files.length} resources, ${size} bytes`);
}
