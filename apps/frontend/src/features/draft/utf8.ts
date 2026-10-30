// SPDX-License-Identifier: Apache-2.0
// UTF-8 byte boundary utilities and paragraph range detection for Draft.

import type { DraftSourceRange } from './types.ts';

export const MAX_PARAGRAPH_SOURCE_BYTES = 1024 * 1024; // 1 MiB limit matching native backend

function isWhitespaceCodeUnit(code: number): boolean {
	return (
		(code >= 0x0009 && code <= 0x000d) ||
		code === 0x0020 ||
		code === 0x00a0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

export function utf16OffsetToUtf8ByteOffset(text: string, utf16Offset: number): number {
	if (!Number.isFinite(utf16Offset)) throw new RangeError('Invalid UTF-16 offset');
	const clamped = Math.max(0, Math.min(utf16Offset, text.length));
	if (!Number.isInteger(clamped)) throw new RangeError('Invalid UTF-16 offset');
	if (
		clamped > 0 &&
		clamped < text.length &&
		text.charCodeAt(clamped - 1) >= 0xd800 &&
		text.charCodeAt(clamped - 1) <= 0xdbff &&
		text.charCodeAt(clamped) >= 0xdc00 &&
		text.charCodeAt(clamped) <= 0xdfff
	) {
		throw new RangeError('UTF-16 offset splits a surrogate pair');
	}

	let byteOffset = 0;
	for (let index = 0; index < clamped; ) {
		const code = text.charCodeAt(index);
		let byteWidth = 3;
		let codeUnits = 1;
		if (code <= 0x7f) {
			byteWidth = 1;
		} else if (code <= 0x7ff) {
			byteWidth = 2;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < clamped) {
			const low = text.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				byteWidth = 4;
				codeUnits = 2;
			}
		}
		byteOffset += byteWidth;
		index += codeUnits;
	}
	return byteOffset;
}

export function utf8ByteOffsetToUtf16Offset(text: string, byteOffset: number): number {
	if (!Number.isFinite(byteOffset)) throw new RangeError('Invalid UTF-8 offset');
	if (byteOffset <= 0) return 0;

	let bytes = 0;
	let index = 0;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		let byteWidth = 3;
		let codeUnits = 1;
		if (code <= 0x7f) {
			byteWidth = 1;
		} else if (code <= 0x7ff) {
			byteWidth = 2;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const low = text.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				byteWidth = 4;
				codeUnits = 2;
			}
		}
		const nextBytes = bytes + byteWidth;
		if (byteOffset < nextBytes) throw new RangeError('UTF-8 offset splits a character');
		bytes = nextBytes;
		index += codeUnits;
		if (byteOffset === bytes) return index;
	}
	return text.length;
}

export interface EnclosingParagraph {
	readonly from: number;
	readonly to: number;
	readonly source: string;
	readonly range: DraftSourceRange;
}

export function findEnclosingParagraph(
	text: string,
	selection?: { from: number; to: number } | null
): EnclosingParagraph | null {
	let from = 0;
	let to = text.length;
	let cursor = 0;
	let hasSelectionRange = false;

	if (selection !== undefined && selection !== null) {
		const requestedFrom = selection.from;
		const requestedTo = selection.to;
		if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo)) {
			throw new RangeError('Invalid selection offset');
		}
		const clampedFrom = Math.max(0, Math.min(requestedFrom, text.length));
		const clampedTo = Math.max(0, Math.min(requestedTo, text.length));
		if (!Number.isInteger(clampedFrom) || !Number.isInteger(clampedTo)) {
			throw new RangeError('Invalid selection offset');
		}
		hasSelectionRange = requestedFrom !== requestedTo;

		if (hasSelectionRange) {
			from = Math.min(clampedFrom, clampedTo);
			to = Math.max(clampedFrom, clampedTo);
			if (
				(from > 0 &&
					from < text.length &&
					text.charCodeAt(from - 1) >= 0xd800 &&
					text.charCodeAt(from - 1) <= 0xdbff &&
					text.charCodeAt(from) >= 0xdc00 &&
					text.charCodeAt(from) <= 0xdfff) ||
				(to > 0 &&
					to < text.length &&
					text.charCodeAt(to - 1) >= 0xd800 &&
					text.charCodeAt(to - 1) <= 0xdbff &&
					text.charCodeAt(to) >= 0xdc00 &&
					text.charCodeAt(to) <= 0xdfff)
			) {
				throw new RangeError('Selection splits a surrogate pair');
			}
		} else {
			cursor = clampedFrom;
			if (
				cursor > 0 &&
				cursor < text.length &&
				text.charCodeAt(cursor - 1) >= 0xd800 &&
				text.charCodeAt(cursor - 1) <= 0xdbff &&
				text.charCodeAt(cursor) >= 0xdc00 &&
				text.charCodeAt(cursor) <= 0xdfff
			) {
				throw new RangeError('Selection splits a surrogate pair');
			}
		}
	}

	if (text.length === 0) return null;

	if (hasSelectionRange) {
		if (from === to) return null;

		let startByte = 0;
		let endByte = 0;
		let byteOffset = 0;
		let hasNonWhitespace = false;
		for (let index = 0; index < to; ) {
			if (index === from) startByte = byteOffset;

			const code = text.charCodeAt(index);
			let byteWidth = 3;
			let codeUnits = 1;
			if (code <= 0x7f) {
				byteWidth = 1;
			} else if (code <= 0x7ff) {
				byteWidth = 2;
			} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < to) {
				const low = text.charCodeAt(index + 1);
				if (low >= 0xdc00 && low <= 0xdfff) {
					byteWidth = 4;
					codeUnits = 2;
				}
			}
			if (index >= from && !isWhitespaceCodeUnit(code)) hasNonWhitespace = true;
			byteOffset += byteWidth;
			index += codeUnits;
			if (index === to) endByte = byteOffset;
		}
		if (!hasNonWhitespace) return null;
		if (endByte - startByte > MAX_PARAGRAPH_SOURCE_BYTES) {
			throw new Error('PARAGRAPH_TOO_LARGE');
		}

		return {
			from,
			to,
			source: text.slice(from, to),
			range: { startByte, endByte }
		};
	}

	let paragraphStart = 0;
	let paragraphStartByte = 0;
	let paragraphLastLineEnd = 0;
	let paragraphLastLineEndByte = 0;
	let paragraphHasContent = false;
	let lineStart = 0;
	let lineStartByte = 0;
	let lineHasNonWhitespace = false;
	let byteOffset = 0;

	for (let index = 0; index < text.length; ) {
		const code = text.charCodeAt(index);
		if (code === 0x000a) {
			const isCrLf = index > lineStart && text.charCodeAt(index - 1) === 0x000d;
			const lineEnd = isCrLf ? index - 1 : index;
			const lineEndByte = byteOffset - (isCrLf ? 1 : 0);

			if (lineHasNonWhitespace) {
				if (!paragraphHasContent) {
					paragraphStart = lineStart;
					paragraphStartByte = lineStartByte;
					paragraphHasContent = true;
				}
				paragraphLastLineEnd = lineEnd;
				paragraphLastLineEndByte = lineEndByte;
			} else {
				const nextStart = index + 1;
				if (paragraphHasContent && cursor >= paragraphStart && cursor <= paragraphLastLineEnd) {
					if (paragraphLastLineEndByte - paragraphStartByte > MAX_PARAGRAPH_SOURCE_BYTES) {
						throw new Error('PARAGRAPH_TOO_LARGE');
					}
					return {
						from: paragraphStart,
						to: paragraphLastLineEnd,
						source: text.slice(paragraphStart, paragraphLastLineEnd),
						range: {
							startByte: paragraphStartByte,
							endByte: paragraphLastLineEndByte
						}
					};
				}
				if (cursor < nextStart) return null;
				paragraphHasContent = false;
				paragraphStart = nextStart;
				paragraphStartByte = byteOffset + 1;
			}

			byteOffset += 1;
			index += 1;
			lineStart = index;
			lineStartByte = byteOffset;
			lineHasNonWhitespace = false;
			continue;
		}

		let byteWidth = 3;
		let codeUnits = 1;
		if (code <= 0x7f) {
			byteWidth = 1;
		} else if (code <= 0x7ff) {
			byteWidth = 2;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const low = text.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				byteWidth = 4;
				codeUnits = 2;
			}
		}
		if (!isWhitespaceCodeUnit(code)) lineHasNonWhitespace = true;
		byteOffset += byteWidth;
		index += codeUnits;
	}

	if (lineHasNonWhitespace && !paragraphHasContent) {
		paragraphStart = lineStart;
		paragraphStartByte = lineStartByte;
		paragraphHasContent = true;
	}
	if (paragraphHasContent && cursor >= paragraphStart) {
		if (byteOffset - paragraphStartByte > MAX_PARAGRAPH_SOURCE_BYTES) {
			throw new Error('PARAGRAPH_TOO_LARGE');
		}
		return {
			from: paragraphStart,
			to: text.length,
			source: text.slice(paragraphStart),
			range: { startByte: paragraphStartByte, endByte: byteOffset }
		};
	}
	return null;
}


