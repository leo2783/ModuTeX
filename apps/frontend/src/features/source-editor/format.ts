import { ChangeSet, type EditorState } from '@codemirror/state';
import { projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan, type SyntaxNode } from '@modutex/document-core';
import { rangeInsertionTarget, sourceState } from './state.ts';

export type TextFormat = 'strong' | 'em' | 'underline';
const commands = { strong: 'textbf', em: 'textit', underline: 'underline' } as const;
const formats: Record<string, TextFormat> = { textbf: 'strong', textit: 'em', emph: 'em', underline: 'underline' };

/** Find a source range contained by exactly one decoded text leaf under known format nodes. */
function selectedTextPath(root: SyntaxNode, from: number, to: number): SyntaxNode[] | null {
	const paths: SyntaxNode[][] = [];
	const visit = (node: SyntaxNode, wrappers: readonly SyntaxNode[]) => {
		if (node.kind === 'text') {
			if (node.span.from <= from && node.span.to >= to) paths.push([...wrappers, node]);
			return;
		}
		if (node.kind !== 'format' || !node.content || !Object.hasOwn(formats, node.name)) return;
		const next = [...wrappers, node];
		for (const child of node.children) visit(child, next);
	};
	visit(root, []);
	return paths.length === 1 ? paths[0] ?? null : null;
}

/** Reject non-text siblings and any syntax other than known format wrappers on the selected path. */
function isSafeNestedTextPath(root: SyntaxNode, path: readonly SyntaxNode[]): boolean {
	const leaf = path[path.length - 1];
	const visit = (node: SyntaxNode, index: number): boolean => {
		if (node === leaf) return node.kind === 'text';
		if (node.kind === 'text') return true;
		if (node !== path[index] || node.kind !== 'format' || !node.content || !Object.hasOwn(formats, node.name)) return false;
		const next = path[index + 1];
		if (!next) return false;
		let found = false;
		for (const child of node.children) {
			if (child === next) {
				if (found || !visit(child, index + 1)) return false;
				found = true;
			} else if (child.kind !== 'text') return false;
		}
		return found;
	};
	return path.length >= 3 && path[0] === root && visit(root, 0);
}

function hasTextBefore(node: SyntaxNode, position: number): boolean {
	if (node.kind === 'text') return node.span.from < position && node.span.to > node.span.from;
	return node.children.some((child) => hasTextBefore(child, position));
}

function hasTextAfter(node: SyntaxNode, position: number): boolean {
	if (node.kind === 'text') return node.span.to > position && node.span.to > node.span.from;
	return node.children.some((child) => hasTextAfter(child, position));
}

function isPrefix(flags: readonly boolean[]): boolean {
	let ended = false;
	for (const flag of flags) {
		if (!flag) ended = true;
		else if (ended) return false;
	}
	return true;
}

/** Split only the selected wrapper path; all other source bytes remain untouched. */
function cancelNestedFormat(state: EditorState, enclosing: SyntaxNode, path: readonly SyntaxNode[],
	sourceFrom: number, sourceTo: number, editorFrom: number, editorTo: number) {
	if (!isSafeNestedTextPath(enclosing, path) || !enclosing.content) throw new Error('FORMAT_RANGE');
	const projection = state.field(sourceState).projection, source = projection.document;
	const wrappers = path.slice(0, -1), descendants = wrappers.slice(1);
	const left = hasTextBefore(enclosing, sourceFrom), right = hasTextAfter(enclosing, sourceTo);
	const leftFlags = descendants.map((node) => hasTextBefore(node, sourceFrom));
	const rightFlags = descendants.map((node) => hasTextAfter(node, sourceTo));
	if (!isPrefix(leftFlags) || !isPrefix(rightFlags) || !left && leftFlags.some(Boolean) || !right && rightFlags.some(Boolean)) {
		throw new Error('FORMAT_RANGE');
	}

	const editorRange = (from: number, to: number) => rangeInsertionTarget(state, {
		documentId: source.documentId, version: source.version, from, to
	});
	const opening = (node: SyntaxNode) => source.read(node.span.from, node.content!.from).replace(/\r\n|\r/g, '\n');
	const changes: { from: number; to: number; insert: string }[] = [];
	const insertAt = (position: number, insert: string) => {
		if (!insert) return;
		const at = editorRange(position, position).from;
		changes.push({ from: at, to: at, insert });
	};

	if (left) {
		const leftDescendants = descendants.filter((_node, index) => leftFlags[index]);
		const firstWithoutLeft = descendants.find((_node, index) => !leftFlags[index]);
		const at = firstWithoutLeft?.span.from ?? sourceFrom;
		insertAt(at, '}'.repeat(leftDescendants.length + 1) + leftDescendants.map(opening).join(''));
	} else {
		const whole = editorRange(enclosing.span.from, enclosing.span.to);
		const inner = editorRange(enclosing.content.from, enclosing.content.to);
		changes.push({ from: whole.from, to: inner.from, insert: '' });
	}

	if (right) {
		const rightDescendants = descendants.filter((_node, index) => rightFlags[index]);
		const firstWithoutRight = descendants.find((_node, index) => !rightFlags[index]);
		const at = firstWithoutRight?.span.to ?? sourceTo;
		insertAt(at, '}'.repeat(rightDescendants.length) + opening(enclosing) + rightDescendants.map(opening).join(''));
	} else {
		const whole = editorRange(enclosing.span.from, enclosing.span.to);
		const inner = editorRange(enclosing.content.from, enclosing.content.to);
		changes.push({ from: inner.to, to: whole.to, insert: '' });
	}

	changes.sort((a, b) => a.from - b.from || a.to - b.to);
	const changeSet = ChangeSet.of(changes, state.doc.length);
	return state.update({ changes,
		selection: { anchor: changeSet.mapPos(editorFrom, 1), head: changeSet.mapPos(editorTo, -1) },
		userEvent: 'input.format' });
}

interface InlineTextLeaf {
	readonly node: SyntaxNode;
	readonly wrappers: readonly SyntaxNode[];
}
interface InlineRange { readonly leaves: readonly InlineTextLeaf[] }
interface SourceEdit { readonly from: number; readonly to: number; readonly insert: string }
interface TargetGroup { readonly node: SyntaxNode; readonly leaves: InlineTextLeaf[] }

/**
 * Collect a safe inline range. Only text and known format wrappers are transparent;
 * headings are a boundary, and other syntax is deliberately opaque.
 */
function collectInlineRange(nodes: readonly SyntaxNode[], source: SourceDocument, from: number, to: number): InlineRange | null {
	if (from >= to) return null;
	const leaves: InlineTextLeaf[] = [];
	let invalid = false, heading: SyntaxNode | null = null;
	const visit = (node: SyntaxNode, wrappers: readonly SyntaxNode[]) => {
		if (invalid || node.span.to <= from || node.span.from >= to) return;
		if (node.kind === 'text') { leaves.push({ node, wrappers }); return; }
		if (node.kind === 'format') {
			if (!node.content || !Object.hasOwn(formats, node.name)) { invalid = true; return; }
			const next = [...wrappers, node];
			for (const child of node.children) visit(child, next);
			return;
		}
		if (node.kind === 'heading') {
			if (node.span.from > from || node.span.to < to || heading && heading !== node) { invalid = true; return; }
			heading = node;
			for (const child of node.children) visit(child, wrappers);
			return;
		}
		if (node.kind === 'environment' && node.name === 'document') {
			for (const child of node.children) visit(child, wrappers);
			return;
		}
		invalid = true;
	};
	for (const node of nodes) visit(node, []);
	if (invalid || !leaves.length) return null;
	leaves.sort((a, b) => a.node.span.from - b.node.span.from);
	const first = leaves.find(({ node }) => node.span.from <= from && node.span.to > from);
	const last = leaves.find(({ node }) => node.span.from < to && node.span.to >= to);
	if (!first || !last) return null;
	if (hasParagraphBreak(source.read(from, to))) return null;
	return { leaves };
}

function isKnownTextTree(node: SyntaxNode): boolean {
	if (node.kind === 'text') return true;
	return node.kind === 'format' && !!node.content && Object.hasOwn(formats, node.name) &&
		node.children.every(isKnownTextTree);
}

/** \emph toggles emphasis; \textit establishes it. They are not interchangeable under nesting. */
function formatIsActive(wrappers: readonly SyntaxNode[], format: TextFormat): boolean {
	if (format !== 'em') return wrappers.some((node) => formats[node.name] === format);
	let active = false;
	for (const node of wrappers) {
		if (node.name === 'textit') active = true;
		else if (node.name === 'emph') active = !active;
	}
	return active;
}

function formatIsActiveWithout(wrappers: readonly SyntaxNode[], format: TextFormat, omitted: SyntaxNode): boolean {
	return formatIsActive(wrappers.filter((node) => node !== omitted), format);
}

function canCancelWrapper(range: InlineRange | null, wrapper: SyntaxNode, format: TextFormat): boolean {
	if (format !== 'em' || !range) return true;
	return range.leaves.length > 0 && range.leaves.every((leaf) =>
		formatIsActive(leaf.wrappers, format) && !formatIsActiveWithout(leaf.wrappers, format, wrapper));
}

function sourceEditsTransaction(state: EditorState, edits: readonly SourceEdit[], editorFrom: number, editorTo: number) {
	const source = state.field(sourceState).projection.document;
	const mapped = edits.filter((edit) => edit.from !== edit.to || edit.insert).map((edit) => {
		const target = rangeInsertionTarget(state, {
			documentId: source.documentId, version: source.version, from: edit.from, to: edit.to
		});
		return { from: target.from, to: target.to, insert: edit.insert };
	}).sort((a, b) => a.from - b.from || a.to - b.to);
	const changes: { from: number; to: number; insert: string }[] = [];
	for (const change of mapped) {
		const previous = changes[changes.length - 1];
		if (previous && previous.from === change.from && previous.from === previous.to) {
			if (change.from === change.to) { previous.insert += change.insert; continue; }
			if (change.to > change.from) { previous.to = change.to; previous.insert += change.insert; continue; }
		}
		if (previous && change.from < previous.to) throw new Error('FORMAT_RANGE');
		changes.push(change);
	}
	if (!changes.length) throw new Error('FORMAT_RANGE');
	const changeSet = ChangeSet.of(changes, state.doc.length);
	return state.update({ changes,
		selection: { anchor: changeSet.mapPos(editorFrom, 1), head: changeSet.mapPos(editorTo, -1) },
		userEvent: 'input.format' });
}

function cancellationEdits(source: SourceDocument, enclosing: SyntaxNode,
	startDescendants: readonly SyntaxNode[] | null, endDescendants: readonly SyntaxNode[] | null,
	from: number, to: number): SourceEdit[] {
	if (!enclosing.content) throw new Error('FORMAT_RANGE');
	const left = hasTextBefore(enclosing, from), right = hasTextAfter(enclosing, to);
	if (left && !startDescendants || right && !endDescendants) throw new Error('FORMAT_RANGE');
	const startPath = startDescendants ?? [], endPath = endDescendants ?? [];
	const leftFlags = startPath.map((node) => hasTextBefore(node, from));
	const rightFlags = endPath.map((node) => hasTextAfter(node, to));
	if (!isPrefix(leftFlags) || !isPrefix(rightFlags) ||
		!left && leftFlags.some(Boolean) || !right && rightFlags.some(Boolean)) throw new Error('FORMAT_RANGE');

	const opening = (node: SyntaxNode) => source.read(node.span.from, node.content!.from).replace(/\r\n|\r/g, '\n');
	const edits: SourceEdit[] = [];
	if (left) {
		const keepOpen = startPath.filter((_node, index) => leftFlags[index]);
		const firstWithoutLeft = startPath.find((_node, index) => !leftFlags[index]);
		const at = firstWithoutLeft?.span.from ?? from;
		edits.push({ from: at, to: at, insert: '}'.repeat(keepOpen.length + 1) + keepOpen.map(opening).join('') });
	} else edits.push({ from: enclosing.span.from, to: enclosing.content.from, insert: '' });

	if (right) {
		const keepOpen = endPath.filter((_node, index) => rightFlags[index]);
		const firstWithoutRight = endPath.find((_node, index) => !rightFlags[index]);
		const at = firstWithoutRight?.span.to ?? to;
		edits.push({ from: at, to: at, insert: '}'.repeat(keepOpen.length) + opening(enclosing) + keepOpen.map(opening).join('') });
	} else edits.push({ from: enclosing.content.to, to: enclosing.span.to, insert: '' });
	return edits;
}

function descendantsBelow(leaf: InlineTextLeaf, enclosing: SyntaxNode): readonly SyntaxNode[] {
	const index = leaf.wrappers.indexOf(enclosing);
	if (index < 0) throw new Error('FORMAT_RANGE');
	return leaf.wrappers.slice(index + 1);
}

function cancelEnclosingRange(state: EditorState, range: InlineRange, enclosing: SyntaxNode,
	from: number, to: number, editorFrom: number, editorTo: number) {
	if (!isKnownTextTree(enclosing)) throw new Error('FORMAT_RANGE');
	const left = hasTextBefore(enclosing, from), right = hasTextAfter(enclosing, to);
	const startLeaf = left ? range.leaves.find(({ node, wrappers }) =>
		node.span.from <= from && node.span.to > from && wrappers.includes(enclosing)) : undefined;
	const endLeaf = right ? range.leaves.find(({ node, wrappers }) =>
		node.span.from < to && node.span.to >= to && wrappers.includes(enclosing)) : undefined;
	if (left && !startLeaf || right && !endLeaf) throw new Error('FORMAT_RANGE');
	const source = state.field(sourceState).projection.document;
	return sourceEditsTransaction(state, cancellationEdits(source, enclosing,
		startLeaf ? descendantsBelow(startLeaf, enclosing) : null,
		endLeaf ? descendantsBelow(endLeaf, enclosing) : null, from, to), editorFrom, editorTo);
}

function adjacentTargetGroups(range: InlineRange, format: TextFormat): TargetGroup[] | null {
	const groups = new Map<SyntaxNode, InlineTextLeaf[]>();
	for (const leaf of range.leaves) {
		const target = leaf.wrappers.find((node) => formats[node.name] === format &&
			(format !== 'em' || !formatIsActiveWithout(leaf.wrappers, format, node)));
		if (!target) return null;
		const group = groups.get(target);
		if (group) group.push(leaf);
		else groups.set(target, [leaf]);
	}
	const ordered = [...groups].map(([node, leaves]) => ({ node, leaves })).sort((a, b) => a.node.span.from - b.node.span.from);
	let previousEnd = -1;
	for (const { node, leaves } of ordered) {
		if (node.span.from < previousEnd || format === 'em' &&
			leaves.some((leaf) => formatIsActiveWithout(leaf.wrappers, format, node))) throw new Error('FORMAT_RANGE');
		previousEnd = node.span.to;
	}
	return ordered;
}

function cancelAdjacentTargets(state: EditorState, range: InlineRange, groups: readonly TargetGroup[],
	from: number, to: number, editorFrom: number, editorTo: number) {
	const source = state.field(sourceState).projection.document;
	const edits: SourceEdit[] = [];
	for (const { node, leaves } of groups) {
		if (!isKnownTextTree(node)) throw new Error('FORMAT_RANGE');
		const left = hasTextBefore(node, from), right = hasTextAfter(node, to);
		const startLeaf = left ? leaves.find(({ node: leaf, wrappers }) =>
			leaf.span.from <= from && leaf.span.to > from && wrappers.includes(node)) : undefined;
		const endLeaf = right ? leaves.find(({ node: leaf, wrappers }) =>
			leaf.span.from < to && leaf.span.to >= to && wrappers.includes(node)) : undefined;
		if (left && !startLeaf || right && !endLeaf) throw new Error('FORMAT_RANGE');
		edits.push(...cancellationEdits(source, node,
			startLeaf ? descendantsBelow(startLeaf, node) : null,
			endLeaf ? descendantsBelow(endLeaf, node) : null, from, to));
	}
	return sourceEditsTransaction(state, edits, editorFrom, editorTo);
}

function applyInlineRange(state: EditorState, range: InlineRange, format: TextFormat,
	from: number, to: number, editorFrom: number, editorTo: number) {
	const first = range.leaves[0], last = range.leaves[range.leaves.length - 1];
	if (!first || !last) throw new Error('FORMAT_RANGE');
	const source = state.field(sourceState).projection.document;
	const opening = (node: SyntaxNode) => source.read(node.span.from, node.content!.from).replace(/\r\n|\r/g, '\n');
	const leftFlags = first.wrappers.map((node) => hasTextBefore(node, from));
	const rightFlags = last.wrappers.map((node) => hasTextAfter(node, to));
	if (!isPrefix(leftFlags) || !isPrefix(rightFlags)) throw new Error('FORMAT_RANGE');
	const left = first.wrappers.filter((_node, index) => leftFlags[index]);
	const firstWithoutLeft = first.wrappers.find((_node, index) => !leftFlags[index]);
	const start = firstWithoutLeft?.span.from ?? from;
	const right = last.wrappers.filter((_node, index) => rightFlags[index]);
	const firstWithoutRight = last.wrappers.find((_node, index) => !rightFlags[index]);
	const end = firstWithoutRight?.span.to ?? to;
	const edits: SourceEdit[] = [
		{ from: start, to: start, insert: '}'.repeat(left.length) + '\\' + commands[format] + '{' + left.map(opening).join('') },
		{ from: end, to: end, insert: '}'.repeat(right.length + 1) + right.map(opening).join('') }
	];
	return sourceEditsTransaction(state, edits, editorFrom, editorTo);
}

export function formatShortcut(event: KeyboardEvent): TextFormat | null {
	if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.shiftKey || event.ctrlKey === event.metaKey) return null;
	return ({ b: 'strong', i: 'em', u: 'underline' } as Record<string, TextFormat>)[event.key.toLowerCase()] ?? null;
}

/** Explicit source command: preserve existing bytes with boundary-only edits. */
function hasParagraphBreak(text: string): boolean {
	// Normalize only this inspection string: CRLF is one line ending, not two.
	return /\n[ \t]*\n/.test(text.replace(/\r\n|\r/g, '\n'));
}

export function formatTransaction(state: EditorState, parsed: SourceProjection, format: TextFormat, span?: SourceSpan) {
	if (state.readOnly) throw new Error('EDITOR_READ_ONLY');
	const projection = state.field(sourceState).projection, source = projection.document;
	if (!projectionIsCurrent(source, parsed) || span && (span.documentId !== source.documentId || span.version !== source.version)) throw new Error('STALE_FORMAT');
	if (!Object.hasOwn(commands, format)) throw new Error('FORMAT_KIND');
	const selection = span ? rangeInsertionTarget(state, span) : state.selection.main;
	const from = projection.toSource(selection.from), to = projection.toSource(selection.to);
	if (selection.from !== selection.to && hasParagraphBreak(source.read(from, to))) throw new Error('FORMAT_RANGE');
	const match: { wrapper: SyntaxNode | null; enclosing: SyntaxNode | null; plain: boolean } = { wrapper: null, enclosing: null, plain: false };
	const visit = (nodes: readonly SyntaxNode[]) => {
		for (const node of nodes) {
			if (node.span.from > from || node.span.to < to) continue;
			if (node.kind === 'text' && (from !== to || from < node.span.to || from === source.length)) match.plain = true;
			if (node.kind === 'format' && node.content && formats[node.name] && ((from === node.span.from && to === node.span.to) || (from === node.content.from && to === node.content.to))) {
				if (!match.wrapper || formats[match.wrapper.name] !== format || formats[node.name] === format) match.wrapper = node;
			}
			if (node.kind === 'format' && node.content && formats[node.name] === format && from >= node.content.from && to <= node.content.to) match.enclosing = node;
			if (node.kind === 'format' || node.kind === 'heading' || node.kind === 'environment' && node.name === 'document') visit(node.children);
		}
	};
	visit(parsed.nodes);
	const wrapper = match.wrapper;
	const inlineRange = selection.from === selection.to ? null : collectInlineRange(parsed.nodes, source, from, to);
	if (!match.plain && !wrapper && !inlineRange) throw new Error('FORMAT_RANGE');
	if (wrapper && wrapper.content && formats[wrapper.name] === format && canCancelWrapper(inlineRange, wrapper, format)) {
		const whole = rangeInsertionTarget(state, wrapper.span), inner = rangeInsertionTarget(state, wrapper.content);
		return state.update({ changes: [{ from: whole.from, to: inner.from, insert: '' }, { from: inner.to, to: whole.to, insert: '' }],
			selection: { anchor: whole.from, head: whole.from + inner.to - inner.from }, userEvent: 'input.format' });
	}
	if (selection.from !== selection.to && match.enclosing?.content && canCancelWrapper(inlineRange, match.enclosing, format)) {
		const enclosing = match.enclosing;
		if (!enclosing.children.every(node => node.kind === 'text')) {
			if (inlineRange && inlineRange.leaves.length > 1) {
				return cancelEnclosingRange(state, inlineRange, enclosing, from, to, selection.from, selection.to);
			}
			const path = selectedTextPath(enclosing, from, to);
			if (!path) throw new Error('FORMAT_RANGE');
			return cancelNestedFormat(state, enclosing, path, from, to, selection.from, selection.to);
		}
		const whole = rangeInsertionTarget(state, enclosing.span), inner = rangeInsertionTarget(state, enclosing.content!);
		const opening = source.read(enclosing.span.from, enclosing.content!.from).replace(/\r\n|\r/g, '\n');
		const keepLeft = selection.from > inner.from, keepRight = selection.to < inner.to;
		const changes = [keepLeft ? { from: selection.from, insert: '}' } : { from: whole.from, to: inner.from, insert: '' },
			keepRight ? { from: selection.to, insert: opening } : { from: inner.to, to: whole.to, insert: '' }];
		const start = keepLeft ? selection.from + 1 : whole.from;
		return state.update({ changes, selection: { anchor: start, head: start + selection.to - selection.from }, userEvent: 'input.format' });
	}
	if (selection.from !== selection.to && inlineRange && (!match.plain || inlineRange.leaves.length > 1)) {
		const allActive = inlineRange.leaves.every((leaf) => formatIsActive(leaf.wrappers, format));
		if (allActive) {
			const groups = adjacentTargetGroups(inlineRange, format);
			if (groups) return cancelAdjacentTargets(state, inlineRange, groups, from, to, selection.from, selection.to);
		}
		return applyInlineRange(state, inlineRange, format, from, to, selection.from, selection.to);
	}
	const opening = '\\' + commands[format] + '{';
	const changes = selection.from === selection.to ? { from: selection.from, insert: opening + '}' } : [{ from: selection.from, insert: opening }, { from: selection.to, insert: '}' }];
	return state.update({ changes, selection: { anchor: selection.from + opening.length, head: selection.to + opening.length }, userEvent: 'input.format' });
}
