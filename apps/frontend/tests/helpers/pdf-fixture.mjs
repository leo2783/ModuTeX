// SPDX-License-Identifier: Apache-2.0
export function realPdf() {
	const stream = '0 0 100 100 re S\n';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 1000] /CropBox [40 60 760 940] /Resources << >> /Contents 5 0 R >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 1000] /CropBox [40 60 760 940] /Rotate 90 /Resources << >> /Contents 5 0 R >>',
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
	];
	let source = '%PDF-1.7\n';
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(source));
		source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(source);
	source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
	source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return [...Buffer.from(source)];
}
