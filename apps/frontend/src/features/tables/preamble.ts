import { parseSource, projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan } from '@modutex/document-core';
import type { EditorState } from '@codemirror/state';
import { insertionTransaction, rangeInsertionTarget, sourceState, visualInsertionTransaction, type InsertionTarget } from '../source-editor/state.ts';

export interface PackagePlan { readonly span: SourceSpan; readonly insert: string }
/** Inspect current parser nodes, not arbitrary substrings in comments, macros or document text. */
export function booktabsPlan(source: SourceDocument, parsed: SourceProjection): PackagePlan | null {
	if (!projectionIsCurrent(source, parsed)) throw new Error('STALE_PREAMBLE');
	const documents = parsed.nodes.filter(node => node.kind === 'environment' && node.name === 'document');
	const body = documents[0];
	if (documents.length !== 1 || !body?.content || parsed.issues.some(issue => issue.offset < body.span.from)) throw new Error('PREAMBLE_UNSUPPORTED');
	for (const node of parsed.nodes) {
		if (node.span.from >= body.span.from) break;
		if (node.kind !== 'raw' || !['usepackage', 'RequirePackage'].includes(node.name)) continue;
		const command = source.read(node.span.from, node.span.to);
		const match = /^\\(?:usepackage|RequirePackage)\s*(?:\[[^\[\]\\%]*\]\s*)?\{([A-Za-z0-9_.-]+(?:\s*,\s*[A-Za-z0-9_.-]+)*)\}$/.exec(command);
		if (!match) throw new Error('PREAMBLE_UNSUPPORTED');
		if (match[1]!.split(',').some(name => name.trim() === 'booktabs')) return null;
	}
	const at = body.span.from;
	const before = at ? source.read(at - 1, at) : '';
	return { span: { documentId: source.documentId, version: source.version, from: at, to: at }, insert: (before && !/[\r\n]/.test(before) ? '\n' : '') + '\\usepackage{booktabs}\n' };
}

/** Package insertion and table replacement are one history entry, never a partial preamble write. */
export function tableInsertionTransaction(state: EditorState, target: InsertionTarget, text: string, plan?: PackagePlan | null,
	visual?: { readonly span: SourceSpan; readonly inlineOnly: boolean } | null) {
	if (visual) {
		const captured = rangeInsertionTarget(state, visual.span);
		if (captured.from !== target.from || captured.to !== target.to || captured.documentId !== target.documentId || captured.version !== target.version) throw new Error('STALE_INSERTION');
	}
	if (!plan) return visual ? visualInsertionTransaction(state, visual.span, text, visual.inlineOnly) : insertionTransaction(state, target, text);
	const source = state.field(sourceState).projection.document;
	if (target.documentId !== source.documentId || target.version !== source.version) throw new Error('STALE_INSERTION');
	const packageTarget = rangeInsertionTarget(state, plan.span);
	const expected = booktabsPlan(source, parseSource(source));
	if (!expected || plan.span.from !== expected.span.from || plan.span.to !== expected.span.to || plan.insert !== expected.insert || packageTarget.from >= target.from) throw new Error('PREAMBLE_RANGE');
	// Reuse the visual tool's exact boundary and readonly policy, but do not dispatch its intermediate state.
	const table = visual ? visualInsertionTransaction(state, visual.span, text, visual.inlineOnly) : insertionTransaction(state, target, text);
	if (!table.docChanged) return table;
	const changes: { from: number; to: number; insert: string }[] = [{ from: packageTarget.from, to: packageTarget.to, insert: plan.insert }];
	table.changes.iterChanges((from, to, _newFrom, _newTo, value) => changes.push({ from, to, insert: value.toString() }));
	return state.update({ changes, selection: { anchor: table.newSelection.main.head + plan.insert.length }, userEvent: 'input.tool' });
}
