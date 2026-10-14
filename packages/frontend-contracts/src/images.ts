export const IMAGE_BYTES_LIMIT = 5 * 1024 * 1024;
/** Restrict binary file access to the two supported raster formats. */
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
	if (bytes.length > IMAGE_BYTES_LIMIT || bytes.length < 12) throw new Error('FILE_TYPE');
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
	throw new Error('FILE_TYPE');
}
export function validateImageFile(path: string, bytes: Uint8Array): void {
	const type = imageType(bytes);
	if (type === 'image/png' ? !/\.png$/i.test(path) : !/\.jpe?g$/i.test(path)) throw new Error('FILE_TYPE');
}
