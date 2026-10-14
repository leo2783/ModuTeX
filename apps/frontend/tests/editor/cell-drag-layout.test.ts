import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { cellDragHandle, disposeCellDragHandle } from '../../src/features/visual-editor/cell-drag.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('drag gutters batch rectangle reads before writes and cancel all queued work on dispose', () => {
	const dom = new JSDOM('<div class="ProseMirror"></div>'), win = dom.window;
	const frames = new Map<number, FrameRequestCallback>(); let sequence = 0, queries = 0, disconnected = 0;
	win.requestAnimationFrame = (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; };
	win.cancelAnimationFrame = (id: number) => frames.delete(id);
	const callbacks: (() => void)[] = [];
	win.ResizeObserver = class {
		constructor(callback: () => void) { callbacks.push(callback); }
		observe() {} disconnect() { disconnected++; }
	};
	const doc = win.document, root = doc.querySelector('.ProseMirror');
	const handles: HTMLElement[] = [], wrappers: HTMLElement[] = [];
	const query = doc.querySelectorAll.bind(doc);
	doc.querySelectorAll = (selector: string) => { queries++; return query(selector); };
	try {
		for (let i = 0; i < 3; i++) {
			const wrapper = cellDragHandle(doc, i, true, 'Drag', () => null, () => {});
			const node = doc.createElement('div'); node.dataset.cellIndex = String(i);
			const rect = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 100, width: 100, height, toJSON() {} });
			node.getBoundingClientRect = () => { assert.ok(handles.every(handle => handle.style.height === '')); return rect(i * 100 + 10, 40 + i); };
			wrapper.getBoundingClientRect = () => rect(i * 100, 0);
			root.append(wrapper, node); wrappers.push(wrapper); handles.push(wrapper.querySelector('button')!);
		}
		assert.equal(frames.size, 1, 'one shared RAF for all gutters');
		const initial = [...frames.values()][0]!; frames.clear(); initial(0);
		assert.equal(queries, 1, 'one cell inventory, not a query per handle');
		assert.deepEqual(handles.map(handle => handle.style.top), ['10px', '10px', '10px']);
		assert.deepEqual(handles.map(handle => handle.style.height), ['40px', '41px', '42px']);
		for (const callback of callbacks) callback();
		assert.equal(frames.size, 1, 'resize notifications are coalesced');
		for (const wrapper of wrappers) disposeCellDragHandle(wrapper);
		assert.equal(frames.size, 0); assert.equal(disconnected, 3);
	} finally { for (const wrapper of wrappers) disposeCellDragHandle(wrapper); dom.window.close(); }
});
