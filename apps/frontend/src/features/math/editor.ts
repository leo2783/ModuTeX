import type { EditorState } from '@codemirror/state';
import { insertionTransaction, rangeInsertionTarget, sourceState } from '../source-editor/state.ts';
import { equationReplacement, type EquationDraft, type LocatedEquation } from './source.ts';

/** Shared CodeMirror transaction; a no-op does not create a dirty checkpoint. */
export function equationEditTransaction(state: EditorState, located: LocatedEquation, draft: EquationDraft) {
	const source = state.field(sourceState).projection.document;
	const replacement = equationReplacement(source, located, draft);
	if (replacement === source.read(located.span.from, located.span.to)) return null;
	return insertionTransaction(state, rangeInsertionTarget(state, located.span), replacement.replace(/\r\n|\r/g, '\n'));
}
