import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Original two-page vector fixture; offsets calculated from actual ASCII bytes. */
function twoPages(): Uint8Array {
	const commands = ['0 0 0 rg 10 10 20 20 re f', '0 0 0 rg 60 60 20 20 re f'];
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 5 0 R >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 6 0 R >>',
		...commands.map((value) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`)
	];
	let value = '%PDF-1.7\n'; const offsets = [0];
	for (const [index, object] of objects.entries()) { offsets.push(value.length); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const xref = value.length;
	value += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	value += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
	value += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(value);
}

test('real PDF.js renders distinct pages and zoomed vector pixels, then destroys resources', async () => {
	const loading = getDocument({ data: twoPages(), useSystemFonts: true });
	try {
		const pdf = await loading.promise; assert.equal(pdf.numPages, 2);
		const factory = pdf.canvasFactory as { create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }; destroy(value: unknown): void };
		for (const number of [1, 2]) {
			const page = await pdf.getPage(number);
			for (const scale of [1, 1.5]) {
				const viewport = page.getViewport({ scale });
				const surface = factory.create(viewport.width, viewport.height);
				try {
					await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
					const pixel = (x: number, y: number) => Array.from(surface.context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
					assert.deepEqual(pixel(15, 85), number === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
					assert.deepEqual(pixel(65, 35), number === 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
				} finally { factory.destroy(surface); }
			}
			page.cleanup();
		}
		await assert.rejects(pdf.getPage(3), /Invalid page request/);
	} finally { await loading.destroy(); }
});
