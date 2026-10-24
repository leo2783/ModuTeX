// SPDX-License-Identifier: Apache-2.0
// Display-only previews for Git's byte-oriented diff/log/show/commit results.
// The caller retains the original Uint8Array; decoding is strict and bounded.
export const GIT_TEXT_PREVIEW_LIMIT = 64 * 1024;
const GIT_HEX_PREVIEW_LIMIT = 128;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function hexPreview(bytes) {
	const count = Math.min(bytes.byteLength, GIT_HEX_PREVIEW_LIMIT);
	const lines = [];
	for (let offset = 0; offset < count; offset += 16) {
		const end = Math.min(offset + 16, count);
		const hex = [];
		for (let index = offset; index < end; index++) {
			hex.push(bytes[index].toString(16).padStart(2, '0'));
		}
		lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.join(' ')}`);
	}
	return { hex: lines.join('\n'), hexBytes: count };
}

/**
 * Strict UTF-8 preview. NUL/control bytes and malformed UTF-8 are treated as
 * binary instead of being replaced or silently dropped by a lossy decoder.
 */
export function previewGitBytes(value) {
	if (!(value instanceof Uint8Array)) throw new TypeError('Expected Git output bytes.');
	const totalBytes = value.byteLength;
	const displayedBytes = Math.min(totalBytes, GIT_TEXT_PREVIEW_LIMIT);
	const truncated = totalBytes > displayedBytes;
	const prefix = value.subarray(0, displayedBytes);
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix, {
			stream: truncated
		});
	} catch {
		const binary = hexPreview(value);
		return Object.freeze({
			kind: 'binary',
			totalBytes,
			hex: binary.hex,
			hexBytes: binary.hexBytes,
			truncated: totalBytes > binary.hexBytes
		});
	}
	if (CONTROL_CHARACTERS.test(text)) {
		const binary = hexPreview(value);
		return Object.freeze({
			kind: 'binary',
			totalBytes,
			hex: binary.hex,
			hexBytes: binary.hexBytes,
			truncated: totalBytes > binary.hexBytes
		});
	}
	return Object.freeze({
		kind: 'text',
		text,
		totalBytes,
		displayedBytes,
		truncated
	});
}
