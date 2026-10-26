import { parseSource, projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan } from '../document-core/core.ts';
import type { EditorState } from '@codemirror/state';
import type { Transaction } from '@codemirror/state';
import { insertionTransaction, rangeInsertionTarget, sourceState, visualInsertionTransaction, type InsertionTarget } from '../source-editor/state.ts';

export interface PackagePlan { readonly span: SourceSpan; readonly insert: string }
/** Apply a required package in the same source history entry as the content. */
export function withPackage(state: EditorState, transaction: Transaction, name: 'amsmath' | 'listings' | 'graphicx' | readonly ('amsmath' | 'amssymb')[]): Transaction {
	if (!transaction.docChanged) return transaction;
	const source = state.field(sourceState).projection.document;
	const parsed = parseSource(source);
	const plans = (typeof name === 'string' ? [name] : [...new Set(name)]).map(value => packagePlan(source, parsed, value)).filter((plan): plan is PackagePlan => plan !== null);
	if (!plans.length) return transaction;
	const target = rangeInsertionTarget(state, plans[0]!.span);
	const insert = plans.map(plan => plan.insert).join('');
	if (target.from !== target.to) throw new Error('PREAMBLE_RANGE');
	const changes: { from: number; to: number; insert: string }[] = [];
	transaction.changes.iterChanges((from, to, _a, _b, value) => changes.push({ from, to, insert: value.toString() }));
	if (changes.some(change => change.from === target.from || change.from < target.from && change.to > target.from)) throw new Error('PREAMBLE_RANGE');
	changes.push({ from: target.from, to: target.to, insert });
	changes.sort((left, right) => left.from - right.from || left.to - right.to);
	const packagePosition = transaction.changes.mapPos(target.from, 1);
	const selection = transaction.newSelection.main.head + (packagePosition <= transaction.newSelection.main.head ? insert.length : 0);
	return state.update({ changes, selection: { anchor: selection }, userEvent: 'input.tool' });
}
/** Inspect current parser nodes, not arbitrary substrings in comments, macros or document text. */
export function booktabsPlan(source: SourceDocument, parsed: SourceProjection): PackagePlan | null {
	return packagePlan(source, parsed, 'booktabs');
}
export function packagePlan(source: SourceDocument, parsed: SourceProjection, name: 'booktabs' | 'xcolor' | 'amsmath' | 'amssymb' | 'listings' | 'graphicx'): PackagePlan | null {
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
		if (match[1]!.split(',').some(value => value.trim() === name)) return null;
	}
	const at = body.span.from;
	const before = at ? source.read(at - 1, at) : '';
	return { span: { documentId: source.documentId, version: source.version, from: at, to: at }, insert: (before && !/[\r\n]/.test(before) ? '\n' : '') + `\\usepackage{${name}}\n` };
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
