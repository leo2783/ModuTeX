export const pdfLimit = 32 * 1024 * 1024;
export async function readPdf(file: File): Promise<Uint8Array> {
	if (!/\.pdf$/i.test(file.name)) throw new Error('FILE_TYPE');
	if (file.size > pdfLimit) throw new Error('PDF_TOO_LARGE');
	const data = new Uint8Array(await file.arrayBuffer());
	if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') throw new Error('PDF_HEADER');
	return data;
}
