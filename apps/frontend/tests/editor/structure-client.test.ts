import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { ParserRequest, ParserReply } from '../../src/features/parser/engine.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('mounted SourceView structure menu preserves live edits, focus and cancellation with a delayed real parser', { timeout: 120_000 }, async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modutex-structure-client-'));
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { url: 'https://modutex.test', pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const install = (key: string, value: unknown) => {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	};
	for (const key of ['window', 'document', 'navigator', 'location', 'MutationObserver', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'Text', 'Comment', 'Document', 'DocumentFragment', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'InputEvent', 'Range', 'Selection', 'DOMParser', 'customElements', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
		install(key, typeof dom.window[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key]);
	}
	const rect = () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() { return {}; } });
	for (const prototype of [dom.window.Element.prototype, dom.window.Range.prototype]) {
		prototype.getBoundingClientRect = rect;
		prototype.getClientRects = () => [rect()];
	}
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	const sourcePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url)).replaceAll('\\', '/');
	const entry = path.join(directory, 'entry.js');
	fs.writeFileSync(entry, [
		`export { mount, unmount, flushSync, tick } from 'svelte';`,
		`export { EditorView } from '@codemirror/view';`,
		`export { default as SourceView } from ${JSON.stringify(sourcePath('../../src/features/source-editor/SourceView.svelte'))};`,
		`export { SourceDocument } from ${JSON.stringify(sourcePath('../../src/features/document-core/core.ts'))};`,
		`export { ParserEngine } from ${JSON.stringify(sourcePath('../../src/features/parser/engine.ts'))};`,
		`export { sourceState, historyTransaction } from ${JSON.stringify(sourcePath('../../src/features/source-editor/state.ts'))};`
	].join('\n'));
	let component: unknown;
	let runtime: any;
	const workers: Array<{ drain(): void; terminate(): void }> = [];
	try {
		await build({ root: sourcePath('../..'), configFile: false, worker: { format: 'es' }, plugins: [svelte({ emitCss: false })],
			resolve: { dedupe: ['svelte', '@codemirror/state', '@codemirror/view'], conditions: ['browser', 'default'] },
			build: { outDir: directory, emptyOutDir: false, lib: { entry, formats: ['es'], fileName: () => 'client.mjs' } }, logLevel: 'silent' });
		runtime = await import(pathToFileURL(path.join(directory, 'client.mjs')).href);
		// Only scheduling is controlled. Every reset/patch/parse runs the production
		// ParserEngine and Rust WASM parser, including its version checks.
		install('Worker', class {
			onmessage: ((event: { data: ParserReply }) => void) | null = null;
			onerror = null;
			engine = new runtime.ParserEngine();
			queue: ParserRequest[] = [];
			constructor() { workers.push(this); }
			postMessage(request: ParserRequest) { this.queue.push(request); }
			drain() {
				for (let count = 0; this.queue.length; count++) {
					assert.ok(count < 500, 'parser queue must converge');
					this.onmessage?.({ data: this.engine.handle(this.queue.shift()!) });
				}
			}
			terminate() { this.queue = []; this.onmessage = null; }
		});
		const target = dom.window.document.getElementById('target') as HTMLElement;
		const original = runtime.SourceDocument.open(new TextEncoder().encode('\uFEFF\\begin{document}\r\n\\par\r\n\\section{Neighbor}\r\n\\end{document}'));
		const rejected: string[] = [];
		const published: number[] = [];
		component = runtime.mount(runtime.SourceView, { target, props: {
			document: original, label: 'test.tex', saving: false, savedVersion: null,
			onChange() {}, onProjection: (projection: { version: number }) => published.push(projection.version), onRejected: () => rejected.push('source'),
			onVisualRejected: () => rejected.push('visual'), onParserFailure: () => rejected.push('parser')
		} });
		const settle = async (drain = true) => {
			runtime.flushSync();
			if (drain) workers.forEach(worker => worker.drain());
			await runtime.tick(); runtime.flushSync();
		};
		await settle();
		const editor = runtime.EditorView.findFromDOM(target.querySelector('.cm-editor'));
		const source = () => editor.state.field(runtime.sourceState).projection.document;
		const paste = (text: string) => {
			const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: { getData: (mime: string) => mime === 'text/plain' ? text : '', items: [], files: [] } });
			target.querySelector('.ProseMirror')!.dispatchEvent(event);
		};
		const choose = (kind: string) => {
			const button = target.querySelector(`[data-structure="${kind}"]`) as HTMLButtonElement;
			assert.equal(button.disabled, false); button.focus(); button.click(); runtime.flushSync();
			assert.equal(target.querySelector('.tool-error'), null);
		};
		const text = '繁體\u{20000} e\u0301 ' + String.fromCodePoint(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb) + ' العربية\u00A0\u3000 100% & $';
		paste(text);
		assert.deepEqual(rejected, [], 'typing must not be rejected');
		assert.ok(source().read().includes('繁體'), 'paste updates the authoritative source');
		// Do not acknowledge any typing. The actual menu must use the advanced
		// source anchors and synchronously select the newly converted cell.
		for (const kind of ['abstract', 'title', 'paragraph', 'title', 'abstract', 'subsection', 'paragraph']) {
			choose(kind);
			const cells = target.querySelectorAll('.notebook-cell');
			assert.equal(cells.length, 2);
			assert.equal(cells[0]!.textContent, text, `${kind}: ${source().read()}`);
			assert.equal(cells[1]!.textContent, 'Neighbor');
			assert.equal(target.querySelectorAll('.is-selected').length, 1);
			assert.equal(published.at(-1), source().version, 'outline and other tools share the immediately committed projection');
		}
		await settle();
		paste('追加'); choose('abstract');
		assert.equal(target.querySelector('.notebook-cell')!.textContent, text + '追加');
		const stable = source().toBytes();
		const cancel = [...target.querySelectorAll('button')].find(button => button.textContent === '取消編輯')!;
		cancel.click(); await settle();
		assert.deepEqual(source().toBytes(), stable, 'Cancel cannot restore a wrapper from before the last structure change');
		// Source/visual round trips cannot alter the structure or stored content.
		for (let i = 0; i < 3; i++) for (const label of ['原始碼', '視覺化']) {
			const button = target.querySelector(`.modes button[aria-label="${label}"]`) as HTMLButtonElement;
			assert.ok(button); button.click(); await settle();
			assert.deepEqual(source().toBytes(), stable);
		}
		const undo = runtime.historyTransaction(editor.state, 'undo');
		editor.dispatch(undo); await settle();
		editor.dispatch(runtime.historyTransaction(editor.state, 'redo')); await settle();
		assert.deepEqual(source().toBytes(), stable);
		assert.deepEqual(rejected, []);
	} finally {
		if (component && runtime) { const pending = runtime.unmount(component); runtime.flushSync(); await pending; }
		workers.forEach(worker => worker.terminate());
		dom.window.close();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
