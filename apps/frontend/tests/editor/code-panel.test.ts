// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { CodeDraft } from '../../src/features/code/source.ts';

type DOMWindow = Window & typeof globalThis & { close(): void };

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string }) => { window: DOMWindow };
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const codePanelPath = fileURLToPath(
	new URL('../../src/features/code/CodePanel.svelte', import.meta.url)
).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;
const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

function restoreGlobals(): void {
	for (const [key, descriptor] of previousDescriptors) {
		try {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
			else Object.defineProperty(globalThis, key, descriptor);
		} catch {
			// Ignore non-configurable globals
		}
	}
	previousDescriptors.clear();
}

test.after(() => {
	if (dom) {
		try {
			dom.window.close();
		} catch {
			// Ignore close errors
		}
		dom = null;
	}
	restoreGlobals();
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-code-panel-'));
const entryFile = path.join(tempDir, 'entry.js');
fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import CodePanel from '${codePanelPath}';
export { mount, unmount, flushSync, tick, CodePanel };
`
);

await build({
	configFile: false,
	root: frontendRoot,
	plugins: [svelte()],
	resolve: { conditions: ['browser', 'default'] },
	build: {
		write: true,
		outDir: tempDir,
		emptyOutDir: false,
		lib: {
			entry: entryFile,
			formats: ['es'],
			fileName: () => 'code-panel-client.mjs'
		},
		sourcemap: false,
		minify: false
	},
	logLevel: 'silent'
});

dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
	url: 'https://modutex.test/'
});

for (const key of [
	'window',
	'document',
	'navigator',
	'location',
	'Node',
	'Element',
	'HTMLElement',
	'HTMLMediaElement',
	'Document',
	'DocumentFragment',
	'Text',
	'Comment',
	'HTMLInputElement',
	'HTMLSelectElement',
	'HTMLOptionElement',
	'HTMLButtonElement',
	'HTMLTextAreaElement',
	'HTMLPreElement',
	'Event',
	'EventTarget',
	'CustomEvent',
	'KeyboardEvent',
	'MouseEvent',
	'InputEvent',
	'MutationObserver'
] as const) {
	previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	if (key in dom.window) {
		Object.defineProperty(globalThis, key, {
			value: Reflect.get(dom.window, key),
			configurable: true,
			writable: true
		});
	}
}

const client = (await import(pathToFileURL(path.join(tempDir, 'code-panel-client.mjs')).href)) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	CodePanel: unknown;
};

test('CodePanel inserts verbatim block, rejects forbidden end delimiter, and supports edit/Escape/Ctrl+Enter', async () => {
	const target = dom!.window.document.getElementById('app')!;
	target.innerHTML = '';
	const inserted: string[] = [];
	const applied: CodeDraft[] = [];
	let closed = 0;

	const instance = client.mount(client.CodePanel, {
		target,
		props: {
			active: true,
			initialDraft: { code: 'const x = 1;', language: 'javascript' },
			sessionKey: 'session-1',
			editing: false,
			locale: 'en',
			onInsert: (src: string) => inserted.push(src),
			onApply: (draft: CodeDraft) => applied.push(draft),
			onClose: () => {
				closed++;
			}
		}
	});
	client.flushSync();
	await client.tick();

	try {
		const textarea = target.querySelector('#code-source-input') as HTMLTextAreaElement;
		assert.ok(textarea);
		assert.equal(textarea.value, 'const x = 1;');

		// Forbidden delimiter must show alert and not call onInsert
		textarea.value = 'bad \\end{verbatim} code';
		textarea.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
		client.flushSync();

		const confirmBtn = target.querySelector('.btn-confirm') as HTMLButtonElement;
		confirmBtn.click();
		client.flushSync();
		assert.equal(inserted.length, 0);
		assert.match(target.querySelector('[role="alert"]')?.textContent ?? '', /\\end\{verbatim\}/);

		// Valid code with Ctrl+Enter inserts lstlisting source
		textarea.value = 'print("ok")';
		textarea.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
		client.flushSync();
		textarea.dispatchEvent(
			new dom!.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
		);
		client.flushSync();
		assert.equal(inserted.length, 1);
		assert.match(inserted[0]!, /\\begin\{lstlisting\}/);
		assert.match(inserted[0]!, /print\("ok"\)/);

		// Escape triggers onClose
		textarea.dispatchEvent(
			new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
		);
		client.flushSync();
		assert.equal(closed, 1);
	} finally {
		await client.unmount(instance);
	}
});
