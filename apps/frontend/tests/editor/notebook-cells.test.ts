import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EditorView as CodeMirrorView } from '@codemirror/view';
import type { Node as VisualNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, historyTransaction, sourcePatchTransaction, sourceState } from '../../src/features/source-editor/state.ts';
import { createTable, tableSource } from '../../src/features/tables/source.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

function installDOM(): { dom: InstanceType<typeof JSDOM>; restore(): void } {
	const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'AbortController', 'AbortSignal', 'HTMLMediaElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key]
		});
	}
	return {
		dom,
		restore() {
			dom.window.close();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	};
}

type CellAction = 'delete' | 'move-up' | 'move-down';
interface ActionRequest { readonly action: CellAction; readonly span: SourceSpan; readonly adjacent?: SourceSpan }
interface InsertRequest {
	readonly kind: 'text' | 'equation' | 'matrix' | 'table';
	readonly span: SourceSpan;
	readonly beforeText: boolean;
}
interface VisualBlock {
	readonly node: VisualNode;
	readonly index: number;
	readonly position: number;
	readonly span: SourceSpan;
}
interface MountedEditor {
	readonly dom: InstanceType<typeof JSDOM>;
	readonly original: SourceDocument;
	readonly sourceView: CodeMirrorView;
	readonly visual: VisualEditor;
	readonly actions: ActionRequest[];
	readonly insertions: InsertRequest[];
	source(): SourceDocument;
	blocks(): VisualBlock[];
	sync(): void;
	dispose(): void;
}

const bytesWithBom = (source: string) => new TextEncoder().encode(`\uFEFF${source}`);

function mount(sourceText: string): MountedEditor {
	const { dom, restore } = installDOM();
	dom.window.document.body.innerHTML = '<div id="source"></div><div id="visual"></div>';
	const sourceTarget = dom.window.document.getElementById('source')!;
	const visualTarget = dom.window.document.getElementById('visual')!;
	const original = SourceDocument.open(bytesWithBom(sourceText));
	const sourceView = new CodeMirrorView({ parent: sourceTarget, state: createSourceState(original) });
	const actions: ActionRequest[] = [];
	const insertions: InsertRequest[] = [];
	let visual: VisualEditor | null = null;
	let rejected = 0;
	const source = () => sourceView.state.field(sourceState).projection.document;
	const live = (span: SourceSpan, current: SourceDocument) =>
		span.documentId === current.documentId && span.version === current.version &&
		Number.isSafeInteger(span.from) && Number.isSafeInteger(span.to) &&
		span.from >= 0 && span.from <= span.to && span.to <= current.length;
	const publish = (
		identity: { readonly documentId: string; readonly version: number },
		patches: Parameters<typeof sourcePatchTransaction>[2]
	) => {
		sourceView.dispatch(sourcePatchTransaction(sourceView.state, identity, patches));
		const next = source();
		visual?.sync(parseSource(next));
		visual?.refresh();
		return next;
	};
	visual = new VisualEditor(visualTarget, 'notebook.tex', {
		source,
		apply: (identity, patches) => {
			sourceView.dispatch(sourcePatchTransaction(sourceView.state, identity, patches));
			return source();
		},
		applyValidated: (identity, patches, validateNextSource) => {
			const transaction = sourcePatchTransaction(sourceView.state, identity, patches);
			validateNextSource(transaction.state.field(sourceState).projection.document);
			sourceView.dispatch(transaction);
			return source();
		},
		history: (direction) => {
			const transaction = historyTransaction(sourceView.state, direction);
			if (!transaction) return false;
			sourceView.dispatch(transaction);
			return true;
		},
		readOnly: () => false,
		rejected: () => rejected++,
		status: () => {},
		locale: () => 'en',
		cellAction: (action, span, adjacent) => {
			actions.push({ action, span, adjacent });
			const current = source();
			if (!live(span, current) || adjacent && !live(adjacent, current)) return;

			if (action === 'delete') {
				publish(span, [{
					from: span.from, to: span.to,
					expected: current.read(span.from, span.to), insert: ''
				}]);
				return;
			}
			if (!adjacent || span.from === adjacent.from && span.to === adjacent.to) return;
			const [left, right] = span.from < adjacent.from ? [span, adjacent] : [adjacent, span];
			const leftText = current.read(left.from, left.to);
			const rightText = current.read(right.from, right.to);
			publish(span, [
				{ from: left.from, to: left.to, expected: leftText, insert: rightText },
				{ from: right.from, to: right.to, expected: rightText, insert: leftText }
			]);
		},
		insertBlock: (kind, span, beforeText) => {
			insertions.push({ kind, span, beforeText });
			const current = source();
			if (kind !== 'text' || !live(span, current) || span.from !== span.to) return;
			const marker = `\\par${current.profile.preferredLineEnding}`;
			publish(span, [{ from: span.from, to: span.to, expected: '', insert: marker }]);
		}
	});
	visual.sync(parseSource(original));

	return {
		dom, original, sourceView, visual, actions, insertions, source,
		blocks() {
			const current = source();
			const result: VisualBlock[] = [];
			visual!.view.state.doc.forEach((node, position, index) => {
				assert.equal(typeof node.attrs.from, 'number');
				assert.equal(typeof node.attrs.to, 'number');
				result.push({
					node, position, index,
					span: {
						documentId: current.documentId, version: current.version,
						from: node.attrs.from as number, to: node.attrs.to as number
					}
				});
			});
			return result;
		},
		sync() {
			const current = source();
			visual!.sync(parseSource(current));
			visual!.refresh();
		},
		dispose() {
			visual!.dispose();
			sourceView.destroy();
			restore();
		}
	};
}

function findBlock(mounted: MountedEditor, matches: (node: VisualNode) => boolean): VisualBlock {
	const found = mounted.blocks().filter(({ node }) => matches(node));
	assert.equal(found.length, 1, 'expected one matching visual cell');
	return found[0]!;
}

function buttonName(button: HTMLButtonElement): string {
	return [button.getAttribute('aria-label'), button.title, button.textContent]
		.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function matchingButtons(root: Element, pattern: RegExp): HTMLButtonElement[] {
	return Array.from(root.querySelectorAll('button')).filter((button) => pattern.test(buttonName(button)));
}

/** Prefer controls belonging to the requested ProseMirror cell; fall back to view-order controls. */
function findCellButton(mounted: MountedEditor, block: VisualBlock, pattern: RegExp): HTMLButtonElement | null {
	const root = mounted.visual.view.dom;
	const nodeDOM = mounted.visual.view.nodeDOM(block.position);
	let ancestor: HTMLElement | null = nodeDOM?.nodeType === 1 ? nodeDOM as HTMLElement : nodeDOM?.parentElement ?? null;
	while (ancestor && ancestor !== root) {
		const local = matchingButtons(ancestor, pattern).find((button) => !button.disabled);
		if (local) return local;
		ancestor = ancestor.parentElement;
	}
	const candidates = matchingButtons(root, pattern);
	if (!candidates.length) return null;
	if (candidates.length === 1) return candidates[0]!;
	if (candidates.length === mounted.blocks().length) return candidates[block.index] ?? null;
	return candidates.find((button) => !button.disabled) ?? candidates[0]!;
}

function clickCellButton(mounted: MountedEditor, block: VisualBlock, pattern: RegExp): HTMLButtonElement {
	const button = findCellButton(mounted, block, pattern);
	assert.ok(button, `expected a cell control matching ${pattern}`);
	assert.equal(button.disabled, false, `expected the cell control matching ${pattern} to be enabled`);
	button.click();
	return button;
}

function clickTextInsertion(mounted: MountedEditor, block: VisualBlock, placement: 'above' | 'below'): void {
	assert.equal(mounted.visual.navigate(block.span), true);
	const count = mounted.insertions.length;
	const direct = findCellButton(mounted, block, new RegExp(
		`(?:insert|add).*\\btext\\b.*\\b${placement}\\b|(?:insert|add).*\\b${placement}\\b.*\\btext\\b`, 'i'
	));
	if (direct && !direct.disabled) {
		direct.click();
		if (mounted.insertions.length > count) return;
	}

	const chooseText = () => {
		const menu = mounted.visual.view.dom.querySelector('.cell-insert-wrap.open');
		if (!menu) return false;
		const item = matchingButtons(menu, /text/i).find((button) =>
			/^text$/i.test(button.textContent?.trim() ?? '') ||
			/^文字$/.test(button.textContent?.trim() ?? '') ||
			/\btext paragraph\b/i.test(button.title)
		);
		if (!item || item.disabled) return false;
		item.click();
		return mounted.insertions.length > count;
	};
	if (chooseText()) return;

	const placementButton = findCellButton(mounted, block, new RegExp(`\\b${placement}\\b`, 'i'));
	assert.ok(placementButton, `expected an insert-${placement} cell control`);
	assert.equal(placementButton.disabled, false);
	placementButton.click();
	if (!chooseText()) assert.equal(mounted.insertions.length, count + 1, 'text insertion should be dispatched immediately');
}

function undoAndSync(mounted: MountedEditor): SourceDocument {
	const transaction = historyTransaction(mounted.sourceView.state, 'undo');
	assert.ok(transaction, 'the cell action should create one shared CodeMirror undo step');
	mounted.sourceView.dispatch(transaction);
	mounted.sync();
	return mounted.source();
}

function swappedSource(source: string, first: SourceSpan, second: SourceSpan): string {
	const [left, right] = first.from < second.from ? [first, second] : [second, first];
	return source.slice(0, left.from) +
		source.slice(right.from, right.to) +
		source.slice(left.to, right.from) +
		source.slice(left.from, left.to) +
		source.slice(right.to);
}

const mathCellsSource = [
	'\\documentclass{article}',
	'\\unknownpreamble{keep these exact bytes}',
	'\\begin{document}',
	'$$aa$$',
	'$$bb$$',
	'$$cc$$',
	'\\end{document}'
].join('\r\n');

test('selectable notebook cells move up/down with exact source preservation and one shared undo', { timeout: 5000 }, () => {
	const mounted = mount(mathCellsSource);
	try {
		const original = mounted.source();
		const originalBytes = original.toBytes();
		const initial = mounted.blocks().filter(({ node }) => node.type.name === 'math_block');
		assert.equal(initial.length, 3);

		const first = initial[0]!, second = initial[1]!;
		assert.equal(mounted.visual.navigate(first.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof NodeSelection);
		assert.equal((mounted.visual.view.state.selection as NodeSelection).node.attrs.source, '$$aa$$');
		clickCellButton(mounted, first, /\bmove\b.*\bdown\b/i);
		const down = mounted.actions.at(-1)!;
		assert.equal(down.action, 'move-down');
		assert.deepEqual([down.span.from, down.span.to], [first.span.from, first.span.to]);
		assert.ok(down.adjacent);
		assert.deepEqual([down.adjacent.from, down.adjacent.to], [second.span.from, second.span.to]);
		assert.equal(down.span.version, original.version);
		assert.equal(down.adjacent.version, original.version);

		const expectedMove = swappedSource(original.read(), first.span, second.span);
		assert.equal(mounted.source().read(), expectedMove);
		assert.deepEqual(mounted.source().toBytes(), bytesWithBom(expectedMove));
		assert.ok(mounted.source().read().startsWith('\\documentclass{article}\r\n\\unknownpreamble{keep these exact bytes}'));
		assert.deepEqual(
			mounted.blocks().filter(({ node }) => node.type.name === 'math_block').map(({ node }) => node.attrs.source),
			['$$bb$$', '$$aa$$', '$$cc$$']
		);
		assert.deepEqual(undoAndSync(mounted).toBytes(), originalBytes);

		const restored = mounted.blocks().filter(({ node }) => node.type.name === 'math_block');
		const middle = restored[1]!;
		assert.equal(mounted.visual.navigate(middle.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof NodeSelection);
		clickCellButton(mounted, middle, /\bmove\b.*\bup\b/i);
		const up = mounted.actions.at(-1)!;
		assert.equal(up.action, 'move-up');
		assert.deepEqual([up.span.from, up.span.to], [middle.span.from, middle.span.to]);
		assert.ok(up.adjacent);
		assert.deepEqual([up.adjacent.from, up.adjacent.to], [restored[0]!.span.from, restored[0]!.span.to]);
		assert.equal(up.span.version, mounted.source().version - 1);
		assert.equal(mounted.source().read(), expectedMove);
		assert.deepEqual(mounted.source().toBytes(), bytesWithBom(expectedMove));
		assert.deepEqual(undoAndSync(mounted).toBytes(), originalBytes);
	} finally {
		mounted.dispose();
	}
});

test('deleting a selected notebook cell preserves surrounding and unknown source bytes', { timeout: 5000 }, () => {
	const mounted = mount(mathCellsSource);
	try {
		const original = mounted.source();
		const originalBytes = original.toBytes();
		const cells = mounted.blocks().filter(({ node }) => node.type.name === 'math_block');
		const removed = cells[1]!;
		assert.equal(mounted.visual.navigate(removed.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof NodeSelection);
		clickCellButton(mounted, removed, /\bdelete\b/i);

		const request = mounted.actions.at(-1)!;
		assert.equal(request.action, 'delete');
		assert.deepEqual([request.span.from, request.span.to], [removed.span.from, removed.span.to]);
		assert.equal(request.span.version, original.version);
		const expected = original.read().slice(0, removed.span.from) + original.read().slice(removed.span.to);
		assert.equal(mounted.source().read(), expected);
		assert.deepEqual(mounted.source().toBytes(), bytesWithBom(expected));
		assert.ok(mounted.source().read().includes('\\unknownpreamble{keep these exact bytes}'));
		assert.deepEqual(
			mounted.blocks().filter(({ node }) => node.type.name === 'math_block').map(({ node }) => node.attrs.source),
			['$$aa$$', '$$cc$$']
		);
		assert.deepEqual(undoAndSync(mounted).toBytes(), originalBytes);
	} finally {
		mounted.dispose();
	}
});

test('text, equation, matrix and table cells are selectable; above/below insertion uses live boundaries', { timeout: 5000 }, () => {
	const table = tableSource(createTable(1, 1)).replace(/\r\n|\r|\n/g, '\r\n');
	const sourceText = [
		'\\documentclass{article}',
		'\\unknownpreamble{retain byte for byte}',
		'\\begin{document}',
		'\\section{Heading cell}',
		'Body text cell',
		'$$x+y$$',
		'$$\\begin{matrix}a&b\\\\c&d\\end{matrix}$$',
		table,
		'\\end{document}'
	].join('\r\n');
	const mounted = mount(sourceText);
	try {
		const originalBytes = mounted.source().toBytes();
		const all = mounted.blocks();
		const textCell = findBlock(mounted, (node) => node.type.name === 'source_block' && node.textContent.trim() === 'Body text cell');
		const mathCells = all.filter(({ node }) => node.type.name === 'math_block');
		const tableCell = findBlock(mounted, (node) => node.type.name === 'table_block');
		assert.equal(mathCells.length, 2);
		assert.ok(mathCells[1]!.node.attrs.latex.includes('matrix'));

		assert.equal(mounted.visual.navigate(textCell.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof TextSelection);
		assert.equal(mounted.visual.navigate(mathCells[0]!.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof NodeSelection);
		assert.equal(mounted.visual.navigate(mathCells[1]!.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof NodeSelection);
		assert.equal(mounted.visual.navigate(tableCell.span), true);
		assert.ok(mounted.visual.view.state.selection instanceof NodeSelection);

		const beforeAbove = mounted.source();
		const index = textCell.index;
		const pointAbove = index === 0 ? textCell.span.from : all[index - 1]!.span.to;
		clickTextInsertion(mounted, textCell, 'above');
		const above = mounted.insertions.at(-1)!;
		assert.equal(above.kind, 'text');
		assert.deepEqual([above.span.from, above.span.to], [pointAbove, pointAbove]);
		assert.equal(above.span.version, beforeAbove.version);
		assert.equal(above.beforeText, true);
		const aboveMarker = `\\par${beforeAbove.profile.preferredLineEnding}`;
		const expectedAbove = beforeAbove.read().slice(0, pointAbove) + aboveMarker + beforeAbove.read().slice(pointAbove);
		assert.equal(mounted.source().read(), expectedAbove);
		assert.deepEqual(mounted.source().toBytes(), bytesWithBom(expectedAbove));
		assert.deepEqual(undoAndSync(mounted).toBytes(), originalBytes);

		const restored = mounted.blocks();
		const restoredText = findBlock(mounted, (node) => node.type.name === 'source_block' && node.textContent.trim() === 'Body text cell');
		const pointBelow = restoredText.span.to;
		const next = restored[restoredText.index + 1];
		assert.ok(next);
		const beforeBelow = mounted.source().read();
		clickTextInsertion(mounted, restoredText, 'below');
		const below = mounted.insertions.at(-1)!;
		assert.equal(below.kind, 'text');
		assert.deepEqual([below.span.from, below.span.to], [pointBelow, pointBelow]);
		assert.equal(below.span.version, mounted.source().version - 1);
		assert.equal(below.beforeText, next.node.type.name === 'source_block');
		const belowMarker = `\\par${mounted.source().profile.preferredLineEnding}`;
		const expectedBelow = beforeBelow.slice(0, pointBelow) + belowMarker + beforeBelow.slice(pointBelow);
		assert.equal(mounted.source().read(), expectedBelow);
		assert.deepEqual(mounted.source().toBytes(), bytesWithBom(expectedBelow));
		assert.deepEqual(undoAndSync(mounted).toBytes(), originalBytes);
	} finally {
		mounted.dispose();
	}
});

test('stale cell controls cannot dispatch old-version spans; live controls use the current version', { timeout: 5000 }, () => {
	const mounted = mount(mathCellsSource);
	try {
		const first = mounted.blocks().find(({ node }) => node.type.name === 'math_block')!;
		assert.equal(mounted.visual.navigate(first.span), true);
		const staleButton = findCellButton(mounted, first, /\bdelete\b/i);
		assert.ok(staleButton);

		const beforeExternalEdit = mounted.source();
		const externalPatch = {
			from: beforeExternalEdit.length, to: beforeExternalEdit.length,
			expected: '', insert: '% external source edit'
		};
		mounted.sourceView.dispatch(sourcePatchTransaction(
			mounted.sourceView.state,
			{ documentId: beforeExternalEdit.documentId, version: beforeExternalEdit.version },
			[externalPatch]
		));
		const externallyEdited = mounted.source();
		mounted.visual.refresh();
		staleButton.click();
		assert.equal(mounted.actions.length, 0, 'a stale DOM control must not reach the source-action callback');
		assert.deepEqual(mounted.source().toBytes(), externallyEdited.toBytes());

		mounted.sync();
		const liveCell = mounted.blocks().find(({ node }) => node.type.name === 'math_block')!;
		assert.equal(mounted.visual.navigate(liveCell.span), true);
		clickCellButton(mounted, liveCell, /\bdelete\b/i);
		const request = mounted.actions.at(-1)!;
		assert.equal(request.span.version, externallyEdited.version);
		const expected = externallyEdited.read().slice(0, liveCell.span.from) +
			externallyEdited.read().slice(liveCell.span.to);
		assert.equal(mounted.source().read(), expected);
		assert.deepEqual(undoAndSync(mounted).toBytes(), externallyEdited.toBytes());
	} finally {
		mounted.dispose();
	}
});

test('a caret hit-tested from mounted visual text edits the matching source offset and shares undo', { timeout: 5000 }, () => {
	const sourceText = [
		'\\documentclass{article}',
		'\\unknownpreamble{preserve}',
		'\\begin{document}',
		'\\section{A}',
		'Body before after',
		'$$x+y$$',
		'\\opaque{keep}',
		'\\end{document}'
	].join('\r\n');
	const mounted = mount(sourceText);
	try {
		const original = mounted.source();
		const originalBytes = original.toBytes();
		const text = 'Body before after';
		const block = findBlock(mounted, (node) => node.type.name === 'source_block' && node.textContent.trim() === text);
		const domNode = mounted.visual.view.nodeDOM(block.position);
		assert.ok(domNode);
		const root = domNode as HTMLElement;
		const elements = [root, ...Array.from(root.querySelectorAll('*'))];
		const rendered = elements.find((element) => element.textContent === block.node.textContent);
		assert.ok(rendered, 'the source-backed text cell should be mounted in the visual editor');
		const walker = mounted.dom.window.document.createTreeWalker(rendered, mounted.dom.window.NodeFilter.SHOW_TEXT);
		let textNode: Text | null = null;
		for (let next = walker.nextNode(); next; next = walker.nextNode()) {
			if (next.nodeValue?.includes(text)) { textNode = next as Text; break; }
		}
		assert.ok(textNode);

		const caretOffset = textNode.nodeValue!.indexOf('after');
		const hitPosition = mounted.visual.view.posAtDOM(textNode, caretOffset);
		const expectedPosition = block.position + 1 + caretOffset;
		assert.equal(hitPosition, expectedPosition, 'DOM hit testing should resolve to the visible text caret');
		const state = mounted.visual.view.state;
		mounted.visual.view.dispatch(
			state.tr.setSelection(TextSelection.create(state.doc, hitPosition)).insertText('🧪')
		);

		const editedText = sourceText.replace(text, 'Body before 🧪after');
		assert.equal(mounted.source().read(), editedText);
		assert.deepEqual(mounted.source().toBytes(), bytesWithBom(editedText));
		assert.deepEqual(undoAndSync(mounted).toBytes(), originalBytes);
	} finally {
		mounted.dispose();
	}
});
