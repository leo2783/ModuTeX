import type { EditorState } from '@codemirror/state';
import type { SourceSpan } from '@modutex/document-core';
import { sourceState, insertionTransaction, rangeInsertionTarget } from './state.ts';

/** Explicit source tool; no parser rewrite or implicit package insertion. */
export function rawEditTransaction(state: EditorState, span: SourceSpan, expected: string, replacement: string) {
	const source = state.field(sourceState).projection.document;
	const target = rangeInsertionTarget(state, span);
	if (source.read(span.from, span.to) !== expected) throw new Error('STALE_RAW');
	if (typeof replacement !== 'string' || replacement.includes('\0')) throw new Error('RAW_SOURCE');
	if (replacement === expected) return null;
	const normalized = replacement.replace(/\r\n|\r/g, '\n');
	if (state.doc.sliceString(target.from, target.to) === normalized) return null;
	const transaction = insertionTransaction(state, target, normalized);
	if (!transaction.docChanged) throw new Error('RAW_REJECTED');
	return transaction;
}
