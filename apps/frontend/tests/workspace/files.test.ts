import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSource, readSourceBytes, readPdf, sourceLimit, pdfLimit } from '../../src/features/files/read.ts';

test('actual File bytes retain BOM, CRLF, comments and unknown syntax', async () => {
	const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('%keep\r\n\\opaque{a}\r\n')]);
	const source = await readSource(new File([bytes], 'main.tex'));
	assert.deepEqual(source.toBytes(), bytes);
});
test('source reader rejects wrong extension, oversized file and invalid UTF-8', async () => {
	await assert.rejects(readSource(new File(['x'], 'main.js')), /FILE_TYPE/);
	await assert.rejects(readSource(new File([new Uint8Array(sourceLimit + 1)], 'main.tex')), /SOURCE_TOO_LARGE/);
	await assert.rejects(readSource(new File([Uint8Array.of(0xff)], 'main.tex')), /UTF-8/);
});
test('PDF reader rejects wrong type and non-PDF headers; header check is not full validation', async () => {
	await assert.rejects(readPdf(new File(['%PDF-1.7'], 'document.html')), /FILE_TYPE/);
	await assert.rejects(readPdf(new File(['not a pdf'], 'document.pdf')), /PDF_HEADER/);
	await assert.rejects(readPdf(new File([new Uint8Array(pdfLimit + 1)], 'document.pdf')), /PDF_TOO_LARGE/);
});

test('browser and desktop byte readers accept exactly 5 MiB with BOM and reject one byte above', async () => {
	assert.equal(sourceLimit, 5 * 1024 * 1024);
	const bytes = new Uint8Array(sourceLimit).fill(0x61);
	bytes.set([0xef, 0xbb, 0xbf]); bytes.set([13, 10], 3);
	assert.deepEqual((await readSource(new File([bytes], 'large.tex'))).toBytes(), bytes);
	assert.deepEqual(readSourceBytes(bytes).toBytes(), bytes);
	assert.throws(() => readSourceBytes(new Uint8Array(sourceLimit + 1)), /SOURCE_TOO_LARGE/);
});
