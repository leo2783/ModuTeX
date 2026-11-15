import type { EditorState, Transaction } from '@codemirror/state';
import { parseSource, type SourceDocument, type SourcePatch, type SourceProjection } from '../document-core/core.ts';
import { rangeInsertionTarget, sourceState } from '../source-editor/state.ts';
import { packagePlan } from '../tables/preamble.ts';
import { codeAt, codeSource, inheritedListingOptions } from './source.ts';
import { CODE_WRAPPING_PREAMBLE } from './latex.ts';

function preamblePatch(source: SourceDocument, parsed: SourceProjection): SourcePatch | null {
	const documents = parsed.nodes.filter(node => node.kind === 'environment' && node.name === 'document');
	const body = documents[0];
	if (documents.length !== 1 || !body?.content || parsed.issues.length) throw new Error('CODE_PREAMBLE_UNSUPPORTED');
	const eol = source.profile.preferredLineEnding;
	const preamble = source.read(0, body.span.from);
	const helperText = CODE_WRAPPING_PREAMBLE.replaceAll('\n', eol);
	const helper = parsed.nodes.some(node => node.kind === 'raw' && node.name === 'makeatletter' && node.span.from + helperText.length <= body.span.from && source.read(node.span.from, node.span.from + helperText.length) === helperText);
	const references = preamble.match(/ModuTeXCodeWrap/g)?.length ?? 0;
	if (references !== (helper ? 1 : 0)) throw new Error('CODE_PREAMBLE_UNSUPPORTED');
	const packageInsertion = packagePlan(source, parsed, 'listings');
	let insert = packageInsertion?.insert.replace(/\r\n|\r|\n/g, eol) ?? '';
	if (!helper) {
		const before = body.span.from ? source.read(body.span.from - 1, body.span.from) : '';
		if (!insert && before && !/[\r\n]/.test(before)) insert += eol;
		insert += helperText + eol;
	}
	return insert ? { from: body.span.from, to: body.span.from, expected: '', insert } : null;
}

/** Prepare supported listings in the document body and recognized column layouts. */
export function planCodeWrappingPatches(source: SourceDocument): readonly SourcePatch[] {
	const parsed = parseSource(source);
	const documents = parsed.nodes.filter(node => node.kind === 'environment' && node.name === 'document');
	if (documents.length !== 1 || !documents[0]?.content || parsed.issues.length) return [];
	const patches: SourcePatch[] = [];
	let supported = false;
	const pending = [...documents[0].children];
	while (pending.length) {
		const node = pending.pop()!;
		if (node.kind === 'environment' && ['multicols', 'multicols*'].includes(node.name)) {
			for (const child of node.children) pending.push(child);
			continue;
		}
		if (!node.content || !['verbatim', 'verbatim*', 'lstlisting'].includes(node.name)) continue;
		const located = codeAt(source, parsed, node.span.from);
		if (!located || located.draft.code.includes('\\end{lstlisting}')) continue;
		const raw = source.read(node.content.from, node.content.to);
		const firstEol = raw.search(/[\r\n]/);
		if (firstEol < 0 || (node.name !== 'lstlisting' && firstEol !== 0) || !/[\r\n]$/.test(raw)) continue;
		const headerEnd = node.content.from + firstEol;
		const header = located.inheritedListing ? '\\begin{lstlisting}' + inheritedListingOptions : codeSource('', located.starred, located.draft.language).split('\n')[0]!;
		const closing = '\\end{lstlisting}';
		const originalHeader = source.read(node.span.from, headerEnd);
		const originalClosing = source.read(node.content.to, node.span.to);
		if (originalClosing !== `\\end{${node.name}}`) continue;
		supported = true;
		if (header !== originalHeader) patches.push({ from: node.span.from, to: headerEnd, expected: originalHeader, insert: header });
		if (closing !== originalClosing) patches.push({ from: node.content.to, to: node.span.to, expected: originalClosing, insert: closing });
	}
	if (!supported) return [];
	try {
		const preamble = preamblePatch(source, parsed);
		if (preamble) patches.push(preamble);
	} catch { return []; }
	return patches.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Merge independent preparations into one guarded source transaction. */
export function mergePreparationPatches(...groups: readonly (readonly SourcePatch[])[]): readonly SourcePatch[] {
	const merged: SourcePatch[] = [];
	for (const patch of groups.flat().sort((a, b) => a.from - b.from || a.to - b.to)) {
		const previous = merged.at(-1);
		if (previous && previous.from === previous.to && patch.from === patch.to && previous.from === patch.from) {
			merged[merged.length - 1] = { ...previous, insert: previous.insert + patch.insert };
		} else {
			if (previous && patch.from < previous.to) throw new Error('CODE_PREPARATION_OVERLAP');
			merged.push(patch);
		}
	}
	return merged;
}

/** Code plus package/helper publication shares the original edit and undo entry. */
export function withCodePreamble(state: EditorState, transaction: Transaction): Transaction {
	if (!transaction.docChanged) return transaction;
	const source = state.field(sourceState).projection.document;
	const patch = preamblePatch(source, parseSource(source));
	if (!patch) return transaction;
	const target = rangeInsertionTarget(state, { documentId: source.documentId, version: source.version, from: patch.from, to: patch.to });
	const insert = patch.insert.replace(/\r\n|\r/g, '\n');
	const changes: { from: number; to: number; insert: string }[] = [];
	transaction.changes.iterChanges((from, to, _a, _b, value) => changes.push({ from, to, insert: value.toString() }));
	if (changes.some(change => change.from === target.from || change.from < target.from && change.to > target.from)) throw new Error('CODE_PREAMBLE_RANGE');
	changes.push({ from: target.from, to: target.to, insert });
	changes.sort((a, b) => a.from - b.from || a.to - b.to);
	const position = transaction.changes.mapPos(target.from, 1);
	const selection = transaction.newSelection.main.head + (position <= transaction.newSelection.main.head ? insert.length : 0);
	return state.update({ changes, selection: { anchor: selection }, userEvent: 'input.tool' });
}
