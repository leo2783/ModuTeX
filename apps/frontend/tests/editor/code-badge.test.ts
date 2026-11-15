import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { codeSource } from '../../src/features/code/source.ts';
import { parseSource, SourceDocument } from '../../src/features/document-core/core.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('code cell badges match the real code NodeView while custom listings retain raw source controls', () => {
	for (const locale of ['zh-Hant', 'en'] as const) {
		for (const [body, supported] of [
			[codeSource('literal text'), true],
			[codeSource('print("literal")', false, 'python'), true],
			['\\begin{verbatim}\nlegacy\n\\end{verbatim}', true],
			['\\begin{verbatim*}\nlegacy spaces\n\\end{verbatim*}', true],
			['\\begin{lstlisting}[language=Python,breaklines=false]\ncustom\n\\end{lstlisting}', false]
		] as const) {
			const dom = new JSDOM('<!doctype html><body><div id="editor"></div><div id="toolbar"></div></body>', { pretendToBeVisual: true });
			const saved = new Map<string, PropertyDescriptor | undefined>();
			for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
				saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
				Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
			}
			const source = SourceDocument.open(new TextEncoder().encode('\\begin{document}\n' + body + '\n\\end{document}'));
			const toolbar = dom.window.document.getElementById('toolbar');
			const visual = new VisualEditor(dom.window.document.getElementById('editor'), 'main.tex', {
				source: () => source, readOnly: () => false, locale: () => locale, status: () => {}, history: () => false,
				apply: () => { throw new Error('Badge rendering must not change source'); }, rejected: () => assert.fail('Unexpected rejection'),
				cellToolbar: element => toolbar.replaceChildren(...(element ? [element] : []))
			});
			try {
				visual.sync(parseSource(source));
				const raw = dom.window.document.querySelector('.visual-raw');
				assert.ok(raw);
				raw.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
				assert.equal(toolbar.querySelector('.cell-badge')?.textContent, supported ? (locale === 'en' ? 'Code' : '程式碼') : (locale === 'en' ? 'Raw LaTeX' : '原始碼'));
				assert.equal(raw.querySelector('button')?.getAttribute('data-code'), String(supported));
				assert.equal(!!raw.querySelector('pre.code-content'), supported);
				assert.equal(!!raw.querySelector('pre.raw-latex'), !supported);
			} finally {
				visual.dispose(); dom.window.close();
				for (const [key, descriptor] of saved) {
					if (descriptor) Object.defineProperty(globalThis, key, descriptor);
					else Reflect.deleteProperty(globalThis, key);
				}
			}
		}
	}
});
