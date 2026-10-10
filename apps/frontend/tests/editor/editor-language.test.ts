import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
import { createTable, tableSource, type TableDraft } from '../../src/features/tables/source.ts';
import type { Language } from '../../src/i18n/text.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (value: string) => new TextEncoder().encode(value);

test('locale refresh preserves mounted source-backed node views and shared history', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let visual: VisualEditor | undefined;
	try {
		for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true,
				value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
		}

		const draft: TableDraft = { ...createTable(2, 2), cells: ['Metric', 'Value', 'Count', '42'],
			caption: { position: 'below', text: 'Summary' } };
		const tableText = tableSource(draft).replaceAll('\n', '\r\n');
		const mathText = '$\\frac{1}{2}$', rawText = '\\opaque{keep}';
		const originalText = `\uFEFF\\section{A}\r\n${tableText}\r\n${mathText}\r\n${rawText}`;
		const original = SourceDocument.open(bytes(originalText));
		let editor = createSourceState(original), locale: Language = 'en', readonly = false, rejected = 0;
		const actions: { kind: string; span: SourceSpan; value: string }[] = [];
		const target: HTMLElement | null = dom.window.document.getElementById('target');
		assert.ok(target);
		visual = new VisualEditor(target, 'language.tex', {
			source: () => editor.field(sourceState).projection.document,
			apply: (identity, patches) => {
				editor = sourcePatchTransaction(editor, identity, patches).state;
				return editor.field(sourceState).projection.document;
			},
			history: direction => {
				const transaction = historyTransaction(editor, direction);
				if (!transaction) return false;
				editor = transaction.state;
				visual?.refresh();
				return true;
			},
			readOnly: () => readonly, rejected: () => rejected++, status: () => {}, locale: () => locale,
			raw: (source, span) => actions.push({ kind: 'raw', span, value: source }),
			table: (_table, span) => actions.push({ kind: 'table', span, value: tableText }),
			equation: (equation, span) => actions.push({ kind: 'math', span,
				value: equation.inline ? `$${equation.latex}$` : `$$${equation.latex}$$` })
		});
		const view = visual;
		view.sync(parseSource(original));
		assert.equal(target.querySelectorAll('.visual-raw').length, 1);
		assert.equal(target.querySelectorAll('.visual-table').length, 1);
		assert.equal(target.querySelectorAll('.visual-math').length, 1);

		view.view.dispatch(view.view.state.tr.insertText('雪', 2));
		const editedText = originalText.replace('\\section{A}', '\\section{A雪}');
		const editedDocument = editor.field(sourceState).projection.document;
		assert.deepEqual(editedDocument.toBytes(), bytes(editedText));
		assert.notEqual(editedDocument.version, original.version);
		assert.equal(editor.field(sourceState).dirty, true);
		assert.ok(historyTransaction(editor, 'undo'));

		const getButtons = () => ({
			raw: target.querySelector<HTMLButtonElement>('.visual-raw button')!,
			table: target.querySelector<HTMLButtonElement>('.visual-table button')!,
			math: target.querySelector<HTMLButtonElement>('.visual-math button')!
		});
		const buttons = getButtons();
		assert.ok(buttons.raw && buttons.table && buttons.math);
		assert.equal(buttons.raw.textContent, 'Edit source');
		assert.equal(buttons.table.textContent, 'Edit table');
		assert.equal(buttons.math.textContent, 'Edit equation');
		assert.equal(view.view.dom.getAttribute('aria-label'), 'language.tex visual editor');

		const pmState = view.view.state, pmDocument = pmState.doc, selection = pmState.selection;
		const sourceBytes = editedDocument.toBytes(), sourceVersion = editedDocument.version;
		const sourceDirty = editor.field(sourceState).dirty, sourceEditorState = editor;
		const assertLocale = (label: string, suffix: string, names: readonly [string, string, string]) => {
			view.setLabel(label);
			view.refresh();
			assert.strictEqual(view.view, visual!.view);
			assert.strictEqual(view.view.state, pmState);
			assert.strictEqual(view.view.state.doc, pmDocument);
			assert.strictEqual(view.view.state.selection, selection);
			assert.strictEqual(editor, sourceEditorState);
			assert.strictEqual(editor.field(sourceState).projection.document, editedDocument);
			assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), sourceBytes);
			assert.equal(editor.field(sourceState).projection.document.version, sourceVersion);
			assert.equal(editor.field(sourceState).dirty, sourceDirty);
			assert.equal(view.view.dom.getAttribute('aria-label'), label + suffix);
			const mounted = getButtons();
			assert.strictEqual(mounted.raw, buttons.raw);
			assert.strictEqual(mounted.table, buttons.table);
			assert.strictEqual(mounted.math, buttons.math);
			assert.equal(buttons.raw.textContent, names[0]);
			assert.equal(buttons.table.textContent, names[1]);
			assert.equal(buttons.math.textContent, names[2]);
		};
		locale = 'zh-Hant';
		assertLocale('中文.tex', ' 視覺編輯', ['編輯原始碼', '編輯表格', '編輯公式']);
		locale = 'en';
		assertLocale('language-en.tex', ' visual editor', ['Edit source', 'Edit table', 'Edit equation']);

		buttons.raw.click();
		buttons.table.click();
		buttons.math.click();
		assert.deepEqual(actions.map(action => action.kind), ['raw', 'table', 'math']);
		for (const action of actions) {
			assert.equal(action.span.documentId, editedDocument.documentId);
			assert.equal(action.span.version, editedDocument.version);
			assert.equal(editedDocument.read(action.span.from, action.span.to), action.value);
		}
		assert.equal(actions[0]!.value, rawText);
		assert.equal(actions[1]!.value, tableText);
		assert.equal(actions[2]!.value, mathText);

		const countBeforeGuards = actions.length;
		readonly = true;
		locale = 'zh-Hant';
		view.setLabel('readonly.tex');
		view.refresh();
		for (const button of Object.values(getButtons())) { assert.equal(button.disabled, true); button.click(); }
		assert.equal(actions.length, countBeforeGuards);
		readonly = false;
		view.refresh();
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'true');

		view.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
			key: 'z', ctrlKey: true, bubbles: true, cancelable: true
		}));
		const undone = editor.field(sourceState).projection.document;
		assert.deepEqual(undone.toBytes(), original.toBytes());
		assert.equal(editor.field(sourceState).dirty, false);
		view.sync(parseSource(undone));
		view.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
			key: 'y', ctrlKey: true, bubbles: true, cancelable: true
		}));
		const redone = editor.field(sourceState).projection.document;
		assert.deepEqual(redone.toBytes(), sourceBytes);
		assert.equal(editor.field(sourceState).dirty, true);
		view.sync(parseSource(redone));

		const beforeStale = editor.field(sourceState).projection.document;
		editor = editor.update({ changes: { from: 0, insert: 'external ' } }).state;
		const stale = editor.field(sourceState).projection.document;
		assert.notEqual(stale.version, beforeStale.version);
		locale = 'zh-Hant';
		view.setLabel('stale.tex');
		view.refresh();
		for (const button of Object.values(getButtons())) { assert.equal(button.disabled, true); button.click(); }
		assert.equal(actions.length, countBeforeGuards);
		view.sync(parseSource(stale));
		const retired = getButtons();
		for (const button of Object.values(retired)) assert.equal(button.disabled, false);
		const countBeforeDispose = actions.length;
		view.dispose();
		for (const button of Object.values(retired)) button.click();
		assert.equal(actions.length, countBeforeDispose);
		assert.equal(target.children.length, 0);
		assert.equal(rejected, 0);
	} finally {
		visual?.dispose();
		dom.window.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
