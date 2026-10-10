import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EditorView as CodeMirrorView } from '@codemirror/view';
import type { Node as VisualNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { createSourceState, sourcePatchTransaction, sourceState, historyTransaction, rangeInsertionTarget, insertionTransaction, visualInsertionTransaction } from '../../src/features/source-editor/state.ts';
import { equationSource } from '../../src/features/math/source.ts';
import { createTable, tableSource, type TableDraft } from '../../src/features/tables/source.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('real visual table DOM, anchored re-edit, stale exclusion, shared undo and listener teardown', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const draft: TableDraft = { ...createTable(2, 2), cells: ['Metric', 'Value', '<img src=x onerror=alert(1)>', '雪 & 42%'],
		caption: { position: 'below', text: 'Results <script>' }, weights: [2, 1], style: 'full' };
	const table = tableSource(draft), prefix = '\\section{A}\r\n';
	const original = SourceDocument.open(new TextEncoder().encode('\uFEFF' + prefix + table.replaceAll('\n', '\r\n') + '\r\n\\opaque{keep}'));
	let editor = createSourceState(original), readonly = false, rejected = 0;
	const actions: { draft: TableDraft; span: SourceSpan }[] = [];
	const target = dom.window.document.getElementById('target');
	const view = new VisualEditor(target, 'main.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: (direction) => { const transaction = historyTransaction(editor, direction); if (!transaction) return false; editor = transaction.state; view.refresh(); return true; },
		readOnly: () => readonly, rejected: () => rejected++, status: () => {}, table: (draft, span) => actions.push({ draft, span })
	});
	try {
		view.sync(parseSource(original));
		assert.equal(target.querySelectorAll('table').length, 1);
		assert.equal(target.querySelectorAll('th').length, 2);
		assert.equal(target.querySelector('td').textContent, draft.cells[2]);
		assert.equal(target.querySelector('caption').textContent, draft.caption.text);
		assert.equal(target.querySelector('caption').style.captionSide, 'bottom');
		assert.equal(target.querySelector('table').style.width, '80%');
		assert.equal(target.querySelector('img, script'), null);
		assert.equal(target.querySelector('.raw-latex').textContent, '\\opaque{keep}');
		const button = target.querySelector('.visual-table button');
		assert.equal(button.disabled, false); button.click();
		assert.equal(actions.length, 1); assert.equal(actions[0]!.span.from, prefix.length);
		assert.equal(actions[0]!.span.version, original.version);
		// Leaf anchor changes may rebuild a NodeView; the retired listener must be revoked.
		view.view.dispatch(view.view.state.tr.insertText('雪', 2));
		const anchored = target.querySelector('.visual-table button');
		if (anchored !== button) { button.click(); assert.equal(actions.length, 1); }
		anchored.click(); assert.equal(actions.length, 2);
		const selected = actions[1]!;
		assert.equal(selected.span.from, prefix.length + 1);
		assert.equal(selected.span.version, editor.field(sourceState).projection.document.version);
		const beforeTableEdit = editor.field(sourceState).projection.document;
		const replacement = tableSource({ ...selected.draft, cells: ['Changed', ...selected.draft.cells.slice(1)] });
		editor = insertionTransaction(editor, rangeInsertionTarget(editor, selected.span), replacement).state;
		view.refresh(); assert.equal(anchored.disabled, true); anchored.click(); assert.equal(actions.length, 2);
		view.sync(parseSource(editor.field(sourceState).projection.document));
		assert.equal(target.querySelector('th').textContent, 'Changed');
		assert.throws(() => rangeInsertionTarget(editor, selected.span), /STALE/);
		const updated = target.querySelector('.visual-table button');
		readonly = true; view.refresh(); assert.equal(updated.disabled, true);
		updated.click(); assert.equal(actions.length, 2);
		readonly = false; view.refresh();
		let tablePosition = -1;
		view.view.state.doc.forEach((node, offset) => { if (node.type.name === 'table_block') tablePosition = offset; });
		view.view.dispatch(view.view.state.tr.delete(tablePosition, tablePosition + 1));
		assert.equal(rejected, 1); assert.equal(target.querySelectorAll('table').length, 1);
		editor = historyTransaction(editor, 'undo')!.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), beforeTableEdit.toBytes());
		editor = historyTransaction(editor, 'undo')!.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		view.dispose(); view.dispose(); updated.click(); anchored.click(); button.click();
		assert.equal(actions.length, 2); assert.equal(target.children.length, 0);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('actual EditorView DOM, source transaction, keyboard undo, stale gate and teardown (not Chromium acceptance)', { timeout: 5000 }, async () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(new TextEncoder().encode('\uFEFF\\section{A}\r\nBody \\opaque{keep}'));
	let editor = createSourceState(original); let rejected = 0; let readonly = false;
	const target = dom.window.document.getElementById('target');
	const view = new VisualEditor(target, 'main.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: (direction) => { const transaction = historyTransaction(editor, direction); if (!transaction) return false; editor = transaction.state; view.refresh(); return true; },
		readOnly: () => readonly, rejected: () => rejected++, status: () => {}
	});
	try {
		view.sync(parseSource(original));
		assert.equal(target.querySelector('h2').textContent, 'A');
		const headingSpan = parseSource(original).nodes[0]!.span;
		assert.equal(view.navigate(headingSpan), true);
		assert.equal(view.view.state.selection.from, 1);
		await new Promise((resolve) => setTimeout(resolve, 30)); // Settle the actual library's 20 ms focus-selection synchronization.
		assert.equal(view.view.hasFocus(), true);
		view.view.dom.blur(); // jsdom has no Range layout API; later DOM mutation tests do not claim native focused scrolling.
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		assert.equal(target.querySelector('.raw-latex').textContent, '\\opaque{keep}');
		view.view.dispatch(view.view.state.tr.insertText('%', 2));
		view.view.dispatch(view.view.state.tr.insertText('雪', 3));
		assert.equal(target.querySelector('h2').textContent, 'A%雪');
		assert.equal(editor.field(sourceState).projection.document.read(), '\\section{A\\%雪}\r\nBody \\opaque{keep}');
		assert.equal(rejected, 0);
		readonly = true; view.refresh();
		assert.equal(view.navigate(headingSpan), false);
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'false');
		view.view.dispatch(view.view.state.tr.insertText('bad', 1)); assert.equal(rejected, 1);
		readonly = false; view.refresh();
		view.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
		assert.equal(editor.field(sourceState).projection.document.read(), '\\section{A\\%}\r\nBody \\opaque{keep}');
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'false');
		view.sync(parseSource(editor.field(sourceState).projection.document));
		assert.equal(target.querySelector('h2').textContent, 'A%');
		view.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
		view.sync(parseSource(editor.field(sourceState).projection.document));
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		// Exercise real MutationObserver/DOM parsing, not a fake view or source callback.
		const heading = target.querySelector('h2'); heading.firstChild.nodeValue = 'Edited';
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(editor.field(sourceState).projection.document.read(), '\\section{Edited}\r\nBody \\opaque{keep}');
		assert.equal(rejected, 1);
		const beforeRecovery = editor;
		view.invalidate();
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'false');
		assert.equal(target.querySelector('h2').textContent, 'Edited');
		view.sync(parseSource(editor.field(sourceState).projection.document));
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'true');
		assert.equal(editor, beforeRecovery); // Recovery neither replaces source state nor clears shared history.
		view.dispose(); view.dispose(); assert.equal(target.querySelector('.ProseMirror'), null);
		assert.equal(view.navigate(headingSpan), false);
		view.sync(parseSource(original)); assert.equal(target.children.length, 0);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('length-changing edits keep raw and math actions on current source anchors and undo exact bytes', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(new TextEncoder().encode(
		'\uFEFF\\section{Alpha}\r\nFirst block\r\n\\section{Beta}\r\nSecond block\r\n$$x+y$$\r\n\\opaque{keep}'
	));
	const originalBytes = original.toBytes(), rawSource = '\\opaque{keep}', mathSource = '$$x+y$$';
	let editor = createSourceState(original), rejected = 0;
	const rawActions: { source: string; span: SourceSpan }[] = [];
	const equationActions: { latex: string; inline: boolean; span: SourceSpan }[] = [];
	const target = dom.window.document.getElementById('target');
	assert.ok(target);
	const view = new VisualEditor(target, 'main.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: (direction) => {
			const transaction = historyTransaction(editor, direction);
			if (!transaction) return false;
			editor = transaction.state; return true;
		},
		readOnly: () => false, rejected: () => rejected++, status: () => {},
		raw: (source, span) => rawActions.push({ source, span }),
		equation: (draft, span) => equationActions.push({ latex: draft.latex, inline: draft.inline, span })
	});
	try {
		view.sync(parseSource(original));
		const locate = (needle: string) => {
			const matches: { offset: number; text: string }[] = [];
			view.view.state.doc.forEach((node, offset) => {
				if (node.type.name === 'source_block' && node.textContent.includes(needle)) matches.push({ offset, text: node.textContent });
			});
			assert.equal(matches.length, 1);
			return matches[0]!;
		};

		const first = locate('First block');
		const insertAt = first.offset + 1 + first.text.indexOf('First') + 2;
		view.view.dispatch(view.view.state.tr
			.setSelection(TextSelection.create(view.view.state.doc, insertAt))
			.insertText('雪'));
		assert.equal(view.view.state.selection.from, insertAt + 1);
		assert.equal(view.view.state.selection.to, insertAt + 1);
		assert.match(editor.field(sourceState).projection.document.read(), /Fi雪rst block/);
		const afterInsertionBytes = editor.field(sourceState).projection.document.toBytes();

		const second = locate('Second block');
		const deleteFrom = second.offset + 1 + second.text.indexOf('block');
		view.view.dispatch(view.view.state.tr
			.setSelection(TextSelection.create(view.view.state.doc, deleteFrom, deleteFrom + 'block'.length))
			.deleteSelection());
		assert.equal(view.view.state.selection.from, deleteFrom);
		assert.equal(view.view.state.selection.to, deleteFrom);
		assert.equal(editor.field(sourceState).projection.document.read().includes('Second block'), false);

		const rawButton = target.querySelector('.visual-raw button') as HTMLButtonElement | null;
		const equationButton = target.querySelector('.visual-math:not(.visual-math-inline) button') as HTMLButtonElement | null;
		assert.ok(rawButton); assert.equal(rawButton.disabled, false); rawButton.click();
		assert.ok(equationButton); assert.equal(equationButton.disabled, false); equationButton.click();
		assert.equal(rawActions.length, 1);
		assert.equal(equationActions.length, 1);
		assert.equal(rawActions[0]!.source, rawSource);
		assert.deepEqual({ latex: equationActions[0]!.latex, inline: equationActions[0]!.inline }, { latex: 'x+y', inline: false });

		const current = editor.field(sourceState).projection.document, currentText = current.read();
		const fresh = projectVisual(current, parseSource(current));
		const freshAnchor = (type: string, source: string) => {
			const matches: { from: number; to: number }[] = [];
			fresh.document.descendants((node) => {
				if (node.type.name === type && node.attrs.source === source) matches.push({ from: node.attrs.from, to: node.attrs.to });
			});
			assert.equal(matches.length, 1);
			return matches[0]!;
		};
		const freshRaw = freshAnchor('raw_block', rawSource), freshMath = freshAnchor('math_block', mathSource);
		assert.deepEqual([rawActions[0]!.span.from, rawActions[0]!.span.to], [freshRaw.from, freshRaw.to]);
		assert.deepEqual([equationActions[0]!.span.from, equationActions[0]!.span.to], [freshMath.from, freshMath.to]);
		for (const span of [rawActions[0]!.span, equationActions[0]!.span]) {
			assert.equal(span.documentId, current.documentId);
			assert.equal(span.version, current.version);
		}
		const rawCharacterOffset = currentText.indexOf(rawSource), mathCharacterOffset = currentText.indexOf(mathSource);
		assert.ok(rawCharacterOffset >= 0); assert.ok(mathCharacterOffset >= 0);
		// Source spans address the decoded source string; byte preservation is checked by toBytes() below.
		assert.equal(rawActions[0]!.span.from, rawCharacterOffset);
		assert.equal(rawActions[0]!.span.to, rawCharacterOffset + rawSource.length);
		assert.equal(equationActions[0]!.span.from, mathCharacterOffset);
		assert.equal(equationActions[0]!.span.to, mathCharacterOffset + mathSource.length);
		assert.equal(current.read(rawActions[0]!.span.from, rawActions[0]!.span.to), rawSource);
		assert.equal(current.read(equationActions[0]!.span.from, equationActions[0]!.span.to), mathSource);
		assert.equal(rejected, 0);

		const undo = () => {
			const transaction = historyTransaction(editor, 'undo');
			assert.ok(transaction);
			editor = transaction.state;
			const source = editor.field(sourceState).projection.document;
			view.sync(parseSource(source));
			return source;
		};
		assert.deepEqual(undo().toBytes(), afterInsertionBytes);
		assert.deepEqual(undo().toBytes(), originalBytes);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('validated visual apply publishes one prepared CodeMirror state and rejects before commit', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="source"></div><div id="visual"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(new TextEncoder().encode(
		'\uFEFF\\section{Alpha}\r\nFirst block\r\n\\section{Beta}\r\nSecond block\r\n$$x+y$$\r\n\\opaque{keep}'
	));
	const originalBytes = original.toBytes(), rawSource = '\\opaque{keep}', mathSource = '$$x+y$$';
	const sourceTarget = dom.window.document.getElementById('source'), visualTarget = dom.window.document.getElementById('visual');
	assert.ok(sourceTarget); assert.ok(visualTarget);
	const sourceView = new CodeMirrorView({ parent: sourceTarget, state: createSourceState(original) });
	let rejected = 0, alterPreparedReceipt = true;
	let validatedCalls = 0, preparedTransactions = 0, validations = 0, publishedTransactions = 0, legacyCalls = 0;
	const preparedSources: SourceDocument[] = [];
	const rawActions: { source: string; span: SourceSpan }[] = [];
	const equationActions: { latex: string; inline: boolean; span: SourceSpan }[] = [];
	const view = new VisualEditor(visualTarget, 'main.tex', {
		source: () => sourceView.state.field(sourceState).projection.document,
		apply: (identity, patches) => {
			legacyCalls++;
			const transaction = sourcePatchTransaction(sourceView.state, identity, patches);
			sourceView.dispatch(transaction);
			return sourceView.state.field(sourceState).projection.document;
		},
		applyValidated: (identity, patches, validateNextSource) => {
			validatedCalls++;
			const candidatePatches = alterPreparedReceipt
				? patches.map((patch) => ({ ...patch, insert: patch.insert + '!' }))
				: patches;
			const transaction = sourcePatchTransaction(sourceView.state, identity, candidatePatches);
			preparedTransactions++;
			const candidate = transaction.state.field(sourceState).projection.document;
			preparedSources.push(candidate);
			validations++;
			validateNextSource(candidate);
			sourceView.dispatch(transaction);
			publishedTransactions++;
			const receipt = sourceView.state.field(sourceState).projection.document;
			assert.equal(receipt, candidate);
			return receipt;
		},
		history: (direction) => {
			const transaction = historyTransaction(sourceView.state, direction);
			if (!transaction) return false;
			sourceView.dispatch(transaction); return true;
		},
		readOnly: () => false, rejected: () => rejected++, status: () => {},
		raw: (source, span) => rawActions.push({ source, span }),
		equation: (draft, span) => equationActions.push({ latex: draft.latex, inline: draft.inline, span })
	});
	try {
		view.sync(parseSource(original));
		const locate = (needle: string) => {
			const matches: { offset: number; text: string }[] = [];
			view.view.state.doc.forEach((node, offset) => {
				if (node.type.name === 'source_block' && node.textContent.includes(needle)) matches.push({ offset, text: node.textContent });
			});
			assert.equal(matches.length, 1);
			return matches[0]!;
		};

		const sourceBefore = sourceView.state.field(sourceState).projection.document;
		const sourceStateBefore = sourceView.state, visualStateBefore = view.view.state;
		const first = locate('First block');
		const insertAt = first.offset + 1 + first.text.indexOf('First') + 2;
		view.view.dispatch(view.view.state.tr
			.setSelection(TextSelection.create(view.view.state.doc, insertAt))
			.insertText('雪'));
		assert.equal(rejected, 1);
		assert.equal(validatedCalls, 1);
		assert.equal(preparedTransactions, 1);
		assert.equal(validations, 1);
		assert.equal(publishedTransactions, 0);
		assert.equal(legacyCalls, 0);
		assert.notEqual(preparedSources[0], sourceBefore);
		assert.match(preparedSources[0]!.read(), /Fi雪!rst block/);
		assert.equal(sourceView.state, sourceStateBefore);
		assert.equal(sourceView.state.field(sourceState).projection.document, sourceBefore);
		assert.deepEqual(sourceBefore.toBytes(), originalBytes);
		assert.equal(view.view.state, visualStateBefore);

		// Retry the same real ProseMirror edit with the unaltered source patches.
		alterPreparedReceipt = false;
		const firstAgain = locate('First block');
		const retryAt = firstAgain.offset + 1 + firstAgain.text.indexOf('First') + 2;
		view.view.dispatch(view.view.state.tr
			.setSelection(TextSelection.create(view.view.state.doc, retryAt))
			.insertText('雪'));
		assert.equal(view.view.state.selection.from, retryAt + 1);
		assert.equal(view.view.state.selection.to, retryAt + 1);
		const afterInsertion = sourceView.state.field(sourceState).projection.document;
		assert.equal(afterInsertion, preparedSources[1]);
		assert.match(afterInsertion.read(), /Fi雪rst block/);
		const afterInsertionBytes = afterInsertion.toBytes();

		const second = locate('Second block');
		const deleteFrom = second.offset + 1 + second.text.indexOf('block');
		view.view.dispatch(view.view.state.tr
			.setSelection(TextSelection.create(view.view.state.doc, deleteFrom, deleteFrom + 'block'.length))
			.deleteSelection());
		assert.equal(view.view.state.selection.from, deleteFrom);
		assert.equal(view.view.state.selection.to, deleteFrom);
		const current = sourceView.state.field(sourceState).projection.document;
		assert.equal(current, preparedSources[2]);
		assert.equal(current.read().includes('Second block'), false);
		assert.equal(validatedCalls, 3);
		assert.equal(preparedTransactions, 3);
		assert.equal(validations, 3);
		assert.equal(publishedTransactions, 2);
		assert.equal(legacyCalls, 0);

		const rawButton = visualTarget.querySelector('.visual-raw button') as HTMLButtonElement | null;
		const equationButton = visualTarget.querySelector('.visual-math:not(.visual-math-inline) button') as HTMLButtonElement | null;
		assert.ok(rawButton); assert.equal(rawButton.disabled, false); rawButton.click();
		assert.ok(equationButton); assert.equal(equationButton.disabled, false); equationButton.click();
		assert.equal(rawActions.length, 1);
		assert.equal(equationActions.length, 1);
		assert.equal(rawActions[0]!.source, rawSource);
		assert.deepEqual({ latex: equationActions[0]!.latex, inline: equationActions[0]!.inline }, { latex: 'x+y', inline: false });

		const fresh = projectVisual(current, parseSource(current));
		const freshAnchor = (type: string, source: string) => {
			const matches: { from: number; to: number }[] = [];
			fresh.document.descendants((node) => {
				if (node.type.name === type && node.attrs.source === source) matches.push({ from: node.attrs.from, to: node.attrs.to });
			});
			assert.equal(matches.length, 1);
			return matches[0]!;
		};
		const freshRaw = freshAnchor('raw_block', rawSource), freshMath = freshAnchor('math_block', mathSource);
		assert.deepEqual([rawActions[0]!.span.from, rawActions[0]!.span.to], [freshRaw.from, freshRaw.to]);
		assert.deepEqual([equationActions[0]!.span.from, equationActions[0]!.span.to], [freshMath.from, freshMath.to]);
		for (const span of [rawActions[0]!.span, equationActions[0]!.span]) {
			assert.equal(span.documentId, current.documentId);
			assert.equal(span.version, current.version);
		}
		assert.equal(current.read(rawActions[0]!.span.from, rawActions[0]!.span.to), rawSource);
		assert.equal(current.read(equationActions[0]!.span.from, equationActions[0]!.span.to), mathSource);
		assert.equal(rejected, 1);

		const undo = () => {
			const transaction = historyTransaction(sourceView.state, 'undo');
			assert.ok(transaction);
			sourceView.dispatch(transaction);
			const source = sourceView.state.field(sourceState).projection.document;
			view.sync(parseSource(source));
			return source;
		};
		assert.deepEqual(undo().toBytes(), afterInsertionBytes);
		assert.deepEqual(undo().toBytes(), originalBytes);
	} finally {
		view.dispose(); sourceView.destroy(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('marked visual typing keeps current Raw/math anchors, rejects structural splits atomically, and shares byte-exact undo/redo', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const originalText = '\uFEFF\\section{A}\r\nBefore after\r\n$$x+y$$\n\\opaque{keep}';
	const original = SourceDocument.open(new TextEncoder().encode(originalText));
	const rawSource = '\\opaque{keep}', mathSource = '$$x+y$$';
	let editor = createSourceState(original), rejected = 0;
	const rawActions: { source: string; span: SourceSpan }[] = [];
	const equationActions: { draft: { latex: string; inline: boolean }; span: SourceSpan }[] = [];
	const target = dom.window.document.getElementById('target');
	assert.ok(target);
	const view = new VisualEditor(target, 'main.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: (direction) => {
			const transaction = historyTransaction(editor, direction);
			if (!transaction) return false;
			editor = transaction.state; view.refresh(); return true;
		},
		readOnly: () => false, rejected: () => rejected++, status: () => {},
		raw: (source, span) => rawActions.push({ source, span }),
		equation: (draft, span) => equationActions.push({ draft, span })
	});
	try {
		view.sync(parseSource(original));
		let insertAt = -1;
		view.view.state.doc.forEach((node, offset) => {
			if (node.type.name === 'source_block' && node.textContent.includes('Before after')) {
				insertAt = offset + 1 + node.textContent.indexOf('Before after') + 2;
			}
		});
		assert.ok(insertAt >= 0);
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, insertAt)));
		assert.equal(view.toggleFormat('strong'), true);
		view.view.dispatch(view.view.state.tr.insertText('雪'));

		const edited = editor.field(sourceState).projection.document;
		const editedText = originalText.replace('Before after', 'Be\\textbf{雪}fore after');
		assert.deepEqual(edited.toBytes(), new TextEncoder().encode(editedText));
		const rawButton = target.querySelector('.visual-raw button') as HTMLButtonElement | null;
		const mathButton = target.querySelector('.visual-math:not(.visual-math-inline) button') as HTMLButtonElement | null;
		assert.ok(rawButton); assert.equal(rawButton.disabled, false); rawButton.click();
		assert.ok(mathButton); assert.equal(mathButton.disabled, false); mathButton.click();
		assert.equal(rawActions[0]!.source, rawSource);
		assert.deepEqual(equationActions[0]!.draft, { latex: 'x+y', inline: false });
		const fresh = projectVisual(edited, parseSource(edited));
		const findAnchor = (type: string, source: string) => {
			const found: { from: number; to: number }[] = [];
			fresh.document.descendants((node) => {
				if (node.type.name === type && node.attrs.source === source) {
					found.push({ from: Number(node.attrs.from), to: Number(node.attrs.to) });
				}
			});
			assert.equal(found.length, 1);
			return found[0]!;
		};
		const freshRaw = findAnchor('raw_block', rawSource), freshMath = findAnchor('math_block', mathSource);
		assert.deepEqual([rawActions[0]!.span.from, rawActions[0]!.span.to], [freshRaw.from, freshRaw.to]);
		assert.deepEqual([equationActions[0]!.span.from, equationActions[0]!.span.to], [freshMath.from, freshMath.to]);
		assert.equal(edited.read(rawActions[0]!.span.from, rawActions[0]!.span.to), rawSource);
		assert.equal(edited.read(equationActions[0]!.span.from, equationActions[0]!.span.to), mathSource);

		const beforeSplit = view.view.state;
		view.view.dispatch(beforeSplit.tr.split(beforeSplit.selection.from));
		assert.equal(rejected, 1);
		assert.equal(view.view.state, beforeSplit);
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), edited.toBytes());

		const undo = historyTransaction(editor, 'undo');
		assert.ok(undo); editor = undo.state;
		const restored = editor.field(sourceState).projection.document;
		view.sync(parseSource(restored));
		assert.deepEqual(restored.toBytes(), original.toBytes());
		const redo = historyTransaction(editor, 'redo');
		assert.ok(redo); editor = redo.state;
		const redone = editor.field(sourceState).projection.document;
		view.sync(parseSource(redone));
		assert.deepEqual(redone.toBytes(), new TextEncoder().encode(editedText));
		assert.equal(rejected, 1);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('multi-block length-changing edits preserve canonical tail anchors and shared byte-exact undo', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="source"></div><div id="visual"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(new TextEncoder().encode(
		'\uFEFF\\section{Alpha}\r\nAlpha block\r\n\\section{Beta}\r\nBeta block\r\n\\section{Gamma}\r\nGamma block\r\n$$x+y$$\r\n\\opaque{tail}'
	));
	const originalBytes = original.toBytes(), originalText = original.read();
	const rawSource = '\\opaque{tail}', mathSource = '$$x+y$$';
	const sourceTarget = dom.window.document.getElementById('source'), visualTarget = dom.window.document.getElementById('visual');
	assert.ok(sourceTarget); assert.ok(visualTarget);
	const sourceView = new CodeMirrorView({ parent: sourceTarget, state: createSourceState(original) });
	let rejected = 0;
	const rawActions: { source: string; span: SourceSpan }[] = [];
	const equationActions: { latex: string; inline: boolean; span: SourceSpan }[] = [];
	const view = new VisualEditor(visualTarget, 'main.tex', {
		source: () => sourceView.state.field(sourceState).projection.document,
		apply: (identity, patches) => {
			const transaction = sourcePatchTransaction(sourceView.state, identity, patches);
			sourceView.dispatch(transaction);
			return sourceView.state.field(sourceState).projection.document;
		},
		applyValidated: (identity, patches, validateNextSource) => {
			const transaction = sourcePatchTransaction(sourceView.state, identity, patches);
			validateNextSource(transaction.state.field(sourceState).projection.document);
			sourceView.dispatch(transaction);
			return sourceView.state.field(sourceState).projection.document;
		},
		history: (direction) => {
			const transaction = historyTransaction(sourceView.state, direction);
			if (!transaction) return false;
			sourceView.dispatch(transaction);
			return true;
		},
		readOnly: () => false, rejected: () => rejected++, status: () => {},
		raw: (source, span) => rawActions.push({ source, span }),
		equation: (draft, span) => equationActions.push({ latex: draft.latex, inline: draft.inline, span })
	});
	try {
		view.sync(parseSource(original));
		const locate = (needle: string) => {
			const matches: { offset: number; text: string }[] = [];
			view.view.state.doc.forEach((node, offset) => {
				if (node.type.name === 'source_block' && node.textContent.includes(needle)) matches.push({ offset, text: node.textContent });
			});
			assert.equal(matches.length, 1);
			return matches[0]!;
		};
		let transaction = view.view.state.tr;
		const gamma = locate('Gamma block'), beta = locate('Beta block'), alpha = locate('Alpha block');
		transaction = transaction.insertText('雪', gamma.offset + 1 + gamma.text.indexOf('Gamma') + 2);
		transaction = transaction.delete(beta.offset + 1 + beta.text.indexOf('Beta'),
			beta.offset + 1 + beta.text.indexOf('Beta') + 'Beta '.length);
		transaction = transaction.insertText('🧪', alpha.offset + 1 + alpha.text.indexOf('Alpha') + 2);
		const betaContentStart = transaction.mapping.map(beta.offset + 1, -1);
		transaction = transaction.setSelection(TextSelection.create(transaction.doc, betaContentStart + 1));
		const expectedSelection = transaction.selection;

		view.view.dispatch(transaction);
		assert.ok(view.view.state.selection.eq(expectedSelection));
		const visibleText: string[] = [];
		view.view.state.doc.forEach((node) => { if (node.type.name === 'source_block') visibleText.push(node.textContent); });
		assert.ok(visibleText.some((value) => value.includes('Al🧪pha block')));
		assert.ok(visibleText.some((value) => value.includes('Ga雪mma block')));
		const expectedBeta = beta.text.slice(0, beta.text.indexOf('Beta')) + beta.text.slice(beta.text.indexOf('Beta') + 'Beta '.length);
		assert.ok(visibleText.some((value) => value === expectedBeta));
		assert.equal(visibleText.some((value) => value.includes('Beta block')), false);
		assert.equal(rejected, 0);

		const current = sourceView.state.field(sourceState).projection.document, currentText = current.read();
		assert.ok(currentText.includes('Al🧪pha block'));
		assert.ok(currentText.includes('Ga雪mma block'));
		assert.equal(currentText.indexOf(rawSource), originalText.indexOf(rawSource) + '🧪'.length + '雪'.length - 'Beta '.length);
		assert.deepEqual(original.toBytes(), originalBytes);

		const rawButton = visualTarget.querySelector('.visual-raw button') as HTMLButtonElement | null;
		const equationButton = visualTarget.querySelector('.visual-math:not(.visual-math-inline) button') as HTMLButtonElement | null;
		assert.ok(rawButton); assert.equal(rawButton.disabled, false); rawButton.click();
		assert.ok(equationButton); assert.equal(equationButton.disabled, false); equationButton.click();
		assert.equal(rawActions.length, 1);
		assert.equal(equationActions.length, 1);
		assert.equal(rawActions[0]!.source, rawSource);
		assert.deepEqual({ latex: equationActions[0]!.latex, inline: equationActions[0]!.inline }, { latex: 'x+y', inline: false });

		const fresh = projectVisual(current, parseSource(current));
		const freshAnchor = (type: string, source: string) => {
			const matches: { from: number; to: number }[] = [];
			fresh.document.descendants((node) => {
				if (node.type.name === type && node.attrs.source === source) matches.push({ from: node.attrs.from, to: node.attrs.to });
			});
			assert.equal(matches.length, 1);
			return matches[0]!;
		};
		const freshRaw = freshAnchor('raw_block', rawSource), freshMath = freshAnchor('math_block', mathSource);
		assert.deepEqual([rawActions[0]!.span.from, rawActions[0]!.span.to], [freshRaw.from, freshRaw.to]);
		assert.deepEqual([equationActions[0]!.span.from, equationActions[0]!.span.to], [freshMath.from, freshMath.to]);
		for (const span of [rawActions[0]!.span, equationActions[0]!.span]) {
			assert.equal(span.documentId, current.documentId);
			assert.equal(span.version, current.version);
		}
		assert.equal(rawActions[0]!.span.from, currentText.indexOf(rawSource));
		assert.equal(equationActions[0]!.span.from, currentText.indexOf(mathSource));
		assert.equal(current.read(rawActions[0]!.span.from, rawActions[0]!.span.to), rawSource);
		assert.equal(current.read(equationActions[0]!.span.from, equationActions[0]!.span.to), mathSource);

		const undo = historyTransaction(sourceView.state, 'undo');
		assert.ok(undo);
		sourceView.dispatch(undo);
		const restored = sourceView.state.field(sourceState).projection.document;
		assert.deepEqual(restored.toBytes(), originalBytes);
		assert.equal(rejected, 0);
	} finally {
		view.dispose(); sourceView.destroy(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});

test('source-span block insertion preserves neighbors, renders inserted blocks, and shares cursor/undo with CodeMirror', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="source"></div><div id="visual"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}

	const preamble = '\\documentclass{article}\r\n\\usepackage{booktabs}\r\n';
	const originalText = preamble + '\\begin{document}\r\n\\section{First heading}\r\nBody before math.\r\n$$x+y$$\r\n' +
		tableSource({
			...createTable(2, 2),
			cells: ['Name', 'Value', 'alpha', '1'],
			caption: { position: 'below', text: 'Existing table' },
			weights: [2, 1],
			style: 'full'
		}).replace(/\r\n|\r|\n/g, '\r\n') +
		'\r\n\\opaque{tail}\r\\end{document}\n';
	const withBom = (text: string) => new TextEncoder().encode('\uFEFF' + text);
	const originalBytes = withBom(originalText);
	const original = SourceDocument.open(originalBytes);
	const sourceTarget = dom.window.document.getElementById('source');
	const visualTarget = dom.window.document.getElementById('visual');
	assert.ok(sourceTarget); assert.ok(visualTarget);
	const sourceView = new CodeMirrorView({ parent: sourceTarget, state: createSourceState(original) });
	let rejected = 0;
	const visual = new VisualEditor(visualTarget, 'notebook.tex', {
		source: () => sourceView.state.field(sourceState).projection.document,
		apply: (identity, patches) => {
			sourceView.dispatch(sourcePatchTransaction(sourceView.state, identity, patches));
			return sourceView.state.field(sourceState).projection.document;
		},
		applyValidated: (identity, patches, validateNextSource) => {
			const transaction = sourcePatchTransaction(sourceView.state, identity, patches);
			validateNextSource(transaction.state.field(sourceState).projection.document);
			sourceView.dispatch(transaction);
			return sourceView.state.field(sourceState).projection.document;
		},
		history: (direction) => {
			const transaction = historyTransaction(sourceView.state, direction);
			if (!transaction) return false;
			sourceView.dispatch(transaction);
			return true;
		},
		readOnly: () => false, rejected: () => rejected++, status: () => {}
	});

	try {
		visual.sync(parseSource(original));
		assert.equal(visualTarget.querySelector('h2.source-block')?.textContent, 'First heading');
		assert.ok(visualTarget.querySelector('.visual-math:not(.visual-math-inline)'));
		assert.ok(visualTarget.querySelector('.visual-math-content'), 'inserted equation has its renderer host; actual MathLive rendering is covered in Chrome');
		assert.equal(visualTarget.querySelectorAll('.visual-table table').length, 1);

		// Exercise source-span insertion independently of notebook controls.
		const pointFor = (
			source: SourceDocument,
			type: string,
			matches: (node: VisualNode) => boolean,
			edge: 'from' | 'to'
		): SourceSpan => {
			const projection = projectVisual(source, parseSource(source));
			const found: VisualNode[] = [];
			projection.document.forEach((node) => {
				if (node.type.name === type && matches(node)) found.push(node);
			});
			assert.equal(found.length, 1, `expected one ${type} insertion anchor`);
			const offset = Number(found[0]!.attrs[edge]);
			assert.ok(Number.isSafeInteger(offset));
			return { documentId: source.documentId, version: source.version, from: offset, to: offset };
		};
		const insertAt = (span: SourceSpan, value: string) => {
			const beforeSource = sourceView.state.field(sourceState).projection.document;
			assert.equal(span.documentId, beforeSource.documentId);
			assert.equal(span.version, beforeSource.version);
			assert.equal(span.from, span.to);
			const target = rangeInsertionTarget(sourceView.state, span);
			const before = target.from > 0 ? sourceView.state.doc.sliceString(target.from - 1, target.from) : '';
			const after = target.to < sourceView.state.doc.length ? sourceView.state.doc.sliceString(target.to, target.to + 1) : '';
			const editorInsert = (before && before !== '\n' && !value.startsWith('\n') ? '\n' : '') + value
				+ (after && after !== '\n' && !value.endsWith('\n') ? '\n' : '');
			const sourceInsert = editorInsert.replaceAll('\n', beforeSource.profile.preferredLineEnding);
			const beforeText = beforeSource.read();
			const expectedText = beforeText.slice(0, span.from) + sourceInsert + beforeText.slice(span.to);
			const expectedCursor = target.from + editorInsert.length;

			sourceView.dispatch(visualInsertionTransaction(sourceView.state, span, value));
			const afterSource = sourceView.state.field(sourceState).projection.document;
			assert.equal(afterSource.read(), expectedText);
			assert.deepEqual(afterSource.toBytes(), withBom(expectedText));
			assert.equal(afterSource.read(0, span.from), beforeText.slice(0, span.from));
			assert.equal(afterSource.read(span.from + sourceInsert.length, afterSource.length), beforeText.slice(span.to));
			assert.equal(afterSource.read(0, preamble.length), preamble);
			assert.equal(sourceView.state.selection.main.anchor, expectedCursor);
			assert.equal(sourceView.state.selection.main.head, expectedCursor);
			visual.sync(parseSource(afterSource));
			return { after: afterSource, expectedText, cursor: expectedCursor };
		};
		const textBlock = (needle: string) => {
			const matches: { node: VisualNode; offset: number }[] = [];
			visual.view.state.doc.forEach((node, offset) => {
				if (node.type.name === 'source_block' && node.textContent.includes(needle)) matches.push({ node, offset });
			});
			assert.equal(matches.length, 1, `expected one editable visual text block containing ${needle}`);
			return matches[0]!;
		};
		const childIndex = (matches: (node: VisualNode) => boolean) => {
			const indexes: number[] = [];
			visual.view.state.doc.forEach((node, _offset, index) => {
				if (matches(node)) indexes.push(index);
			});
			assert.equal(indexes.length, 1);
			return indexes[0]!;
		};

		const firstBlockPoint = pointFor(original, 'source_block',
			(node) => node.attrs.role === 'heading' && node.textContent === 'First heading', 'from');
		const opening = insertAt(firstBlockPoint, 'Notebook lead');
		const openingTextBlock = textBlock('Notebook lead');
		const headingIndex = childIndex((node) => node.type.name === 'source_block' &&
			node.attrs.role === 'heading' && node.textContent === 'First heading');
		const openingIndex = childIndex((node) => node.type.name === 'source_block' && node.textContent.includes('Notebook lead'));
		assert.ok(openingIndex < headingIndex, 'the inserted text appears before the first visible block');

		// A captured insertion point belongs to the old source version and cannot
		// create another history entry or mutate the real source editor.
		const staleState = sourceView.state;
		const staleBytes = sourceView.state.field(sourceState).projection.document.toBytes();
		const staleUndoDepth = sourceView.state.field(sourceState).undo.length;
		assert.throws(() => visualInsertionTransaction(sourceView.state, firstBlockPoint, 'stale text'), /STALE_INSERTION/);
		assert.equal(sourceView.state, staleState);
		assert.deepEqual(sourceView.state.field(sourceState).projection.document.toBytes(), staleBytes);
		assert.equal(sourceView.state.field(sourceState).undo.length, staleUndoDepth);

		// The newly inserted text is an actual editable ProseMirror text block,
		// not a rendered source preview or a separate draft surface.
		const notebookWord = openingTextBlock.node.textContent.indexOf('Notebook');
		assert.ok(notebookWord >= 0);
		const editAt = openingTextBlock.offset + 1 + notebookWord + 'Notebook'.length;
		visual.view.dispatch(visual.view.state.tr
			.setSelection(TextSelection.create(visual.view.state.doc, editAt))
			.insertText(' revised'));
		const editedOpeningText = opening.expectedText.replace('Notebook lead', 'Notebook revised lead');
		const afterOpeningEdit = sourceView.state.field(sourceState).projection.document;
		assert.equal(afterOpeningEdit.read(), editedOpeningText);
		assert.deepEqual(afterOpeningEdit.toBytes(), withBom(editedOpeningText));
		assert.equal(afterOpeningEdit.read(0, preamble.length), preamble);
		assert.ok(Array.from(visualTarget.querySelectorAll('.source-block') as NodeListOf<HTMLElement>)
			.some((element) => element.textContent?.includes('Notebook revised lead')));

		const mathSource = '$$x+y$$';
		const mathPoint = pointFor(afterOpeningEdit, 'math_block',
			(node) => node.attrs.source === mathSource, 'to');
		const equation = equationSource('u=v', false).replace(/\r\n|\r/g, '\n');
		const afterEquation = insertAt(mathPoint, equation);
		const equationIndex = childIndex((node) => node.type.name === 'math_block' && node.attrs.latex === '\r\nu=v\r\n');
		const originalMathIndex = childIndex((node) => node.type.name === 'math_block' && node.attrs.latex === 'x+y');
		const originalTableIndex = childIndex((node) => node.type.name === 'table_block');
		assert.ok(originalMathIndex < equationIndex && equationIndex < originalTableIndex,
			'the new equation is rendered after the captured math block and before the following table');
		assert.equal(visualTarget.querySelectorAll('.visual-math:not(.visual-math-inline)').length, 2);
		assert.equal(visualTarget.querySelectorAll('.visual-table table').length, 1);

		const addedTableDraft: TableDraft = {
			...createTable(2, 2),
			cells: ['Name', 'Value', 'beta', '2'],
			caption: { position: 'none', text: '' },
			weights: [2, 1],
			style: 'full'
		};
		const addedTable = tableSource(addedTableDraft).replace(/\r\n|\r/g, '\n');
		const tablePoint = pointFor(afterEquation.after, 'table_block',
			(node) => String(node.attrs.source).includes('\\begin{tabular}'), 'to');
		const afterTable = insertAt(tablePoint, addedTable);
		const tableIndexes: number[] = [];
		visual.view.state.doc.forEach((node, _offset, index) => {
			if (node.type.name === 'table_block') tableIndexes.push(index);
		});
		assert.equal(tableIndexes.length, 2);
		assert.ok(tableIndexes[0]! < tableIndexes[1]!, 'the inserted table follows the original table');
		assert.equal(visualTarget.querySelectorAll('.visual-table table').length, 2);
		assert.equal(visualTarget.querySelectorAll('.visual-math:not(.visual-math-inline)').length, 2);
		assert.equal(rejected, 0);

		const assertSourceText = (source: SourceDocument, expected: string) => {
			assert.equal(source.read(), expected);
			assert.deepEqual(source.toBytes(), withBom(expected));
		};
		const undoExpected = [
			afterEquation.after.read(),
			editedOpeningText,
			opening.expectedText,
			originalText
		];
		for (const expected of undoExpected) {
			const transaction = historyTransaction(sourceView.state, 'undo');
			assert.ok(transaction, 'every accepted insertion/edit shares CodeMirror undo');
			sourceView.dispatch(transaction);
			const restored = sourceView.state.field(sourceState).projection.document;
			assertSourceText(restored, expected);
			visual.sync(parseSource(restored));
		}
		assert.equal(sourceView.state.field(sourceState).dirty, false);
		assert.deepEqual(original.toBytes(), originalBytes);

		for (const expected of [opening.expectedText, editedOpeningText, afterEquation.after.read(), afterTable.after.read()]) {
			const transaction = historyTransaction(sourceView.state, 'redo');
			assert.ok(transaction, 'the shared redo stack restores the same accepted edits');
			sourceView.dispatch(transaction);
			const restored = sourceView.state.field(sourceState).projection.document;
			assertSourceText(restored, expected);
			visual.sync(parseSource(restored));
		}
		assert.equal(sourceView.state.selection.main.anchor, afterTable.cursor);
		assert.equal(sourceView.state.selection.main.head, afterTable.cursor);
		assert.equal(sourceView.state.field(sourceState).dirty, true);
	} finally {
		visual.dispose(); sourceView.destroy(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
