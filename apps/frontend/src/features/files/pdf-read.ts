// SPDX-License-Identifier: Apache-2.0
const pdfHeaderBytes = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
export const pdfLimit = 32 * 1024 * 1024;
export async function readPdf(file: File): Promise<Uint8Array> {
	if (!/\.pdf$/i.test(file.name)) throw new Error('FILE_TYPE');
	if (file.size > pdfLimit) throw new Error('PDF_TOO_LARGE');
	const data = new Uint8Array(await file.arrayBuffer());
	if (data.byteLength < pdfHeaderBytes.length || !pdfHeaderBytes.every((byte, index) => data[index] === byte)) {
		throw new Error('PDF_HEADER');
	}
	return data;
}
