import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageType, validateImageFile, IMAGE_BYTES_LIMIT } from '../src/schemas/images.ts';
import { parseSaveAsRequest } from '../src/schemas/validate.ts';

const png = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));
test('image byte envelopes require bounded PNG/JPEG bytes and matching extensions', () => {
	assert.equal(imageType(png()), 'image/png'); validateImageFile('picture.png', png());
	assert.throws(() => validateImageFile('picture.jpg', png()));
	assert.throws(() => imageType(new TextEncoder().encode('<svg></svg>')));
	assert.throws(() => imageType(new Uint8Array(IMAGE_BYTES_LIMIT + 1)));
});
test('save-as images are copied, bounded, unique and reject accessor payloads', () => {
	const bytes = png();
	const request = { workspaceId: null, bytes: new TextEncoder().encode('tex'), documentId: 'image-document', documentVersion: 1, images: [{ path: 'modutex-image-abcd.png', bytes }] };
	const result = parseSaveAsRequest(request, 1024); bytes[8] = bytes[8]! ^ 1;
	assert.notEqual(result.images![0]!.bytes[8], bytes[8]);
	assert.throws(() => parseSaveAsRequest({ ...request, images: [request.images[0], request.images[0]] }, 1024));
	assert.throws(() => parseSaveAsRequest({ ...request, images: [{ path: '../outside.png', bytes: png() }] }, 1024));
	let called = false; const images: unknown[] = []; Object.defineProperty(images, 0, { get() { called = true; return request.images[0]; }, enumerable: true });
	assert.throws(() => parseSaveAsRequest({ ...request, images }, 1024)); assert.equal(called, false);
});
