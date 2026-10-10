import { Annotation, ChangeSet, EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorProjection, SourceDocument, type EditorPatch, type SourcePatch, type SourceSpan } from '@modutex/document-core';
import { sourceLimit } from '../files/read.ts';

interface HistoryEntry {
	readonly beforeToken: symbol;
	readonly afterToken: symbol;
	readonly before: EditorProjection;
	readonly after: EditorProjection;
	readonly inverse: ChangeSet;
	readonly forward: ChangeSet;
	readonly beforeSelection: EditorSelection;
	readonly afterSelection: EditorSelection;
}
interface SourceState {
	readonly dirty: boolean;
	readonly currentToken: symbol;
	readonly savedToken: symbol;
	readonly projection: EditorProjection;
	readonly undo: readonly HistoryEntry[];
	readonly redo: readonly HistoryEntry[];
}
const projected = Annotation.define<EditorProjection>();
export const sourcePatches = Annotation.define<readonly SourcePatch[]>();
const navigate = StateEffect.define<'undo' | 'redo'>();
export const savedCheckpoint = StateEffect.define<number>();
export const sourceState = StateField.define<SourceState>({
	create() { throw new Error('Source state must be initialized with a document'); },
	update(previous, transaction) {
		if (!transaction.docChanged && transaction.effects.some((effect) => effect.is(savedCheckpoint) && effect.value === previous.projection.document.version)) {
			return { ...previous, dirty: false, savedToken: previous.currentToken };
		}
		const direction = transaction.effects.find((effect) => effect.is(navigate))?.value;
		if (direction === 'undo' || direction === 'redo') {
			const stack = previous[direction];
			const entry = stack.at(-1);
			if (!entry) return previous;
			const token = direction === 'undo' ? entry.beforeToken : entry.afterToken;
			return { currentToken: token, savedToken: previous.savedToken, dirty: token !== previous.savedToken,
				projection: previous.projection.restore(direction === 'undo' ? entry.before : entry.after),
				undo: direction === 'undo' ? stack.slice(0, -1) : [...previous.undo, entry],
				redo: direction === 'undo' ? [...previous.redo, entry] : stack.slice(0, -1) };
		}
		if (!transaction.docChanged) return previous;
		const next = transaction.annotation(projected);
		if (!next) throw new Error('Unprojected source transaction');
		const token = Symbol();
		const entry: HistoryEntry = { beforeToken: previous.currentToken, afterToken: token, before: previous.projection, after: next,
			inverse: transaction.changes.invert(transaction.startState.doc), forward: transaction.changes,
			beforeSelection: transaction.startState.selection, afterSelection: transaction.newSelection };
		return { dirty: true, currentToken: token, savedToken: previous.savedToken,
			projection: next, undo: [...previous.undo.slice(-199), entry], redo: [] };
	}
});

/** Pure CodeMirror state integration, also exercised without a browser or mock view. */
export function createSourceState(document: SourceDocument, onRejected: (reason?: 'SOURCE_TOO_LARGE') => void = () => {}, extensions: Extension = []): EditorState {
	if (document.byteLength > sourceLimit) throw new Error('SOURCE_TOO_LARGE');
	const opened = EditorProjection.open(document);
	const token = Symbol();
	return EditorState.create({ doc: opened.text, extensions: [extensions,
		sourceState.init(() => ({ dirty: false, currentToken: token, savedToken: token, projection: opened.projection, undo: [], redo: [] })),
		EditorState.transactionFilter.of((transaction) => {
			if (!transaction.docChanged || transaction.effects.some((effect) => effect.is(navigate))) return transaction;
			const current = transaction.startState.field(sourceState).projection;
			const patches: EditorPatch[] = [];
			transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
				patches.push({ from, to, insert: inserted.toString() });
			});
			try {
				const next = current.apply(patches, current.document.version);
				if (next.document.byteLength > sourceLimit) { onRejected('SOURCE_TOO_LARGE'); return []; }
				const delta = patches.map((patch) => ({ from: current.toSource(patch.from), to: current.toSource(patch.to),
					insert: patch.insert.replaceAll('\n', current.document.profile.preferredLineEnding) }));
				return [transaction, { changes: next.editorCorrections, sequential: true,
					annotations: [projected.of(next), sourcePatches.of(delta)] }];
			} catch {
				onRejected();
				return [];
			}
		})
	] });
}

export function historyTransaction(state: EditorState, direction: 'undo' | 'redo') {
	const entry = state.field(sourceState)[direction].at(-1);
	if (!entry) return null;
	return state.update({ changes: direction === 'undo' ? entry.inverse : entry.forward,
		selection: direction === 'undo' ? entry.beforeSelection : entry.afterSelection,
		effects: navigate.of(direction), userEvent: direction });
}

export interface InsertionTarget { readonly documentId: string; readonly version: number; readonly from: number; readonly to: number }
export function insertionTarget(state: EditorState): InsertionTarget {
	const source = state.field(sourceState).projection.document;
	return { documentId: source.documentId, version: source.version, from: state.selection.main.from, to: state.selection.main.to };
}
export function rangeInsertionTarget(state: EditorState, span: SourceSpan): InsertionTarget {
	const projection = state.field(sourceState).projection, source = projection.document;
	if (span.documentId !== source.documentId || span.version !== source.version || span.from > span.to) throw new Error('STALE_INSERTION');
	const offset = (value: number) => {
		let low = 0, high = projection.length;
		while (low < high) { const middle = (low + high) >>> 1; if (projection.toSource(middle) < value) low = middle + 1; else high = middle; }
		if (projection.toSource(low) !== value) throw new Error('INSERTION_RANGE');
		return low;
	};
	return { documentId: source.documentId, version: source.version, from: offset(span.from), to: offset(span.to) };
}
/** Selection-only navigation preserves bytes, dirty checkpoint and shared undo. */
export function sourceNavigationTransaction(state: EditorState, span: SourceSpan) {
	if (state.readOnly) throw new Error('EDITOR_READ_ONLY');
	const target = rangeInsertionTarget(state, span);
	return state.update({ selection: { anchor: target.from }, scrollIntoView: true, userEvent: 'select.outline' });
}
/** Tools use the same transaction filter/history as typing; reject stale captured selections. */
export function insertionTransaction(state: EditorState, target: InsertionTarget, insert: string) {
	const source = state.field(sourceState).projection.document;
	if (target.documentId !== source.documentId || target.version !== source.version) throw new Error('STALE_INSERTION');
	if (insert.includes('\r')) throw new Error('INSERTION_EOL');
	return state.update({ changes: { from: target.from, to: target.to, insert },
		selection: { anchor: target.from + insert.length }, userEvent: 'input.tool' });
}

/** Visual tools replace their captured source span through the same CM history. */
export function visualInsertionTransaction(state: EditorState, span: SourceSpan, insert: string, inlineOnly = false) {
	const target = rangeInsertionTarget(state, span);
	const inline = insert.startsWith('\\(') && insert.endsWith('\\)') || insert.startsWith('$') && !insert.startsWith('$$') && insert.endsWith('$');
	if (inlineOnly && !inline) throw new Error('INSERTION_INLINE_ONLY');
	if (!inline) {
		const before = target.from > 0 ? state.doc.sliceString(target.from - 1, target.from) : '';
		const after = target.to < state.doc.length ? state.doc.sliceString(target.to, target.to + 1) : '';
		insert = (before && before !== '\n' && !insert.startsWith('\n') ? '\n' : '') + insert
			+ (after && after !== '\n' && !insert.endsWith('\n') ? '\n' : '');
	}
	return insertionTransaction(state, target, insert);
}

export function sourcePatchTransaction(state: EditorState, identity: { documentId: string; version: number }, patches: readonly SourcePatch[]) {
	if (state.readOnly) throw new Error('EDITOR_READ_ONLY');
	const projection = state.field(sourceState).projection, source = projection.document;
	if (source.documentId !== identity.documentId || source.version !== identity.version) throw new Error('STALE_VISUAL');
	const editorOffset = (offset: number) => {
		let low = 0, high = projection.length;
		while (low < high) { const middle = (low + high) >>> 1; if (projection.toSource(middle) < offset) low = middle + 1; else high = middle; }
		if (projection.toSource(low) !== offset) throw new Error('VISUAL_RANGE');
		return low;
	};
	let end = -1, previousFrom = -1;
	const changes = patches.map((patch) => {
		if (patch.from < end || patch.from <= previousFrom || patch.to < patch.from) throw new Error('VISUAL_RANGE');
		end = patch.to; previousFrom = patch.from;
		if (patch.expected === undefined || source.read(patch.from, patch.to) !== patch.expected) throw new Error('STALE_VISUAL');
		const insert = patch.insert.replace(/\r\n|\r/g, '\n');
		if (insert.replaceAll('\n', source.profile.preferredLineEnding) !== patch.insert) throw new Error('INSERTION_EOL');
		return { from: editorOffset(patch.from), to: editorOffset(patch.to), insert };
	});
	return state.update({ changes, userEvent: 'input.visual' });
}
