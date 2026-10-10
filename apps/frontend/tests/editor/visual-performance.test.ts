import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourcePatchTransaction, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
import type { Language } from '../../src/i18n/text.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('typing and refresh preserve Raw DOM while source anchors, selection, locale and read-only gates remain current', () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true,
			value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(new TextEncoder().encode('\uFEFF\\section{A}\r\nBody \\opaque{keep}'));
	let editor = createSourceState(original), readonly = false, language: Language = 'zh-Hant';
	const actions: SourceSpan[] = [];
	const target = dom.window.document.getElementById('target') as HTMLElement;
	const view = new VisualEditor(target, 'main.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: () => false, readOnly: () => readonly, locale: () => language,
		rejected: () => assert.fail('valid typing was rejected'), status: () => {}, raw: (_source, span) => actions.push(span)
	});
	try {
		view.sync(parseSource(original));
		const code = target.querySelector('.raw-latex')!;
		const button = target.querySelector('.visual-raw button') as HTMLButtonElement;
		const codeText = code.firstChild, buttonText = button.firstChild;
		const observer = new dom.window.MutationObserver(() => {});
		observer.observe(code.parentElement!, { subtree: true, childList: true, attributes: true, characterData: true });
		const typing = view.view.state.tr.insertText('雪', 2);
		const expectedSelection = typing.selection.from;
		view.view.dispatch(typing);
		view.refresh();
		assert.deepEqual(observer.takeRecords(), [], 'unchanged Raw content must not be rewritten on typing or refresh');
		assert.equal(target.querySelector('.raw-latex'), code);
		assert.equal(target.querySelector('.visual-raw button'), button);
		assert.equal(view.view.state.selection.from, expectedSelection);
		assert.equal(code.firstChild, codeText); assert.equal(button.firstChild, buttonText);
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), new TextEncoder().encode('\uFEFF\\section{A雪}\r\nBody \\opaque{keep}'));
		button.click(); assert.equal(actions.length, 1);
		assert.equal(actions[0]!.from, original.read().indexOf('\\opaque') + 1);
		assert.equal(actions[0]!.version, editor.field(sourceState).projection.document.version);
		language = 'en'; view.refresh();
		assert.equal(button.textContent, 'Edit source');
		assert.equal(view.view.dom.getAttribute('aria-label'), 'main.tex visual editor');
		readonly = true; view.refresh(); assert.equal(button.disabled, true);
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'false'); button.click(); assert.equal(actions.length, 1);
		readonly = false; view.refresh(); assert.equal(button.disabled, false);
		assert.equal(view.view.dom.getAttribute('contenteditable'), 'true');
		editor = historyTransaction(editor, 'undo')!.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		observer.disconnect(); view.dispose(); button.click(); assert.equal(actions.length, 1);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});
