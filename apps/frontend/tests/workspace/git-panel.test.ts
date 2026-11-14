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

type DOMWindow = Window & typeof globalThis & { close(): void };

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string }) => { window: DOMWindow };
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const gitPanelPath = fileURLToPath(
	new URL('../../src/features/git/GitPanel.svelte', import.meta.url)
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

tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-git-panel-'));
const entryFile = path.join(tempDir, 'entry.js');
fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import GitPanel from '${gitPanelPath}';
export { mount, unmount, flushSync, tick, GitPanel };
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
			fileName: () => 'git-panel-client.mjs'
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

previousDescriptors.set('isTauri', Object.getOwnPropertyDescriptor(globalThis, 'isTauri'));
const calls: { cmd: string; args: unknown }[] = [];
const tauriInternals = {
	invoke: async (cmd: string, args?: unknown) => {
		calls.push({ cmd, args });
		switch (cmd) {
			case 'frontend_git_availability':
				return { status: 'available' };
			case 'frontend_git_status':
				return {
					entries: [
						{
							path: 'main.tex',
							originalPath: null,
							index: 'UNCHANGED',
							worktree: 'MODIFIED'
						}
					]
				};
			case 'frontend_git_user_name':
				return 'Alice';
			case 'frontend_git_stage':
				return null;
			default:
				throw new Error(`Unexpected command ${cmd}`);
		}
	}
};
Object.defineProperty(dom.window, '__TAURI_INTERNALS__', {
	value: tauriInternals,
	configurable: true,
	writable: true
});
Object.defineProperty(globalThis, 'isTauri', {
	value: true,
	configurable: true,
	writable: true
});

const client = (await import(pathToFileURL(path.join(tempDir, 'git-panel-client.mjs')).href)) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	GitPanel: unknown;
};

test('GitPanel loads repository status and userName and stages all changes through host commands', async () => {
	const target = dom!.window.document.getElementById('app')!;
	target.innerHTML = '';
	calls.length = 0;

	const instance = client.mount(client.GitPanel, {
		target,
		props: {
			workspaceId: 'ws-1',
			locale: 'en'
		}
	});
	client.flushSync();

	try {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !target.textContent?.includes('main.tex')) {
			await new Promise((r) => setTimeout(r, 20));
			client.flushSync();
		}
		assert.match(target.textContent ?? '', /main\.tex/);
		assert.match(target.textContent ?? '', /Alice/);

		const stageAllBtn = [...target.querySelectorAll('button')].find(
			(btn) => btn.textContent?.trim() === 'Stage all'
		);
		assert.ok(stageAllBtn, 'Stage all button should be rendered');
		stageAllBtn.click();
		await new Promise((r) => setTimeout(r, 40));
		client.flushSync();

		assert.ok(calls.some((call) => call.cmd === 'frontend_git_stage'));
	} finally {
		await client.unmount(instance);
	}
});
