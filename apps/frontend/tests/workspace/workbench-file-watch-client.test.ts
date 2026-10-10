import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { build, createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { FileEvent, FileRef, FileWatchFailure, WriteRequest } from '@modutex/frontend-contracts';
import type { FrontendFiles as FilesHost } from '../../../../electron/src/frontend-files.ts';

type BrowserWindow = Window & typeof globalThis & { close(): void };
type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement }) => unknown;
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	App: unknown;
};
type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
};
type NativeBridge = {
	openWorkspace(kind: 'file' | 'folder'): Promise<unknown>;
	listRecent(): Promise<unknown>;
	openRecent(id: string): Promise<unknown>;
	removeRecent(id: string): Promise<unknown>;
	listFiles(id: string): Promise<unknown>;
	readFile(file: FileRef): Promise<unknown>;
	writeFile(request: WriteRequest): Promise<unknown>;
	saveAs(request: unknown): Promise<unknown>;
	startCompile(request: unknown): Promise<unknown>;
	compileResult(id: string): Promise<unknown>;
	cancelCompile(id: string): Promise<unknown>;
	closeWorkspace(id: string): Promise<unknown>;
	startWatch(workspaceId: string, subscriptionId: string): Promise<unknown>;
	stopWatch(subscriptionId: string): Promise<unknown>;
	onWatchEvent(listener: (value: unknown) => void): () => void;
	onWatchError(listener: (value: unknown) => void): () => void;
};

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string; pretendToBeVisual?: boolean }) => { window: BrowserWindow };
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function waitFor<T>(read: () => T | undefined, milliseconds = 10_000, pump?: () => Promise<void> | void): Promise<T> {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (pump) await pump();
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('Timed out waiting for mounted workbench filesystem result');
}

function installBrowserGlobals(win: BrowserWindow, previous: Map<string, PropertyDescriptor | undefined>) {
	const keys = [
		'window', 'Window', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement', 'Document',
		'DocumentFragment', 'Text', 'Comment', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLDivElement',
		'HTMLParagraphElement', 'HTMLHeadingElement', 'HTMLSpanElement', 'HTMLTextAreaElement',
		'HTMLMediaElement', 'HTMLSelectElement', 'HTMLCanvasElement', 'HTMLTableElement', 'HTMLTableSectionElement', 'HTMLTableRowElement',
		'HTMLTableCellElement', 'HTMLFieldSetElement', 'HTMLFormElement', 'HTMLAnchorElement',
		'Event', 'EventTarget', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'MutationObserver',
		'Range', 'DOMRect', 'Selection', 'NodeFilter', 'getComputedStyle'
	] as const;
	for (const key of keys) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		const value = (win as unknown as Record<string, unknown>)[key];
		if (value !== undefined) {
			Object.defineProperty(globalThis, key, {
				value: key === 'getComputedStyle' && typeof value === 'function'
					? value.bind(win)
					: value,
				writable: true,
				configurable: true
			});
		}
	}
	previous.set('requestAnimationFrame', Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'));
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		value: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		writable: true,
		configurable: true
	});
	previous.set('cancelAnimationFrame', Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'));
	Object.defineProperty(globalThis, 'cancelAnimationFrame', {
		value: (id: number) => clearTimeout(id),
		writable: true,
		configurable: true
	});

	class ObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	for (const key of ['ResizeObserver', 'IntersectionObserver']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value: ObserverStub, writable: true, configurable: true });
		Object.defineProperty(win, key, { value: ObserverStub, configurable: true });
	}
	Object.defineProperty(win, 'matchMedia', {
		configurable: true,
		value: (media: string) => ({
			// This filesystem scenario uses the wide workbench's visible file sidebar.
			matches: media === '(min-width: 961px)',
			media,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent() { return false; }
		})
	});
}

function restoreGlobals(previous: Map<string, PropertyDescriptor | undefined>) {
	for (const [key, descriptor] of previous) {
		try {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
			else Object.defineProperty(globalThis, key, descriptor);
		} catch {
			// Continue restoring the remaining globals.
		}
	}
	previous.clear();
}

test('mounted App reconciles real host watch events and preserves source ownership', { timeout: 180_000 }, async () => {
	const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
	const appPath = fileURLToPath(new URL('../../src/App.svelte', import.meta.url)).replaceAll('\\', '/');
	const server = await createServer({
		root: frontendRoot,
		server: { middlewareMode: true, hmr: false, ws: false },
		logLevel: 'error'
	});
	const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
	const buildDir = fs.mkdtempSync(join(tmpdir(), 'workbench-file-watch-client-'));
	let fixtureDir: string | null = null;
	let dom: { window: BrowserWindow } | null = null;
	let client: ClientModule | null = null;
	let mounted: unknown;
	let files: FilesHost | null = null;
	let readGate: {
		readonly path: string;
		readonly entered: Deferred<void>;
		readonly release: Deferred<void>;
		used: boolean;
	} | null = null;
	const activeWatches = new Map<string, InstanceType<any>>();
	const eventListeners = new Set<(value: unknown) => void>();
	const errorListeners = new Set<(value: unknown) => void>();
	let emittedCount = 0;
	let listCount = 0;
	let writeCount = 0;
	let openCount = 0;

	try {
		fixtureDir = await mkdtemp(join(tmpdir(), 'modutex-workbench-files-'));
		const roots = ['first', 'second', 'third'].map((name) => join(fixtureDir!, name));
		const fileNames = ['first.tex', 'second.tex', 'third.tex'];
		const initialTexts = [
			'\\documentclass{article}\n\\begin{document}\nBASE_FIRST\n\\end{document}\n',
			'\\documentclass{article}\n\\begin{document}\nBASE_SECOND\n\\end{document}\n',
			'\\documentclass{article}\n\\begin{document}\nBASE_THIRD\n\\end{document}\n'
		];
		for (let i = 0; i < roots.length; i++) {
			await mkdir(roots[i]!);
			await writeFile(join(roots[i]!, fileNames[i]!), initialTexts[i]!, 'utf8');
		}

		const { FrontendFiles } = await server.ssrLoadModule(
			fileURLToPath(new URL('../../../../electron/src/frontend-files.ts', import.meta.url))
		);
		const { FrontendWatch } = await server.ssrLoadModule(
			fileURLToPath(new URL('../../../../electron/src/frontend-watch.ts', import.meta.url))
		);
		files = new FrontendFiles();
		let openIndex = 0;
		const pushWatchError = (subscriptionId: string, failure: unknown) => {
			for (const listener of errorListeners) listener({ subscriptionId, error: failure });
		};
		const stopAllNativeWatches = (failure?: FileWatchFailure) => {
			for (const [subscriptionId, watcher] of [...activeWatches]) {
				activeWatches.delete(subscriptionId);
				watcher.stop();
				if (failure) pushWatchError(subscriptionId, failure);
			}
		};
		const native: NativeBridge = {
			openWorkspace: async (kind) => {
				openCount++;
				stopAllNativeWatches('STALE_WORKSPACE');
				const root = roots[Math.min(openIndex++, roots.length - 1)]!;
				return files!.open(root, kind);
			},
			listRecent: async () => [],
			openRecent: async () => files!.open(roots[0]!, 'folder'),
			removeRecent: async () => {},
			listFiles: async (id) => {
				listCount++;
				return files!.list(id);
			},
			readFile: async (ref) => {
				const receipt = await files!.read(ref);
				const gate = readGate;
				if (gate && !gate.used && ref.path === gate.path) {
					gate.used = true;
					gate.entered.resolve(undefined);
					await gate.release.promise;
				}
				return receipt;
			},
			writeFile: async (request) => {
				writeCount++;
				return files!.write(request);
			},
			saveAs: async () => null,
			startCompile: async () => null,
			compileResult: async () => null,
			cancelCompile: async () => {},
			closeWorkspace: async (id) => {
				stopAllNativeWatches();
				files!.close(id);
			},
			startWatch: async (id, subscriptionId) => {
				const owner = files!.compileOwner();
				const assertWorkspace = files!.saveAsOwner(id);
				let watcher!: InstanceType<typeof FrontendWatch>;
				watcher = new FrontendWatch({
					root: owner.root,
					workspaceId: id,
					assertCurrent() {
						assertWorkspace();
						owner.assertCurrent();
						if (activeWatches.get(subscriptionId) !== watcher) throw new Error('STALE_WORKSPACE');
					},
					emit(event: FileEvent) {
						if (activeWatches.get(subscriptionId) !== watcher) return;
						emittedCount++;
						for (const listener of eventListeners) listener({ subscriptionId, event });
					},
					onError(failure: FileWatchFailure) {
						if (activeWatches.get(subscriptionId) !== watcher) return;
						activeWatches.delete(subscriptionId);
						pushWatchError(subscriptionId, failure);
					}
				});
				activeWatches.set(subscriptionId, watcher);
				try {
					await watcher.start();
				} catch (error) {
					if (activeWatches.get(subscriptionId) === watcher) activeWatches.delete(subscriptionId);
					watcher.stop();
					throw error;
				}
			},
			stopWatch: async (subscriptionId) => {
				const watcher = activeWatches.get(subscriptionId);
				if (watcher) {
					activeWatches.delete(subscriptionId);
					watcher.stop();
				}
			},
			onWatchEvent: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			onWatchError: (listener) => {
				errorListeners.add(listener);
				return () => errorListeners.delete(listener);
			}
		};

		const normalizedEntry = join(buildDir, 'entry.js').replaceAll('\\', '/');
		fs.writeFileSync(normalizedEntry, `import { mount, unmount, flushSync, tick } from 'svelte';
import App from ${JSON.stringify(appPath)};
export { mount, unmount, flushSync, tick, App };
`);
		await build({
			configFile: false,
			root: frontendRoot,
			plugins: [svelte({ emitCss: false })],
			resolve: { dedupe: ['svelte'], conditions: ['browser', 'default'] },
			build: {
				write: true,
				outDir: buildDir,
				emptyOutDir: false,
				lib: {
					entry: normalizedEntry,
					formats: ['es'],
					fileName: () => 'workbench-file-watch-client.mjs'
				},
				sourcemap: false,
				minify: false
			},
			logLevel: 'silent'
		});

		dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
			url: 'https://modutex.test/#/workbench',
			pretendToBeVisual: true
		});
		installBrowserGlobals(dom.window, previousGlobals);
		// JSDOM lacks layout measurement; actual geometry is checked in Chromium.
		Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [] });
		Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom!.window.DOMRect() });
		Object.defineProperty(dom.window, 'modutexFiles', { value: native, configurable: true });
		let confirmCount = 0;
		Object.defineProperty(dom.window, 'confirm', {
			configurable: true,
			value: () => { confirmCount++; return true; }
		});
		client = await import(pathToFileURL(join(buildDir, 'workbench-file-watch-client.mjs')).href) as ClientModule;
		const api = client;
		const container = dom.window.document.getElementById('app');
		assert.ok(container);
		mounted = api.mount(api.App, { target: container });
		api.flushSync();
		await api.tick();
		await api.tick();
		api.flushSync();

		const flush = async () => {
			api.flushSync();
			await api.tick();
			await api.tick();
			api.flushSync();
		};
		const editorText = () => container.querySelector('.cm-content')?.textContent ?? '';
		const findButton = (
			predicate: (text: string) => boolean,
			scope: ParentNode = container
		) => Array.from(scope.querySelectorAll('button'))
			.find((button) => predicate(button.textContent?.trim() ?? ''));
		const globalButton = (english: string, chinese: string) =>
			findButton((label) => label === english || label === chinese, container.querySelector('.global-actions') ?? container);
		const findFileRow = (name: string) =>
			Array.from(container.querySelectorAll<HTMLButtonElement>('.files button.file-row'))
				.find((button) => button.textContent?.trim() === name);
		const waitForSource = (marker: string) =>
			waitFor(() => editorText().includes(marker) ? editorText() : undefined, 10_000, flush);
		const pasteIntoSource = (value: string) => {
			const content = container.querySelector<HTMLElement>('.cm-content');
			assert.ok(content, 'Mounted CodeMirror content must exist before editing');
			content.focus();
			const event = new dom!.window.Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', {
				value: {
					types: ['text/plain'],
					files: [],
					getData: (type: string) => type === 'text/plain' ? value : ''
				}
			});
			content.dispatchEvent(event);
			api.flushSync();
		};
		const openFolder = async (fileName: string, marker: string) => {
			const button = await waitFor(() => globalButton('Open folder', '開啟資料夾'), 10_000, flush);
			assert.ok(button, 'Workbench folder action must be available');
			button.click();
			await flush();
			const row = await waitFor(() => findFileRow(fileName), 10_000, flush);
			assert.ok(row, `File row ${fileName} must be present`);
			if (!editorText().includes(marker)) {
				row.click();
				await flush();
			}
			await waitForSource(marker);
			await waitFor(() => activeWatches.size === 1 ? true : undefined, 10_000, flush);
		};
		const writeExternalAndWait = async (path: string, contents: string) => {
			const before = emittedCount;
			await writeFile(path, contents, 'utf8');
			await waitFor(() => emittedCount > before ? true : undefined, 10_000, flush);
		};
		const notice = (kind: 'changed' | 'missing') =>
			container.querySelector<HTMLElement>(`.file-change-notice[data-kind="${kind}"]`);

		await openFolder('first.tex', 'BASE_FIRST');
		const firstPath = join(roots[0]!, fileNames[0]!);

		// A clean external update is loaded from disk and replaces only the clean snapshot.
		await writeExternalAndWait(
			firstPath,
			'\\documentclass{article}\n\\begin{document}\nCLEAN_EXTERNAL_FIRST\n\\end{document}\n'
		);
		await waitForSource('CLEAN_EXTERNAL_FIRST');
		assert.equal(notice('changed'), null);

		// Dirty edits remain untouched through conflict acknowledgement and confirmed reload.
		pasteIntoSource('LOCAL_DRAFT_KEEP');
		const keptText = await waitForSource('LOCAL_DRAFT_KEEP');
		await writeExternalAndWait(
			firstPath,
			'\\documentclass{article}\n\\begin{document}\nEXTERNAL_CONFLICT_FIRST\n\\end{document}\n'
		);
		await waitFor(() => notice('changed') ?? undefined, 10_000, flush);
		assert.equal(editorText(), keptText);
		const keepButton = findButton((label) => label === 'Keep draft' || label === '保留草稿');
		assert.ok(keepButton);
		keepButton.click();
		await flush();
		assert.equal(editorText(), keptText);
		assert.match(notice('changed')?.textContent ?? '', /kept|保留/);

		await writeExternalAndWait(
			firstPath,
			'\\documentclass{article}\n\\begin{document}\nEXTERNAL_RELOAD_FIRST\n\\end{document}\n'
		);
		await waitFor(() => notice('changed') ?? undefined, 10_000, flush);
		const confirmsBeforeReload = confirmCount;
		const reloadButton = findButton((label) => label === 'Reload from disk' || label === '從磁碟重新載入');
		assert.ok(reloadButton);
		reloadButton.click();
		await waitForSource('EXTERNAL_RELOAD_FIRST');
		assert.ok(confirmCount > confirmsBeforeReload, 'Reloading an already-dirty draft must use the discard confirmation');
		assert.equal(editorText().includes('LOCAL_DRAFT_KEEP'), false);
		assert.equal(notice('changed'), null);

		// The event generated by the renderer's own save is compared with its real disk
		// checkpoint, even if local typing occurs before that event is drained.
		pasteIntoSource('OWN_SAVE_FIRST');
		await waitForSource('OWN_SAVE_FIRST');
		const writesBeforeSave = writeCount;
		const listsBeforeSave = listCount;
		const eventsBeforeSave = emittedCount;
		const saveButton = globalButton('Save', '儲存');
		assert.ok(saveButton);
		saveButton.click();
		await waitFor(() => writeCount > writesBeforeSave ? true : undefined, 10_000, flush);
		await waitFor(() => listCount > listsBeforeSave && emittedCount > eventsBeforeSave ? true : undefined, 10_000, flush);
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(notice('changed'), null, 'An own-save watch event must not produce a disk conflict');
		assert.match(await readFile(firstPath, 'utf8'), /OWN_SAVE_FIRST/);

		// Deletion is visible and actionable; it never closes or writes through the old revision.
		pasteIntoSource('DRAFT_BEFORE_DELETE');
		const deletedDraft = await waitForSource('DRAFT_BEFORE_DELETE');
		const deleteEventBaseline = emittedCount;
		await unlink(firstPath);
		await waitFor(() => emittedCount > deleteEventBaseline ? true : undefined, 10_000, flush);
		await waitFor(() => notice('missing') ?? undefined, 10_000, flush);
		assert.equal(editorText(), deletedDraft);
		const saveBeforeMissingClick = globalButton('Save', '儲存');
		assert.ok(saveBeforeMissingClick);
		assert.equal(saveBeforeMissingClick.disabled, true);
		const writesBeforeMissingClick = writeCount;
		saveBeforeMissingClick.click();
		await flush();
		assert.equal(writeCount, writesBeforeMissingClick);
		assert.ok(globalButton('Save as', '另存新檔'));
		const keepDeletedDraft = findButton((label) => label === 'Keep draft' || label === '保留草稿');
		assert.ok(keepDeletedDraft);
		keepDeletedDraft.click();
		await flush();
		assert.equal(editorText(), deletedDraft);

		// Opening another workspace while an old read is delayed cannot install the old
		// receipt into the new document.
		await openFolder('second.tex', 'BASE_SECOND');
		const secondPath = join(roots[1]!, fileNames[1]!);
		const secondReadGate = {
			path: fileNames[1]!,
			entered: deferred<void>(),
			release: deferred<void>(),
			used: false
		};
		readGate = secondReadGate;
		await writeExternalAndWait(
			secondPath,
			'\\documentclass{article}\n\\begin{document}\nREAD_DURING_EDIT_SECOND\n\\end{document}\n'
		);
		await secondReadGate.entered.promise;
		pasteIntoSource('TYPED_DURING_READ_SECOND');
		const textDuringRead = await waitForSource('TYPED_DURING_READ_SECOND');
		secondReadGate.release.resolve(undefined);
		await waitFor(() => notice('changed') ?? undefined, 10_000, flush);
		assert.equal(editorText(), textDuringRead, 'An async clean reload must preserve edits made after it began');

		const confirmedReload = findButton((label) => label === 'Reload from disk' || label === '從磁碟重新載入');
		assert.ok(confirmedReload);
		confirmedReload.click();
		await waitForSource('READ_DURING_EDIT_SECOND');
		assert.equal(editorText().includes('TYPED_DURING_READ_SECOND'), false);

		const staleReadGate = {
			path: fileNames[1]!,
			entered: deferred<void>(),
			release: deferred<void>(),
			used: false
		};
		readGate = staleReadGate;
		await writeExternalAndWait(
			secondPath,
			'\\documentclass{article}\n\\begin{document}\nSTALE_OLD_WORKSPACE_SECOND\n\\end{document}\n'
		);
		await staleReadGate.entered.promise;
		await openFolder('third.tex', 'BASE_THIRD');
		staleReadGate.release.resolve(undefined);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.match(editorText(), /BASE_THIRD/);
		assert.equal(editorText().includes('STALE_OLD_WORKSPACE_SECOND'), false);

		// Abort the mounted App while another real host-backed read is delayed. The
		// adapter must stop its native watch and the late receipt must not touch the view.
		const thirdPath = join(roots[2]!, fileNames[2]!);
		const unmountReadGate = {
			path: fileNames[2]!,
			entered: deferred<void>(),
			release: deferred<void>(),
			used: false
		};
		readGate = unmountReadGate;
		await writeExternalAndWait(
			thirdPath,
			'\\documentclass{article}\n\\begin{document}\nLATE_AFTER_UNMOUNT\n\\end{document}\n'
		);
		await unmountReadGate.entered.promise;
		const emittedAtUnmount = emittedCount;
		await api.unmount(mounted);
		mounted = undefined;
		api.flushSync();
		await waitFor(() => activeWatches.size === 0 && eventListeners.size === 0 ? true : undefined, 10_000, flush);
		unmountReadGate.release.resolve(undefined);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(container.textContent, '');
		await writeFile(thirdPath, 'AFTER_UNMOUNT\n', 'utf8');
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(emittedCount, emittedAtUnmount, 'Unmount must prevent later native watch delivery');
		assert.equal(activeWatches.size, 0);
	} finally {
		readGate?.release.resolve(undefined);
		if (mounted !== undefined && client) {
			try {
				await client.unmount(mounted);
				client.flushSync();
			} catch {
				// Continue teardown so filesystem watchers and temporary files are always released.
			}
		}
		stopAllNativeWatchesForCleanup(activeWatches);
		try { files?.close(); } catch { /* continue cleanup */ }
		if (dom) {
			try { dom.window.close(); } catch { /* continue cleanup */ }
			dom = null;
		}
		restoreGlobals(previousGlobals);
		await server.close();
		fs.rmSync(buildDir, { recursive: true, force: true });
		if (fixtureDir) {
			if (dirname(fixtureDir) !== tmpdir() || !basename(fixtureDir).startsWith('modutex-workbench-files-')) {
				throw new Error('Unsafe fixture cleanup');
			}
			await rm(fixtureDir, { recursive: true, force: true });
		}
	}
});

function stopAllNativeWatchesForCleanup(watches: Map<string, InstanceType<any>>) {
	for (const watcher of watches.values()) watcher.stop();
	watches.clear();
}
