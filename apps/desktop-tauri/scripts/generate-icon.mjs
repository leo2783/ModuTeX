// SPDX-License-Identifier: Apache-2.0
// Generates the original neutral G1 build icon: a white "M" on dark blue,
// 32x32 RGBA. Deterministic, Node built-ins only, no network. Writes only
// icons/icon.png and icons/icon.ico under apps/desktop-tauri.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const SIZE = 32;
const RADIUS = 6;
const BACKGROUND = [13, 43, 94, 255];
const FOREGROUND = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** Rounded-square tile; pixels outside the corner arcs stay transparent. */
function insideTile(x, y) {
	const px = x + 0.5;
	const py = y + 0.5;
	const dx = Math.max(RADIUS - px, 0, px - (SIZE - RADIUS));
	const dy = Math.max(RADIUS - py, 0, py - (SIZE - RADIUS));
	return dx * dx + dy * dy <= RADIUS * RADIUS;
}

/** Two 3px vertical bars joined by two diagonals meeting at the centre. */
function insideGlyph(x, y) {
	if (y < 8 || y > 23) return false;
	if ((x >= 7 && x <= 9) || (x >= 22 && x <= 24)) return true;
	if (y > 17) return false;
	const px = x + 0.5;
	const shift = ((y - 8) * 7) / 9;
	return Math.abs(px - (8.5 + shift)) <= 1.75 || Math.abs(px - (23.5 - shift)) <= 1.75;
}

function rawScanlines() {
	const stride = 1 + SIZE * 4;
	const raw = Buffer.alloc(stride * SIZE);
	for (let y = 0; y < SIZE; y++) {
		raw[y * stride] = 0; // filter type: None
		for (let x = 0; x < SIZE; x++) {
			const pixel = !insideTile(x, y) ? CLEAR : insideGlyph(x, y) ? FOREGROUND : BACKGROUND;
			Buffer.from(pixel).copy(raw, y * stride + 1 + x * 4);
		}
	}
	return raw;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), 8 + data.length);
	return out;
}

function encodePng(raw) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(SIZE, 0);
	header.writeUInt32BE(SIZE, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // colour type: RGBA
	const compressed = deflateSync(raw, { level: 9 });
	if (!inflateSync(compressed).equals(raw)) throw new Error('PNG data failed round-trip check');
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', compressed),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** ICO container with a single PNG-compressed 32x32 32-bit image. */
function encodeIco(png) {
	const header = Buffer.alloc(22);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(1, 4); // image count
	header[6] = SIZE;
	header[7] = SIZE;
	header.writeUInt16LE(1, 10); // colour planes
	header.writeUInt16LE(32, 12); // bits per pixel
	header.writeUInt32LE(png.length, 14);
	header.writeUInt32LE(22, 18); // image data offset
	return Buffer.concat([header, png]);
}

const png = encodePng(rawScanlines());
const iconsUrl = new URL('../icons/', import.meta.url);
mkdirSync(fileURLToPath(iconsUrl), { recursive: true });
writeFileSync(new URL('icon.png', iconsUrl), png);
writeFileSync(new URL('icon.ico', iconsUrl), encodeIco(png));
console.log(`Wrote icon.png (${png.length} bytes) and icon.ico to ${fileURLToPath(iconsUrl)}`);
