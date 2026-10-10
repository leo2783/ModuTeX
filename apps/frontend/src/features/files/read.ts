// Original ModuTeX implementation. License pending provenance review.
import { SourceDocument } from '@modutex/document-core';

export const sourceLimit = 5 * 1024 * 1024;
export const pdfLimit = 32 * 1024 * 1024;

export function readSourceBytes(bytes: Uint8Array): SourceDocument {
	if (bytes.byteLength > sourceLimit) throw new Error('SOURCE_TOO_LARGE');
	return SourceDocument.open(bytes);
}
export async function readSource(file: File): Promise<SourceDocument> {
	if (!/\.tex$/i.test(file.name)) throw new Error('FILE_TYPE');
	if (file.size > sourceLimit) throw new Error('SOURCE_TOO_LARGE');
	return readSourceBytes(new Uint8Array(await file.arrayBuffer()));
}
export async function readPdf(file: File): Promise<Uint8Array> {
	if (!/\.pdf$/i.test(file.name)) throw new Error('FILE_TYPE');
	if (file.size > pdfLimit) throw new Error('PDF_TOO_LARGE');
	const data = new Uint8Array(await file.arrayBuffer());
	if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') throw new Error('PDF_HEADER');
	return data;
}
