import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } };
};
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://modutex.test' });
const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const fileTreePath = fileURLToPath(new URL('../../src/components/FileTree.svelte', import.meta.url)).replaceAll('\\', '/');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tree-create-context-'));
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['window', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'CharacterData', 'Attr', 'Document', 'DocumentFragment', 'HTMLButtonElement', 'HTMLDetailsElement', 'HTMLSummaryElement', 'Event', 'EventTarget', 'KeyboardEvent', 'MouseEvent', 'MutationObserver']) {
	previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	const value = Reflect.get(dom.window, key);
	if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const harnessPath = path.join(tempDir, 'FileTreeHarness.svelte').replaceAll('\\', '/');
const entryPath = path.join(tempDir, 'entry.js');
fs.writeFileSync(harnessPath, `<script lang="ts">
	import FileTree from '${fileTreePath}';
	let { onCreate }: { onCreate: (parentPath?: string) => void } = $props();
</script>
<FileTree entries={[{ path: 'chapters/intro.tex', kind: 'file' }]} selected="chapters/intro.tex" disabled={false} onOpen={() => {}} onNewWorkspaceFile={onCreate} locale="en" />
`);
fs.writeFileSync(entryPath, `import { mount, unmount, flushSync } from 'svelte';
import FileTreeHarness from '${harnessPath}';
export { mount, unmount, flushSync, FileTreeHarness };
`);
await build({
	configFile: false,
	root: frontendRoot,
	plugins: [svelte({ emitCss: false })],
	resolve: { dedupe: ['svelte'], conditions: ['browser', 'default'] },
	build: {
		write: true,
		outDir: tempDir,
		emptyOutDir: false,
		lib: { entry: entryPath, formats: ['es'], fileName: () => 'file-tree-client.mjs' },
		sourcemap: false,
		minify: false
	},
	logLevel: 'silent'
});
const client = await import(pathToFileURL(path.join(tempDir, 'file-tree-client.mjs')).href) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (component: unknown) => Promise<void>;
	flushSync: () => void;
	FileTreeHarness: unknown;
};

after(async () => {
	try {
		dom.window.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	} finally {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test('folder context action passes the workspace-relative parent path to file creation', async () => {
	const target = dom.window.document.getElementById('app');
	assert.ok(target);
	let createdIn: string | undefined;
	const instance = client.mount(client.FileTreeHarness, { target, props: { onCreate: (path: string) => { createdIn = path; } } });
	client.flushSync();
	try {
		const folder = target.querySelector<HTMLElement>('.tree-folder > summary');
		assert.ok(folder);
		folder.dispatchEvent(new dom.window.MouseEvent('contextmenu', {
			button: 2,
			bubbles: true,
			cancelable: true,
			clientX: 24,
			clientY: 32
		}));
		await new Promise((resolve) => setTimeout(resolve, 0));
		client.flushSync();
		const menu = target.querySelector<HTMLElement>('.file-context-menu');
		assert.ok(menu);
		const createAction = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent?.includes('Create file in this folder'));
		assert.ok(createAction);
		createAction.click();
		client.flushSync();
		assert.equal(createdIn, 'chapters');
		assert.equal(target.querySelector('.file-context-menu'), null, 'the context menu closes after selection');
	} finally {
		await client.unmount(instance);
	}
});
