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
import type { CompileConfig, CompileConfigUpdate } from '@modutex/frontend-contracts';

type DOMWindow = Window & typeof globalThis & { close(): void };

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string }) => { window: DOMWindow };
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const compileSettingsPath = fileURLToPath(
	new URL('../../src/pages/CompileSettings.svelte', import.meta.url)
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

tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-compile-settings-'));
const entryFile = path.join(tempDir, 'entry.js');
fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import CompileSettings from '${compileSettingsPath}';
export { mount, unmount, flushSync, tick, CompileSettings };
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
			fileName: () => 'compile-settings-client.mjs'
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
	'Document',
	'DocumentFragment',
	'Text',
	'Comment',
	'HTMLInputElement',
	'HTMLSelectElement',
	'HTMLOptionElement',
	'HTMLButtonElement',
	'HTMLFieldSetElement',
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

const client = (await import(
	pathToFileURL(path.join(tempDir, 'compile-settings-client.mjs')).href
)) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	CompileSettings: unknown;
};

test('CompileSettings loads workspace compile config, saves profile updates, and reports CONFIG_CONFLICT', async () => {
	const target = dom!.window.document.getElementById('app')!;
	target.innerHTML = '';

	const updates: CompileConfigUpdate[] = [];
	let failConflict = false;
	const baseConfig: CompileConfig = {
		workspaceId: 'ws-1',
		revision: 3,
		mainFile: 'main.tex',
		profile: 'managed',
		engine: 'managed',
		outputDir: null,
		pdf: null,
		log: null,
		customCommand: null,
		canSetCommand: true
	};

	const desktop = {
		async getCompileConfig(workspaceId: string): Promise<CompileConfig> {
			assert.equal(workspaceId, 'ws-1');
			return baseConfig;
		},
		async updateCompileConfig(request: CompileConfigUpdate): Promise<CompileConfig> {
			updates.push(request);
			if (failConflict) throw new Error('CONFIG_CONFLICT');
			return {
				...baseConfig,
				revision: request.expectedRevision + 1,
				mainFile: request.mainFile,
				profile: request.profile,
				engine: request.profile === 'managed' ? 'managed' : 'system',
				outputDir: request.outputDir,
				pdf: request.pdf,
				log: request.log,
				customCommand: request.customCommand
			};
		},
		async readFile() {
			return {
				workspaceId: 'ws-1',
				path: 'main.tex',
				bytes: new TextEncoder().encode(
					'\\documentclass{article}\n\\usepackage[margin=2.5cm]{geometry}\n\\begin{document}\nHello\n\\end{document}\n'
				),
				revision: 'rev-1',
				documentId: 'doc-1',
				documentVersion: 1
			};
		}
	};

	const instance = client.mount(client.CompileSettings, {
		target,
		props: {
			desktop,
			workspace: { id: 'ws-1', label: 'Thesis', entryPath: 'main.tex' },
			entries: [{ path: 'main.tex', kind: 'file' }],
			locale: 'en'
		}
	});
	client.flushSync();

	try {
		const deadline = Date.now() + 5000;
		while (
			Date.now() < deadline &&
			(target.querySelector('#compile-main-file') as HTMLSelectElement | null)?.value !== 'main.tex'
		) {
			await new Promise((r) => setTimeout(r, 20));
			client.flushSync();
		}

		const profileSelect = target.querySelector('#compile-profile') as HTMLSelectElement;
		assert.equal(profileSelect.value, 'managed');
		profileSelect.value = 'system';
		profileSelect.dispatchEvent(new dom!.window.Event('change', { bubbles: true }));
		client.flushSync();

		const saveBtn = [...target.querySelectorAll('button')].find((btn) =>
			btn.textContent?.includes('Save workspace compile settings')
		)!;
		saveBtn.click();
		await new Promise((r) => setTimeout(r, 30));
		client.flushSync();

		assert.equal(updates.length, 1);
		assert.equal(updates[0]!.profile, 'system');
		assert.equal(updates[0]!.expectedRevision, 3);

		// Simulate CONFIG_CONFLICT on next save
		failConflict = true;
		saveBtn.click();
		await new Promise((r) => setTimeout(r, 30));
		client.flushSync();
		assert.match(
			target.querySelector('[role="alert"]')?.textContent ?? '',
			/Configuration changed elsewhere/
		);
	} finally {
		await client.unmount(instance);
	}
});
