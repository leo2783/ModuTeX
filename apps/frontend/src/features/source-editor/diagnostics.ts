// Original ModuTeX implementation. License pending provenance review.
import type { EditorState } from '@codemirror/state';
import type { SourceSpan } from '@modutex/document-core';
import { sourceState } from './state.ts';

/**
 * Normalized editor coordinates: lines are one-based, and a non-null column
 * is a one-based UTF-16 code-unit column. The host Diagnostic contract does
 * not specify column units; callers must normalize known UTF-16 columns or
 * pass null to navigate to the line without asserting a column unit.
 */
export interface NormalizedDiagnosticLocation {
	readonly line: number;
	readonly utf16Column: number | null;
}

export interface DiagnosticNavigationRequest {
	readonly location: NormalizedDiagnosticLocation;
	readonly documentId: string;
	readonly documentVersion: number;
	readonly sequence: number;
}

/** Map normalized editor coordinates to a source-byte span. */
export function diagnosticSourceSpan(state: EditorState, location: NormalizedDiagnosticLocation): SourceSpan | null {
	const lineNumber = location.line;
	if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) return null;
	const line = state.doc.line(lineNumber);
	let from = line.from, to = line.to;
	const column = location.utf16Column;
	if (column !== null) {
		if (!Number.isSafeInteger(column) || column < 1) return null;
		const offset = column - 1, length = line.text.length;
		if (offset > length) return null;
		from = line.from + offset;
		if (offset === length) to = from;
		else {
			const current = line.text.charCodeAt(offset);
			const next = line.text.charCodeAt(offset + 1);
			const previous = offset > 0 ? line.text.charCodeAt(offset - 1) : -1;
			const isHighSurrogate = current >= 0xd800 && current <= 0xdbff;
			const isLowSurrogate = current >= 0xdc00 && current <= 0xdfff;
			if (isLowSurrogate && previous >= 0xd800 && previous <= 0xdbff) return null;
			to = from + (isHighSurrogate && next >= 0xdc00 && next <= 0xdfff ? 2 : 1);
		}
	}

	// Editor positions omit a BOM and normalize CRLF. The projection converts
	// their UTF-16 offsets back to the document's byte offsets.
	try {
		const projection = state.field(sourceState).projection;
		const document = projection.document;
		const sourceFrom = projection.toSource(from), sourceTo = projection.toSource(to);
		if (!Number.isSafeInteger(sourceFrom) || !Number.isSafeInteger(sourceTo) ||
			sourceFrom < 0 || sourceTo < sourceFrom || sourceTo > document.byteLength) return null;
		return { documentId: document.documentId, version: document.version, from: sourceFrom, to: sourceTo };
	} catch { return null; }
}
