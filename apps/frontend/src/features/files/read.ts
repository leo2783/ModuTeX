// SPDX-License-Identifier: Apache-2.0
import { SourceDocument } from '../document-core/core.ts';

export const sourceLimit = 5 * 1024 * 1024;
export { pdfLimit, readPdf } from './pdf-read.ts';

export function readSourceBytes(bytes: Uint8Array): SourceDocument {
	if (bytes.byteLength > sourceLimit) throw new Error('SOURCE_TOO_LARGE');
	return SourceDocument.open(bytes);
}
export async function readSource(file: File): Promise<SourceDocument> {
	if (!/\.tex$/i.test(file.name)) throw new Error('FILE_TYPE');
	if (file.size > sourceLimit) throw new Error('SOURCE_TOO_LARGE');
	return readSourceBytes(new Uint8Array(await file.arrayBuffer()));
}
