import assert from 'node:assert/strict';
import type { CompileIdentity, CompileRequest, FileEvent, FileRef, FileWatchFailure, SaveAsRequest, WriteRequest } from '@modutex/frontend-contracts';

import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { savePreference } from '../../src/state/preferences.ts';
import { NativeFilesFixture, type NativeFilesWatch } from '../helpers/native-files-fixture.ts';

const require = createRequire(import.meta.url);

type DOMWindow = Window & typeof globalThis & {
	close(): void;
};

type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement; props?: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	App: unknown;
	WorkspaceFilesPanel: unknown;
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
	getCompileConfig(id: string): Promise<unknown>;
	startCompile(request: unknown): Promise<unknown>;
	compileResult(id: string): Promise<unknown>;
	cancelCompile(id: string): Promise<unknown>;
	closeWorkspace(id: string): Promise<unknown>;
	startWatch(workspaceId: string, subscriptionId: string): Promise<unknown>;
	stopWatch(subscriptionId: string): Promise<unknown>;
	onWatchEvent(listener: (value: unknown) => void): () => void;
	onWatchError(listener: (value: unknown) => void): () => void;
};

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
}

interface ReadGate {
	readonly path: string;
	readonly entered: Deferred<void>;
	readonly release: Deferred<void>;
	readonly finished: Deferred<void>;
	used: boolean;
}

interface CompileConfigGate {
	readonly entered: Deferred<void>;
	readonly release: Deferred<void>;
	readonly finished: Deferred<void>;
	used: boolean;
}

type FrontendWatchDependencies = {
	readonly root: string;
	readonly workspaceId: string;
	readonly assertCurrent: () => void;
	readonly emit: (event: FileEvent) => void;
	readonly onError: (failure: FileWatchFailure) => void;
};

const { JSDOM } = require('jsdom') as {
	JSDOM: new (
		html?: string,
		options?: { url?: string; storageQuota?: number; pretendToBeVisual?: boolean }
	) => {
		window: DOMWindow;
	};
};

const prefix = 'modutex.frontend.preferences.v1.';
const fixtureRecentId = '123e4567-e89b-42d3-a456-426614174000';
const fixtureCompileRunId = '123e4567-e89b-42d3-a456-426614174001';
const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const appPath = fileURLToPath(new URL('../../src/App.svelte', import.meta.url)).replaceAll('\\', '/');
const workspaceFilesPanelPath = fileURLToPath(new URL('../../src/components/WorkspaceFilesPanel.svelte', import.meta.url)).replaceAll('\\', '/');

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

interface CompilePlan {
	readonly started: Deferred<void>;
	readonly startReply: Deferred<void>;
	readonly result: Deferred<unknown>;
	identity: CompileIdentity | null;
	cancellationCount: number;
}

interface CompileHarness {
	readonly started: Promise<void>;
	releaseStart(): void;
	identity(): CompileIdentity | null;
	resolveResult(result: unknown): void;
	cancellationCount(): number;
}

async function waitFor<T>(
	read: () => T | undefined,
	milliseconds = 10_000,
	pump?: () => Promise<void> | void
): Promise<T> {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (pump) await pump();
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('Timed out waiting for mounted App lifecycle result');
}

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;
const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
let mount!: ClientModule['mount'];
let unmount!: ClientModule['unmount'];
let flushSync!: ClientModule['flushSync'];
let tick!: ClientModule['tick'];
let App!: ClientModule['App'];
let WorkspaceFilesPanel!: ClientModule['WorkspaceFilesPanel'];
let setupWork: Promise<void> | null = null;
const originalConsoleError = console.error;
let clientRuntimeErrorCount = 0;

function restoreGlobals(): void {
	let firstFailure: unknown;
	for (const [key, desc] of previousDescriptors) {
		try {
			if (desc === undefined) {
				Reflect.deleteProperty(globalThis, key);
			} else {
				Object.defineProperty(globalThis, key, desc);
			}
		} catch (error) {
			firstFailure ??= error;
		}
	}
	previousDescriptors.clear();
	if (firstFailure !== undefined) throw firstFailure;
}

class JSDOMMediaQueryList extends EventTarget implements MediaQueryList {
	readonly media: string;
	readonly matches: boolean;
	onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null = null;
	constructor(query: string, matches = false) {
		super();
		this.media = query;
		this.matches = matches;
	}
	addListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null): void {
		if (callback) this.addEventListener('change', callback as unknown as EventListener);
	}
	removeListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null): void {
		if (callback) this.removeEventListener('change', callback as unknown as EventListener);
	}
}

// Register cleanup before setup. Each resource is drained before the next one is removed.
test.after(async () => {
	try {
		// A timed-out hook does not cancel Vite: drain it before destroying its resources.
		if (setupWork) await setupWork.catch(() => {});
	} finally {
		try {
			if (dom) {
				const current = dom;
				dom = null;
				current.window.close();
			}
		} finally {
			try {
				restoreGlobals();
			} finally {
				if (tempDir) {
					const directory = tempDir;
					tempDir = null;
					fs.rmSync(directory, { recursive: true, force: true });
				}
			}
		}
	}
});

// Keep the client build and host-module imports inside a bounded test hook.
test.before(async () => {
	console.error = (...arguments_: unknown[]) => {
		clientRuntimeErrorCount++;
		originalConsoleError.apply(console, arguments_);
	};
	setupWork = (async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-app-lifecycle-'));
	const entryFile = path.join(tempDir, 'entry.js');
	fs.writeFileSync(
		entryFile,
		`import { mount, unmount, flushSync, tick } from 'svelte';
import App from '${appPath}';
import WorkspaceFilesPanel from '${workspaceFilesPanelPath}';
export { mount, unmount, flushSync, tick, App, WorkspaceFilesPanel };
`
	);

	await build({
		configFile: false,
		worker: { format: 'es' },
		root: frontendRoot,
		plugins: [svelte()],
		resolve: {
			dedupe: ['svelte'],
			conditions: ['browser', 'default']
		},
		build: {
			write: true,
			outDir: tempDir,
			emptyOutDir: false,
			lib: {
				entry: entryFile,
				formats: ['es'],
				fileName: () => 'app-client.mjs'
			},
			sourcemap: false,
			minify: false
		},
		logLevel: 'silent'
	});

	const jsdom = new JSDOM(
		'<!DOCTYPE html><html lang="fr" data-theme="dark"><body><div id="app"></div></body></html>',
		{ url: 'https://modutex.test', pretendToBeVisual: true }
	);
	dom = jsdom;
	const win: DOMWindow = jsdom.window;
	// JSDOM has no layout engine. Supply only its missing platform APIs;
	// geometry and rendering acceptance run separately in actual Chromium.
	Object.defineProperty(win.Range.prototype, 'getClientRects', { value: () => [] });
	Object.defineProperty(win.Range.prototype, 'getBoundingClientRect', { value: () => new win.DOMRect() });
	win.matchMedia = (query: string): MediaQueryList =>
		new JSDOMMediaQueryList(query, query === '(min-width: 961px)');

	const explicitDomKeys = [
		'window', 'Window', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement',
		'HTMLMediaElement', 'Document', 'DocumentFragment', 'Text', 'Comment', 'CharacterData', 'Attr',
		'HTMLInputElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLButtonElement', 'HTMLAnchorElement',
		'HTMLDivElement', 'HTMLParagraphElement', 'HTMLHeadingElement', 'HTMLFormElement', 'HTMLTextAreaElement',
		'HTMLSpanElement', 'HTMLPreElement', 'HTMLDetailsElement', 'HTMLSummaryElement', 'HTMLUListElement',
		'HTMLLIElement', 'HTMLCanvasElement', 'HTMLTemplateElement', 'HTMLStyleElement', 'HTMLLinkElement',
		'Event', 'EventTarget', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'StorageEvent',
		'BeforeUnloadEvent', 'HashChangeEvent', 'UIEvent', 'MutationObserver', 'Range', 'DOMRect', 'Selection',
		'NodeFilter', 'getComputedStyle', 'Storage'
	] as const;

	for (const key of explicitDomKeys) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		if (key in win) {
			const value = win[key as keyof DOMWindow];
			Object.defineProperty(globalThis, key, {
				value: key === 'getComputedStyle' && typeof value === 'function' ? value.bind(win) : value,
				writable: true,
				configurable: true
			});
		}
	}

	previousDescriptors.set('requestAnimationFrame', Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'));
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		value: win.requestAnimationFrame.bind(win),
		writable: true,
		configurable: true
	});

	previousDescriptors.set('cancelAnimationFrame', Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'));
	Object.defineProperty(globalThis, 'cancelAnimationFrame', {
		value: win.cancelAnimationFrame.bind(win),
		writable: true,
		configurable: true
	});

	class ObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	for (const key of ['ResizeObserver', 'IntersectionObserver']) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value: ObserverStub, writable: true, configurable: true });
		Object.defineProperty(win, key, { value: ObserverStub, configurable: true });
	}

	const bundleUrl = pathToFileURL(path.join(tempDir, 'app-client.mjs')).href;
	const client = (await import(bundleUrl)) as ClientModule;
	mount = client.mount;
	unmount = client.unmount;
	flushSync = client.flushSync;
	tick = client.tick;
	App = client.App;
	WorkspaceFilesPanel = client.WorkspaceFilesPanel;
	})();
	await setupWork;
}, { timeout: 180_000 });

test.after(() => {
	console.error = originalConsoleError;
	assert.equal(clientRuntimeErrorCount, 0,
		'Client runtime errors must fail acceptance even when all behavior assertions pass');
});

interface HostWorkbenchDriver {
	readonly firstPath: string;
	readonly secondPath: string;
	readonly container: HTMLElement;
	readonly editorText: () => string;
	readonly fileRow: (name: string) => HTMLButtonElement | undefined;
	readonly findButton: (
		predicate: (label: string) => boolean,
		scope?: ParentNode
	) => HTMLButtonElement | undefined;
	readonly notice: (kind: 'changed' | 'missing') => HTMLElement | null;
	readonly readCount: (path?: string) => number;
	readonly emittedCount: () => number;
	readonly activeWatchCount: () => number;
	readonly compileStartCount: () => number;
	readonly confirmCount: () => number;
	readonly setConfirmResult: (value: boolean) => void;
	readonly recentOpenCount: () => number;
	readonly prepareCompile: () => CompileHarness;
	readonly setCompileMainFile: (path: string | null) => void;
	readonly lastWrite: (path: string) => Pick<WriteRequest, 'documentId' | 'documentVersion'> | undefined;
	readonly gateNextCompileConfig: () => CompileConfigGate;
	readonly goHome: () => Promise<void>;
	readonly gateNextRead: (path: string) => ReadGate;
	readonly flush: () => Promise<void>;
	readonly waitForSource: (marker: string) => Promise<string>;
	readonly writeExternalAndWait: (path: string, contents: string) => Promise<void>;
	readonly openFolder: (fileName: string, marker: string) => Promise<void>;
	readonly pasteIntoSource: (value: string) => void;
}

async function withHostWorkbench(
	run: (workbench: HostWorkbenchDriver) => Promise<void>
): Promise<void> {
	assert.ok(dom, 'DOM must be initialized');
	const win = dom.window;
	const container = win.document.getElementById('app')!;
	const previousBridge = Object.getOwnPropertyDescriptor(win, 'modutexFiles');
	const previousConfirm = Object.getOwnPropertyDescriptor(win, 'confirm');
	const previousHash = win.location.hash;
	const fixturePrefix = 'app-lifecycle-workspace-';
	let fixtureDir: string | null = null;
	let files: NativeFilesFixture | null = null;
	let mounted: unknown;
	let confirmCount = 0;
	let readCount = 0;
	const pathReads = new Map<string, number>();
	const pendingIO = new Map<string, number>();
	const trackIO = (id: string, delta: number) => pendingIO.set(id, (pendingIO.get(id) ?? 0) + delta);
	let emittedCount = 0;
	let compileStartCount = 0;
	let compileMainFile: string | null = null;
	const writtenDocuments = new Map<string, Pick<WriteRequest, 'documentId' | 'documentVersion'>>();
	let confirmResult = true;
	let recentOpenCount = 0;
	let compilePlan: CompilePlan | null = null;
	let compileConfigGate: CompileConfigGate | null = null;
	let readGate: ReadGate | null = null;
	const readGates: ReadGate[] = [];
	const activeWatches = new Map<string, NativeFilesWatch>();
	const readyWatches = new Map<string, string>();
	const eventListeners = new Set<(value: unknown) => void>();
	const errorListeners = new Set<(value: unknown) => void>();

	const stopAllNativeWatches = (failure?: FileWatchFailure) => {
		for (const [subscriptionId, watcher] of [...activeWatches]) {
			activeWatches.delete(subscriptionId);
			readyWatches.delete(subscriptionId);
			watcher.stop();
			if (failure) {
				for (const listener of errorListeners) {
					listener({ subscriptionId, error: failure });
				}
			}
		}
	};

	try {
		fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), fixturePrefix));
		const roots = ['first', 'second'].map((name) => path.join(fixtureDir!, name));
		const fileNames = ['first.tex', 'second.tex'];
		const sourceText = (marker: string) =>
			`\\documentclass{article}\n\\begin{document}\n${marker}\n\\end{document}\n`;
		for (let index = 0; index < roots.length; index++) {
			await fs.promises.mkdir(roots[index]!);
			await fs.promises.writeFile(
				path.join(roots[index]!, fileNames[index]!),
				sourceText(index === 0 ? 'BASE_FIRST' : 'BASE_SECOND'),
				'utf8'
			);
		}
		await fs.promises.writeFile(path.join(roots[0]!, 'invalid.pdf'), 'not a PDF', 'utf8');

		files = new NativeFilesFixture();
		let openIndex = 0;
		const pushWatchError = (subscriptionId: string, failure: FileWatchFailure) => {
			for (const listener of errorListeners) {
				listener({ subscriptionId, error: failure });
			}
		};
		const native: NativeBridge = {
			openWorkspace: async (kind) => {
				assert.equal(kind, 'folder');
				stopAllNativeWatches('STALE_WORKSPACE');
				const root = roots[Math.min(openIndex++, roots.length - 1)]!;
				return files!.open(root, kind);
			},
			listRecent: async () => [{
				id: fixtureRecentId,
				label: fileNames[1]!,
				entryPath: fileNames[1]!,
				openedAt: 1
			}],
			openRecent: async (id) => {
				assert.equal(id, fixtureRecentId);
				recentOpenCount++;
				stopAllNativeWatches('STALE_WORKSPACE');
				return files!.open(path.join(roots[1]!, fileNames[1]!), 'file');
			},
			removeRecent: async () => {},
			listFiles: async (id) => { trackIO(id, 1); try { return await files!.list(id); } finally { trackIO(id, -1); } },
			readFile: async (ref) => {
				readCount++;
				pathReads.set(ref.path, (pathReads.get(ref.path) ?? 0) + 1);
				trackIO(ref.workspaceId, 1);
				try {
				// Forward the genuine host receipt unchanged; the barrier only delays delivery.
				const receipt = await files!.read(ref);
				if (receipt.documentId !== null && receipt.documentVersion !== null) {
					writtenDocuments.set(`${ref.workspaceId}:${ref.path}`, {
						documentId: receipt.documentId,
						documentVersion: receipt.documentVersion
					});
				}
				const gate = readGate;
				if (gate && !gate.used && ref.path === gate.path) {
					gate.used = true;
					gate.entered.resolve(undefined);
					await gate.release.promise;
					gate.finished.resolve(undefined);
				}
				return receipt;
				} finally { trackIO(ref.workspaceId, -1); }
			},
			writeFile: async (request) => {
				const receipt = await files!.write(request);
				writtenDocuments.set(`${request.workspaceId}:${request.path}`, {
					documentId: request.documentId,
					documentVersion: request.documentVersion
				});
				return receipt;
			},
			saveAs: async (request) =>
				files!.saveAs(path.join(roots[1]!, 'saved-as.tex'), request as SaveAsRequest),
			getCompileConfig: async (id) => {
				const gate = compileConfigGate;
				if (gate && !gate.used) {
					gate.used = true;
					gate.entered.resolve(undefined);
					await gate.release.promise;
					gate.finished.resolve(undefined);
				}
				return { workspaceId: id, revision: 1, mainFile: compileMainFile, profile: 'managed', engine: 'managed', outputDir: null, pdf: null, log: null, customCommand: null, canSetCommand: false };
			},
			startCompile: async (request) => {
				const compileRequest = request as CompileRequest;
				const persisted = writtenDocuments.get(`${compileRequest.workspaceId}:${compileRequest.entryPath}`);
				if (persisted && (persisted.documentId !== compileRequest.documentId ||
					persisted.documentVersion !== compileRequest.documentVersion)) {
					throw new Error('DocumentIdentityMismatch: compile identity does not match the tracked entry');
				}
				compileStartCount++;
				const plan = compilePlan;
				if (!plan) throw new Error('Unexpected compile in lifecycle fixture');
				const identity: CompileIdentity = {
					runId: fixtureCompileRunId,
					workspaceId: compileRequest.workspaceId,
					entryPath: compileRequest.entryPath,
					documentId: compileRequest.documentId,
					documentVersion: compileRequest.documentVersion,
					savedRevision: compileRequest.savedRevision
				};
				plan.identity = identity;
				plan.started.resolve(undefined);
				await plan.startReply.promise;
				return identity;
			},
			compileResult: async (id) => {
				const plan = compilePlan;
				if (!plan?.identity || plan.identity.runId !== id) {
					throw new Error('Unexpected compile result in lifecycle fixture');
				}
				const result = await plan.result.promise;
				if (compilePlan === plan) compilePlan = null;
				return result;
			},
			cancelCompile: async (id) => {
				const plan = compilePlan;
				if (!plan?.identity || plan.identity.runId !== id) {
					throw new Error('Unexpected compile cancellation in lifecycle fixture');
				}
				plan.cancellationCount++;
				plan.result.resolve({
					status: 'cancelled',
					identity: plan.identity,
					log: '',
					diagnostics: []
				});
			},
			closeWorkspace: async (id) => {
				stopAllNativeWatches();
				files!.close(id);
			},
			startWatch: async (id, subscriptionId) => {
				let watcher!: NativeFilesWatch;
				watcher = files!.watch(id, (event) => {
						if (activeWatches.get(subscriptionId) !== watcher) return;
						emittedCount++;
						for (const listener of eventListeners) {
							listener({ subscriptionId, event });
						}
					}, (failure) => {
						if (activeWatches.get(subscriptionId) !== watcher) return;
						activeWatches.delete(subscriptionId);
						readyWatches.delete(subscriptionId);
						pushWatchError(subscriptionId, failure);
				});
				activeWatches.set(subscriptionId, watcher);
				try {
					await watcher.start();
					readyWatches.set(subscriptionId, id);
				} catch (error) {
					if (activeWatches.get(subscriptionId) === watcher) activeWatches.delete(subscriptionId);
					readyWatches.delete(subscriptionId);
					watcher.stop();
					throw error;
				}
			},
			stopWatch: async (subscriptionId) => {
				const watcher = activeWatches.get(subscriptionId);
				if (watcher) {
					activeWatches.delete(subscriptionId);
					readyWatches.delete(subscriptionId);
					watcher.stop();
				}
			},
			onWatchEvent: (listener) => {
				eventListeners.add(listener);
				return () => { eventListeners.delete(listener); };
			},
			onWatchError: (listener) => {
				errorListeners.add(listener);
				return () => { errorListeners.delete(listener); };
			}
		};

		Object.defineProperty(win, 'modutexFiles', { configurable: true, value: native });
		Object.defineProperty(win, 'confirm', {
			configurable: true,
			value: () => { confirmCount++; return confirmResult; }
		});
		win.location.hash = '#/workbench';
		mounted = mount(App, { target: container });
		flushSync();

		const flush = async () => {
			flushSync();
			await tick();
			await tick();
			flushSync();
		};
		const prepareCompile = (): CompileHarness => {
			if (compilePlan) throw new Error('The lifecycle fixture supports one controlled compile at a time');
			const plan: CompilePlan = {
				started: deferred<void>(),
				startReply: deferred<void>(),
				result: deferred<unknown>(),
				identity: null,
				cancellationCount: 0
			};
			compilePlan = plan;
			return {
				started: plan.started.promise,
				releaseStart: () => plan.startReply.resolve(undefined),
				identity: () => plan.identity,
				resolveResult: (result) => plan.result.resolve(result),
				cancellationCount: () => plan.cancellationCount
			};
		};
		const goHome = async () => {
			win.location.hash = '#/';
			win.dispatchEvent(new win.HashChangeEvent('hashchange'));
			await flush();
		};
		const editorText = () => container.querySelector('.cm-content')?.textContent ?? '';
		const findButton = (
			predicate: (label: string) => boolean,
			scope: ParentNode = container
		) => {
			const button = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
				.find((candidate) => predicate(candidate.textContent?.trim() ?? ''));
			const menu = button?.closest<HTMLDetailsElement>('details');
			if (menu && !menu.open) menu.querySelector('summary')?.click();
			return button;
		};
		const fileRow = (name: string) =>
			Array.from(container.querySelectorAll<HTMLButtonElement>('.files button.file-row'))
				.find((button) => button.textContent?.trim() === name);
		const waitForSource = (marker: string) =>
			waitFor(() => editorText().includes(marker) ? editorText() : undefined, 10_000, flush);
		const writeExternalAndWait = async (filePath: string, contents: string) => {
			const before = emittedCount;
			await fs.promises.writeFile(filePath, contents, 'utf8');
			await waitFor(() => emittedCount > before ? true : undefined, 10_000, flush);
		};
		const gateNextRead = (relativePath: string): ReadGate => {
			const gate: ReadGate = {
				path: relativePath,
				entered: deferred<void>(),
				release: deferred<void>(),
				finished: deferred<void>(),
				used: false
			};
			readGates.push(gate);
			readGate = gate;
			return gate;
		};
		const pasteIntoSource = (value: string) => {
			const sourceMode = Array.from(container.querySelectorAll<HTMLButtonElement>('.modes button')).find(button => ['原始碼', 'Source'].includes(button.getAttribute('aria-label') ?? ''));
			assert.ok(sourceMode); sourceMode.click(); flushSync();
			const content = container.querySelector<HTMLElement>('.cm-content');
			assert.ok(content, 'Mounted CodeMirror content must exist before editing');
			content.focus();
			const event = new win.Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', {
				value: {
					types: ['text/plain'],
					files: [],
					getData: (type: string) => type === 'text/plain' ? value : ''
				}
			});
			content.dispatchEvent(event);
			flushSync();
		};
		const openFolder = async (fileName: string, marker: string) => {
			const beforeReads = pathReads.get(fileName) ?? 0;
			const fileMenu = container.querySelector<HTMLDetailsElement>('details.file-menu');
			assert.ok(fileMenu, 'File menu must be available');
			if (!fileMenu.open) fileMenu.querySelector('summary')?.click();
			const openButton = await waitFor(
				() => findButton((label) => label === 'Open folder' || label === '開啟資料夾',
					fileMenu),
				10_000,
				flush
			);
			openButton.click();
			await flush();
			const row = await waitFor(() => fileRow(fileName), 10_000, flush);
			await waitFor(() => row.disabled ? undefined : true, 10_000, flush);
			if (!editorText().includes(marker)) {
				row.click();
				await flush();
			}
			await waitForSource(marker);
			await waitFor(() => readyWatches.size === 1 && (pathReads.get(fileName) ?? 0) >= beforeReads + 1 &&
				(pendingIO.get([...readyWatches.values()][0]!) ?? 0) === 0 ? true : undefined, 10_000, flush);
		};

		await run({
			firstPath: path.join(roots[0]!, fileNames[0]!),
			secondPath: path.join(roots[1]!, fileNames[1]!),
			container,
			editorText,
			fileRow,
			findButton,
			notice: (kind) => container.querySelector<HTMLElement>(`.file-change-notice[data-kind="${kind}"]`),
			readCount: (path) => path === undefined ? readCount : pathReads.get(path) ?? 0,
			emittedCount: () => emittedCount,
			activeWatchCount: () => readyWatches.size,
			compileStartCount: () => compileStartCount,
			confirmCount: () => confirmCount,
			setConfirmResult: (value) => { confirmResult = value; },
			recentOpenCount: () => recentOpenCount,
			prepareCompile,
			setCompileMainFile: (path) => { compileMainFile = path; },
			lastWrite: (path) => {
				let latest: Pick<WriteRequest, 'documentId' | 'documentVersion'> | undefined;
				for (const [key, value] of writtenDocuments) {
					if (key.endsWith(`:${path}`)) latest = value;
				}
				return latest;
			},
			gateNextCompileConfig: () => {
				const gate: CompileConfigGate = {
					entered: deferred<void>(),
					release: deferred<void>(),
					finished: deferred<void>(),
					used: false
				};
				compileConfigGate = gate;
				return gate;
			},
			goHome,
			gateNextRead,
			flush,
			waitForSource,
			writeExternalAndWait,
			openFolder,
			pasteIntoSource
		});
	} catch (error) {
		const alert = [...container.querySelectorAll('[role="alert"]')].map(node => node.textContent?.trim()).filter(Boolean).join('; ');
		if (alert) throw new Error(`Mounted App reported: ${alert}`, { cause: error });
		throw error;
	} finally {
		const pendingCompile = compilePlan as CompilePlan | null;
		if (pendingCompile) {
			pendingCompile.startReply.resolve(undefined);
			if (pendingCompile.identity) {
				pendingCompile.result.resolve({
					status: 'cancelled', identity: pendingCompile.identity, log: '', diagnostics: []
				});
			}
		}
		for (const gate of readGates) {
			gate.release.resolve(undefined);
			if (!gate.used) gate.finished.resolve(undefined);
		}
		try {
			await Promise.all(readGates.map((gate) => gate.finished.promise));
			if (mounted !== undefined) {
				const unmountPromise = unmount(mounted);
				flushSync();
				await unmountPromise;
				flushSync();
			}
		} finally {
			try {
				stopAllNativeWatches();
			} finally {
				try {
					files?.close();
				} finally {
					try {
						if (fixtureDir) {
							if (path.dirname(fixtureDir) !== os.tmpdir() ||
								!path.basename(fixtureDir).startsWith(fixturePrefix)) {
								throw new Error('Unsafe lifecycle fixture cleanup');
							}
							await fs.promises.rm(fixtureDir, { recursive: true, force: true });
						}
					} finally {
						try {
							if (previousBridge) Object.defineProperty(win, 'modutexFiles', previousBridge);
							else Reflect.deleteProperty(win, 'modutexFiles');
						} finally {
							try {
								if (previousConfirm) Object.defineProperty(win, 'confirm', previousConfirm);
								else Reflect.deleteProperty(win, 'confirm');
							} finally {
								win.location.hash = previousHash;
							}
						}
					}
				}
			}
		}
	}
}

test('real client App mount/unmount restores present root attributes, updates via StorageEvent and Settings, and handles fault-injected restore', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const root = dom.window.document.documentElement;
	const container = dom.window.document.getElementById('app')!;

	assert.equal(root.getAttribute('lang'), 'fr');
	assert.equal(root.dataset.theme, 'dark');

	let instance: unknown;
	try {
		// Mount actual App
		instance = mount(App, { target: container });
		flushSync();

		// App applies initial preferences to root (default zh-Hant and light from system theme)
		assert.equal(root.lang, 'zh-Hant');
		assert.equal(root.dataset.theme, 'light');

		// 1. Actual settings change via real StorageEvent
		savePreference(dom.window.localStorage, 'language', 'en');
		dom.window.dispatchEvent(
			new dom.window.StorageEvent('storage', {
				key: prefix + 'language',
				newValue: JSON.stringify('en'),
				storageArea: dom.window.localStorage
			})
		);
		flushSync();
		assert.equal(root.lang, 'en', 'DOM lang must update to en upon real StorageEvent');

		// 2. Settings select DOM interaction / change event via settings route
		dom.window.location.hash = '#/settings';
		dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
		flushSync();

		// Wait for lazy Settings.svelte to render in DOM
		for (let i = 0; i < 30; i++) {
			await tick();
			await new Promise((r) => setTimeout(r, 20));
			flushSync();
			if (dom.window.document.getElementById('language-value')) break;
		}

		const langSelect = dom.window.document.getElementById('language-value') as HTMLSelectElement | null;
		assert.ok(langSelect, 'Settings language select element must be rendered');
		async function selectSettingsSection(label: string) {
			const button = Array.from(dom!.window.document.querySelectorAll<HTMLButtonElement>('.settings-page aside button')).find(item => item.textContent?.trim() === label);
			assert.ok(button, `Settings category ${label} must be available`);
			button.click();
			await tick(); flushSync();
		}

		// Set non-default language 'en' and font size 20 via actual DOM change events
		langSelect.value = 'en';
		langSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();
		assert.equal(root.lang, 'en', 'DOM lang must update to en via select change event');

		await selectSettingsSection('Editor');
		let fontInput = dom.window.document.getElementById('source-font-size') as HTMLInputElement | null;
		assert.ok(fontInput, 'Editor category must render its font size input');
		fontInput.value = '20';
		fontInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();
		assert.equal(fontInput.value, '20');

		const appDiv = dom.window.document.querySelector('.app') as HTMLElement;
		assert.equal(appDiv.style.getPropertyValue('--source-font-size'), '20px', 'App root style must update font size');

		// Verify notice is reactive and displayed in English
		const noticeElem = dom.window.document.querySelector('[role="status"].settings-notice');
		assert.ok(noticeElem, 'Settings notice must be displayed');
		assert.equal(noticeElem.textContent, 'Settings saved', 'Notice must show exact English text for saved setting');

		// 3. Fault injection on Storage prototype descriptor override for Restore defaults button
		await selectSettingsSection('Restore defaults');
		const restoreBtn = dom.window.document.querySelector('button.restore-button') as HTMLButtonElement | null;
		assert.ok(restoreBtn, 'Restore defaults button must be present in settings');

		const originalGetItem = dom.window.Storage.prototype.getItem;
		let hookCalled = false;
		try {
			dom.window.Storage.prototype.getItem = function (...args: [string]) {
				hookCalled = true;
				throw new Error('FAULT_INJECTION_UNREADABLE');
			};
			restoreBtn.click();
			flushSync();
		} finally {
			dom.window.Storage.prototype.getItem = originalGetItem;
		}

		assert.equal(hookCalled, true, 'Fault injection hook on Storage.prototype.getItem must be called');

		// Actual UI settings must be preserved rather than corrupted
		assert.equal(root.lang, 'en', 'UI language must be preserved as non-default en');
		assert.equal(appDiv.style.getPropertyValue('--source-font-size'), '20px', 'App font size style must be preserved');

		// Assert exact failure notice in current locale (en), not permissive regex
		await tick();
		flushSync();
		const failureNotice = dom.window.document.querySelector('[role="status"].settings-notice');
		assert.ok(failureNotice, 'Failure notice element must be present in live DOM');
		assert.equal(
			failureNotice.textContent,
			'Storage could not be read. Current settings were preserved.',
			'Failure notice must match exact English failure message'
		);
		await selectSettingsSection('Editor');
		fontInput = dom.window.document.getElementById('source-font-size') as HTMLInputElement | null;
		assert.ok(fontInput);
		assert.equal(fontInput.value, '20', 'Font size must be preserved as non-default 20');

		// 4. Genuine recovery StorageEvent: reread persisted default font 14 and zh-Hant language, clear obsolete error
		dom.window.dispatchEvent(
			new dom.window.StorageEvent('storage', {
				key: prefix + 'language',
				newValue: null,
				storageArea: dom.window.localStorage
			})
		);
		await tick();
		flushSync();

		assert.equal(
			dom.window.document.querySelector('[role="status"].settings-notice'),
			null,
			'Settings notice must be removed after successful recovery reread'
		);
		assert.equal(root.lang, 'zh-Hant', 'Root lang must recover to default zh-Hant');
		assert.equal(root.dataset.theme, 'light', 'Root theme must recover to default light');
		assert.equal(fontInput.value, '14', 'Font size input must recover to default 14');
		assert.equal(appDiv.style.getPropertyValue('--source-font-size'), '14px', 'App root style must reflect recovered default 14px');

		await selectSettingsSection('一般');
		const currentLangSelect = dom.window.document.getElementById('language-value') as HTMLSelectElement | null;
		assert.ok(currentLangSelect, 'Language select must exist in live DOM');
		assert.equal(currentLangSelect.value, 'zh-Hant', 'Language select must reflect recovered default zh-Hant');

		// Prefs keys in storage reflect actual storage (owned keys were removed during restore)
		assert.equal(dom.window.localStorage.getItem(prefix + 'language'), null, 'Persisted language key reflects removed default');
		assert.equal(dom.window.localStorage.getItem(prefix + 'sourceFontSize'), null, 'Persisted font size key reflects removed default');

		// 5. Genuine invalid persisted field event and current-localized corruption notice
		dom.window.localStorage.setItem(prefix + 'sourceFontSize', JSON.stringify(999));
		dom.window.dispatchEvent(
			new dom.window.StorageEvent('storage', {
				key: prefix + 'sourceFontSize',
				newValue: JSON.stringify(999),
				storageArea: dom.window.localStorage
			})
		);
		await tick();
		flushSync();

		const corruptNoticeZh = dom.window.document.querySelector('[role="status"].settings-notice');
		assert.ok(corruptNoticeZh, 'Corruption notice must be present in live DOM');
		assert.equal(
			corruptNoticeZh.textContent,
			'部分設定無法讀取，已使用預設值。',
			'Corruption notice must show exact Traditional Chinese message for corrupted field'
		);

		// Switch language to en while field remains invalid: notice stays current-localized
		savePreference(dom.window.localStorage, 'language', 'en');
		dom.window.dispatchEvent(
			new dom.window.StorageEvent('storage', {
				key: prefix + 'language',
				newValue: JSON.stringify('en'),
				storageArea: dom.window.localStorage
			})
		);
		await tick();
		flushSync();

		assert.equal(root.lang, 'en', 'Root lang must update to en');
		const corruptNoticeEn = dom.window.document.querySelector('[role="status"].settings-notice');
		assert.ok(corruptNoticeEn, 'Corruption notice must remain present in live DOM');
		assert.equal(
			corruptNoticeEn.textContent,
			'Some settings could not be read and were reset to defaults.',
			'Corruption notice must reactively switch to exact English message'
		);

		// Clean up invalid field and recover
		dom.window.localStorage.removeItem(prefix + 'sourceFontSize');
		dom.window.dispatchEvent(
			new dom.window.StorageEvent('storage', {
				key: prefix + 'sourceFontSize',
				newValue: null,
				storageArea: dom.window.localStorage
			})
		);
		await tick();
		flushSync();
		assert.equal(
			dom.window.document.querySelector('[role="status"].settings-notice'),
			null,
			'Corruption notice must be cleared once storage is valid'
		);

		// Return to home route
		dom.window.location.hash = '#/';
		dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
		flushSync();
	} finally {
		if (instance) {
			const unmounting = unmount(instance);
			flushSync();
			await unmounting;
		}
	}

	// Verify original present attributes are restored on unmount
	assert.equal(root.getAttribute('lang'), 'fr', 'Original present lang must be restored on unmount');
	assert.equal(root.dataset.theme, 'dark', 'Original present theme must be restored on unmount');

	// Disposed listener cannot republish or modify DOM after unmount
	savePreference(dom.window.localStorage, 'language', 'en');
	dom.window.dispatchEvent(
		new dom.window.StorageEvent('storage', {
			key: prefix + 'language',
			newValue: JSON.stringify('en'),
			storageArea: dom.window.localStorage
		})
	);
	flushSync();
	assert.equal(root.getAttribute('lang'), 'fr', 'Unsubscribed App listener cannot modify DOM');
});

test('real client App mount/unmount cleanly cleans up absent root attributes without residual attrs', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const root = dom.window.document.documentElement;
	const container = dom.window.document.getElementById('app')!;

	// Ensure attributes are absent
	root.removeAttribute('lang');
	delete root.dataset.theme;
	assert.equal(root.hasAttribute('lang'), false);
	assert.equal(root.hasAttribute('data-theme'), false);

	let instance: unknown;
	try {
		// Mount actual App
		instance = mount(App, { target: container });
		flushSync();

		assert.equal(root.hasAttribute('lang'), true);
		assert.equal(root.hasAttribute('data-theme'), true);
	} finally {
		if (instance) {
			const unmounting = unmount(instance);
			flushSync();
			await unmounting;
		}
	}

	// Verify absent attributes are cleanly deleted/removed without residual values
	assert.equal(root.hasAttribute('lang'), false, 'Absent lang attribute must be removed');
	assert.equal(root.hasAttribute('data-theme'), false, 'Absent data-theme attribute must be removed');
	assert.equal(root.dataset.theme, undefined);
	assert.equal(root.getAttribute('lang'), null);
});

test('workspace new-file form keeps failed input and opens a successfully created file', { timeout: 180_000 }, async () => {
	assert.ok(dom);
	const win = dom.window;
	const target = win.document.createElement('div');
	win.document.body.append(target);
	const dialogPrototype = win.HTMLDialogElement.prototype;
	const oldShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
	const oldClose = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');
	Object.defineProperty(dialogPrototype, 'showModal', {
		configurable: true,
		value(this: HTMLDialogElement) { this.setAttribute('open', ''); }
	});
	Object.defineProperty(dialogPrototype, 'close', {
		configurable: true,
		value(this: HTMLDialogElement) { this.removeAttribute('open'); }
	});
	let shouldFail = true;
	let entries: { path: string; kind: 'file' | 'directory' }[] = [];
	const openedPaths: string[] = [];
	const files = {
		async createFile(_workspaceId: string, filePath: string, bytes: Uint8Array) {
			if (shouldFail) throw new Error('FILE_CONFLICT');
			entries = [...entries, { path: filePath, kind: 'file' }];
			return { path: filePath, kind: 'file', sizeBytes: bytes.byteLength };
		}
	};
	const instance = mount(WorkspaceFilesPanel, {
		target,
		props: {
			open: true,
			workspaceId: 'workspace-1',
			workspaceLabel: 'project',
			scope: 1,
			files,
			entries,
			selected: 'chapter.tex',
			disabled: false,
			sourcePath: 'chapter.tex',
			sourceDirty: false,
			locale: 'en',
			initialTool: 'create-file',
			initialPath: 'notes/new.tex',
			openSequence: 1,
			onOpen: () => {},
			onCompile: () => {},
			onCreatedFile: async (filePath: string) => { openedPaths.push(filePath); return true; },
			onClose: () => {},
			onRefresh: async () => entries,
			onEntries: (listed: typeof entries) => { entries = [...listed]; },
			onCapabilityLost: () => {},
			onPathChanged: () => {},
			onSourceRemoved: () => {}
		}
	});
	const flush = async () => { flushSync(); await tick(); await tick(); flushSync(); };
	try {
		const form = await waitFor(() => target.querySelector<HTMLFormElement>('.workspace-files-form'), 10_000, flush);
		assert.ok(form);
		const pathInput = form.querySelector<HTMLInputElement>('input:not([type="file"])');
		const contents = form.querySelector<HTMLTextAreaElement>('textarea');
		assert.ok(pathInput);
		assert.ok(contents);
		assert.equal(pathInput.value, 'notes/new.tex');
		assert.match(contents.value, /\\documentclass\{article\}/);
		assert.match(contents.value, /\\usepackage\[margin=2cm\]\{geometry\}/);
		assert.match(contents.value, /\\begin\{document\}[\s\S]*\\end\{document\}/);
		contents.value = 'new TeX content';
		contents.dispatchEvent(new win.Event('input', { bubbles: true }));
		const createButton = Array.from(form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))[0];
		assert.ok(createButton);
		createButton.click();
		await waitFor(
			() => target.querySelector('.workspace-files-status[role="alert"]')?.textContent?.includes('file changed') ||
				target.querySelector('.workspace-files-status[role="alert"]')?.textContent?.includes('檔案已變更') ? true : undefined,
			10_000,
			flush
		);
		assert.equal(pathInput.value, 'notes/new.tex');
		assert.equal(contents.value, 'new TeX content');
		assert.deepEqual(openedPaths, []);

		shouldFail = false;
		createButton.click();
		await waitFor(
			() => target.querySelector('.workspace-files-status[role="status"]')?.textContent?.includes('Created and opened "notes/new.tex".') ? true : undefined,
			10_000,
			flush
		);
		assert.deepEqual(openedPaths, ['notes/new.tex']);
		assert.deepEqual(entries, [{ path: 'notes/new.tex', kind: 'file' }]);
	} finally {
		await unmount(instance);
		target.remove();
		if (oldShowModal) Object.defineProperty(dialogPrototype, 'showModal', oldShowModal);
		else Reflect.deleteProperty(dialogPrototype, 'showModal');
		if (oldClose) Object.defineProperty(dialogPrototype, 'close', oldClose);
		else Reflect.deleteProperty(dialogPrototype, 'close');
	}
});

test('real App lazily mounts the workbench once and preserves the same panes across navigation', async () => {
	assert.ok(dom);
	const container = dom.window.document.getElementById('app')!;
	dom.window.location.hash = '#/';
	const instance = mount(App, { target: container });
	const navigate = async (hash: string) => {
		dom!.window.location.hash = hash;
		dom!.window.dispatchEvent(new dom!.window.HashChangeEvent('hashchange'));
		await tick(); flushSync();
	};
	try {
		flushSync();
		assert.equal(container.querySelector('.workbench-layout'), null);
		await navigate('#/workbench');
		for (let attempt = 0; attempt < 50 && !container.querySelector('.workbench-layout'); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 10));
			await tick(); flushSync();
		}
		const layout = container.querySelector('.workbench-layout');
		const documentPane = container.querySelector('#workbench-panel-document');
		const pdfPane = container.querySelector('#workbench-panel-pdf');
		assert.ok(layout); assert.ok(documentPane); assert.ok(pdfPane);
		await navigate('#/settings');
		const workbench = container.querySelector('main.workbench') as HTMLElement;
		assert.equal(workbench.hidden, true);
		assert.equal(workbench.inert, true);
		assert.equal(container.querySelector('.workbench-layout'), layout);
		await navigate('#/workbench');
		assert.equal(workbench.hidden, false);
		assert.equal(workbench.inert, false);
		assert.equal(container.querySelector('#workbench-panel-document'), documentPane);
		assert.equal(container.querySelector('#workbench-panel-pdf'), pdfPane);
	} finally {
		const unmounting = unmount(instance); flushSync();
		await unmounting;
		dom.window.location.hash = '#/';
	}
	assert.equal(container.querySelector('.workbench-layout'), null);
});

test('opening a folder from Home shows its workspace tree without opening a document', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.goHome();
		assert.equal(workbench.container.querySelector<HTMLElement>('main.workbench')?.hidden, true);

		const openFolder = await waitFor(
			() => workbench.findButton((label) => label === 'Open folder' || label === '開啟資料夾'),
			10_000,
			workbench.flush
		);
		openFolder.click();
		await workbench.flush();

		const row = await waitFor(() => workbench.fileRow('first.tex'), 10_000, workbench.flush);
		assert.ok(row);
		assert.equal(workbench.container.querySelector<HTMLElement>('main.workbench')?.hidden, false);
		assert.equal(workbench.container.querySelector('.app')?.classList.contains('workbench-active'), true);
		assert.equal(
			workbench.container.querySelector('.source-view .cm-content') === null,
			true,
			'Opening a folder from Home must not mount a source editor without a selected document'
		);
	});
});

test('same-path reopen reconciles queued watch events against the latest real disk revision', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const initialEditor = workbench.container.querySelector('.cm-content');
		assert.ok(initialEditor);
		const readsBeforeReopen = workbench.readCount();

		// The adapter delays delivery only after FrontendFiles.read has produced its real receipt.
		const reopenGate = workbench.gateNextRead('first.tex');
		const row = workbench.fileRow('first.tex');
		assert.ok(row);
		await waitFor(() => row.disabled ? undefined : true, 10_000, workbench.flush);
		row.click();
		await waitFor(() => reopenGate.used ? true : undefined, 10_000, workbench.flush);
		await reopenGate.entered.promise;

		const sourceText = (marker: string) =>
			`\\documentclass{article}\n\\begin{document}\n${marker}\n\\end{document}\n`;
		await workbench.writeExternalAndWait(
			workbench.firstPath,
			sourceText('REOPEN_INTERMEDIATE_EXTERNAL')
		);
		await workbench.writeExternalAndWait(
			workbench.firstPath,
			sourceText('REOPEN_LATEST_EXTERNAL')
		);

		// Gate the reconciliation read too, so the test observes the same-path reopen
		// replacing the old editor snapshot before the queued event applies the new bytes.
		const reconciliationGate = workbench.gateNextRead('first.tex');
		reopenGate.release.resolve(undefined);
		await reopenGate.finished.promise;
		await waitFor(() => reconciliationGate.used ? true : undefined, 10_000, workbench.flush);
		await reconciliationGate.entered.promise;
		await waitFor(() => {
			const current = workbench.container.querySelector('.cm-content');
			return current && current !== initialEditor ? current : undefined;
		}, 10_000, workbench.flush);
		assert.ok(workbench.editorText().includes('BASE_FIRST'));
		assert.equal(workbench.editorText().includes('REOPEN_LATEST_EXTERNAL'), false);

		reconciliationGate.release.resolve(undefined);
		await reconciliationGate.finished.promise;
		await workbench.waitForSource('REOPEN_LATEST_EXTERNAL');
		assert.ok(workbench.readCount() >= readsBeforeReopen + 2);
		assert.equal(workbench.editorText().includes('REOPEN_INTERMEDIATE_EXTERNAL'), false);
		assert.equal(workbench.notice('changed'), null);
	});
});

test('external watch conflict preserves the dirty editor buffer until confirmed reload', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		workbench.pasteIntoSource('LOCAL_DRAFT_PRESERVED');
		const draft = await workbench.waitForSource('LOCAL_DRAFT_PRESERVED');

		await workbench.writeExternalAndWait(
			workbench.firstPath,
			'\\documentclass{article}\n\\begin{document}\nDIRTY_CASE_EXTERNAL\n\\end{document}\n'
		);
		await waitFor(() => workbench.notice('changed') ?? undefined, 10_000, workbench.flush);
		assert.equal(workbench.editorText(), draft, 'A watch conflict must not replace a dirty buffer');

		const reload = workbench.findButton((label) =>
			label === 'Reload from disk' || label === '從磁碟重新載入');
		assert.ok(reload);
		const confirmsBeforeReload = workbench.confirmCount();
		reload.click();
		await workbench.waitForSource('DIRTY_CASE_EXTERNAL');
		assert.ok(workbench.confirmCount() > confirmsBeforeReload, 'Reload must confirm discarding the dirty buffer');
		assert.equal(workbench.editorText().includes('LOCAL_DRAFT_PRESERVED'), false);
		assert.equal(workbench.notice('changed'), null);
	});
});

test('a failed save conflict preserves the draft and prevents compilation from starting', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		workbench.pasteIntoSource('CONFLICT_DRAFT_PRESERVED');
		const draft = await workbench.waitForSource('CONFLICT_DRAFT_PRESERVED');
		const external = '\\documentclass{article}\n\\begin{document}\nEXTERNAL_REVISION\n\\end{document}\n';

		await workbench.writeExternalAndWait(workbench.firstPath, external);
		await waitFor(() => workbench.notice('changed') ?? undefined, 10_000, workbench.flush);

		const compile = workbench.findButton((label) => label === 'Compile PDF' || label === '編譯 PDF');
		assert.ok(compile);
		compile.click();

		const errorText = await waitFor(() => {
			const strip = Array.from(workbench.container.querySelectorAll<HTMLElement>('.error-strip'))
				.find((candidate) => !candidate.classList.contains('file-change-notice'));
			return strip?.textContent?.trim() || undefined;
		}, 10_000, workbench.flush);

		assert.match(errorText, /Disk file changed|磁碟文件已變更/);
		assert.equal(workbench.editorText(), draft, 'A failed optimistic save must preserve the dirty source');
		assert.equal(workbench.compileStartCount(), 0, 'Compilation must not start after the save conflict');
		assert.equal(await fs.promises.readFile(workbench.firstPath, 'utf8'), external,
			'A failed save must not overwrite the externally changed file');
	});
});

test('configured main compiles with its saved identity and keeps the active child selected', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const mainPath = path.join(path.dirname(workbench.firstPath), 'main.tex');
		const mainBody = '\\documentclass{article}\n\\begin{document}\nMAIN_INITIAL\n\\end{document}\n';
		await workbench.writeExternalAndWait(mainPath, mainBody);
		const mainRow = await waitFor(() => workbench.fileRow('main.tex'), 10_000, workbench.flush);
		await waitFor(() => mainRow.disabled ? undefined : true, 10_000, workbench.flush);
		mainRow.click();
		await workbench.waitForSource('MAIN_INITIAL');
		workbench.pasteIntoSource('MAIN_SAVED_EDIT');
		await workbench.waitForSource('MAIN_SAVED_EDIT');
		const save = workbench.findButton((label) => label === 'Save' || label === '儲存');
		assert.ok(save);
		save.click();
		const savedMain = await waitFor(() => workbench.lastWrite('main.tex'), 10_000, workbench.flush);
		assert.ok(savedMain);

		const childRow = workbench.fileRow('first.tex');
		assert.ok(childRow);
		childRow.click();
		await workbench.waitForSource('BASE_FIRST');
		const childContents = workbench.editorText();
		assert.equal(childRow.getAttribute('aria-current'), 'true');
		workbench.setCompileMainFile('main.tex');

		const runControlledCompile = async (log: string) => {
			const plan = workbench.prepareCompile();
			const compile = await waitFor(
				() => workbench.findButton((label) => label === 'Compile PDF' || label === '編譯 PDF'),
				10_000,
				workbench.flush
			);
			compile.click();
			await plan.started;
			const identity = plan.identity();
			assert.ok(identity);
			plan.releaseStart();
			plan.resolveResult({ status: 'failure', identity, log, diagnostics: [] });
			const outputTab = await waitFor(
				() => workbench.container.querySelector<HTMLButtonElement>('#workbench-dock-tab-output'),
				10_000,
				workbench.flush
			);
			assert.ok(outputTab);
			outputTab.click();
			await waitFor(
				() => workbench.container.querySelector('.compile-output')?.textContent === log ? true : undefined,
				10_000,
				workbench.flush
			);
			await waitFor(
				() => workbench.findButton((label) => label === 'Compile PDF' || label === '編譯 PDF'),
				10_000,
				workbench.flush
			);
			const retry = workbench.findButton((label) => label === 'Compile PDF' || label === '編譯 PDF');
			assert.ok(retry);
			assert.equal(retry.disabled, false, 'A completed failed compile must leave retry available');
			assert.equal(workbench.editorText(), childContents);
			assert.equal(childRow.getAttribute('aria-current'), 'true');
			return identity;
		};

		const savedCompile = await runControlledCompile('tracked-main-saved');
		assert.equal(savedCompile.entryPath, 'main.tex');
		assert.equal(savedCompile.documentId, savedMain.documentId);
		assert.equal(savedCompile.documentVersion, savedMain.documentVersion);

		const unchangedCompile = await runControlledCompile('tracked-main-unchanged');
		assert.equal(unchangedCompile.documentId, savedMain.documentId);
		assert.equal(unchangedCompile.documentVersion, savedMain.documentVersion);

		await workbench.writeExternalAndWait(
			mainPath,
			'\\documentclass{article}\n\\begin{document}\nMAIN_EXTERNAL_CHANGE\n\\end{document}\n'
		);
		const changedCompile = await runControlledCompile('tracked-main-external-revision');
		assert.equal(changedCompile.documentId, savedMain.documentId);
		assert.equal(changedCompile.documentVersion, savedMain.documentVersion + 1);

		const untrackedMainPath = path.join(path.dirname(workbench.firstPath), 'untracked-main.tex');
		await workbench.writeExternalAndWait(
			untrackedMainPath,
			'\\documentclass{article}\n\\begin{document}\nUNTRACKED_MAIN\n\\end{document}\n'
		);
		workbench.setCompileMainFile('untracked-main.tex');
		const untrackedCompile = await runControlledCompile('untracked-main');
		assert.equal(untrackedCompile.entryPath, 'untracked-main.tex');
		assert.notEqual(untrackedCompile.documentId, savedMain.documentId);
	});
});

test('cancelled dirty folder selection preserves the editor and current route', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		workbench.pasteIntoSource('CANCELLED_SWITCH_DRAFT');
		const draft = await workbench.waitForSource('CANCELLED_SWITCH_DRAFT');
		workbench.setConfirmResult(false);
		const confirmations = workbench.confirmCount();
		await workbench.goHome();
		assert.equal(workbench.container.querySelector<HTMLElement>('main.workbench')?.hidden, true);

		const fileMenu = workbench.container.querySelector<HTMLDetailsElement>('details.file-menu');
		assert.ok(fileMenu);
		if (!fileMenu.open) fileMenu.querySelector('summary')?.click();
		const openFolder = workbench.findButton(
			(label) => label === 'Open folder' || label === '開啟資料夾',
			fileMenu
		);
		assert.ok(openFolder);
		openFolder.click();
		await workbench.flush();

		assert.ok(workbench.confirmCount() > confirmations);
		assert.equal(workbench.container.querySelector<HTMLElement>('main.workbench')?.hidden, true);
		assert.equal(workbench.editorText(), draft);
		assert.equal(workbench.editorText().includes('BASE_SECOND'), false);
		assert.equal(workbench.activeWatchCount(), 1);
		assert.equal(workbench.compileStartCount(), 0);
	});
});

test('workspace replacement during compile config read rejects the stale compile request', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const gate = workbench.gateNextCompileConfig();
		const row = workbench.fileRow('first.tex');
		assert.ok(row);
		row.dispatchEvent(new row.ownerDocument.defaultView!.MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			clientX: 20,
			clientY: 100
		}));
		const menu = await waitFor(() => workbench.container.querySelector('.file-context-menu'), 10_000, workbench.flush);
		assert.ok(menu);
		const compile = workbench.findButton(
			(label) => label === 'Compile PDF' || label === '編譯 PDF',
			menu
		);
		assert.ok(compile);
		compile.click();
		await gate.entered.promise;

		await workbench.openFolder('second.tex', 'BASE_SECOND');
		gate.release.resolve(undefined);
		await gate.finished.promise;
		await workbench.flush();
		assert.equal(workbench.compileStartCount(), 0);
		assert.ok(workbench.editorText().includes('BASE_SECOND'));
		assert.equal(workbench.editorText().includes('BASE_FIRST'), false);
	});
});

test('an old workspace watch read cannot publish into the newly opened workspace', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const oldOwnerGate = workbench.gateNextRead('first.tex');
		await workbench.writeExternalAndWait(
			workbench.firstPath,
			'\\documentclass{article}\n\\begin{document}\nOLD_OWNER_ONLY\n\\end{document}\n'
		);
		await waitFor(() => oldOwnerGate.used ? true : undefined, 10_000, workbench.flush);
		await oldOwnerGate.entered.promise;

		// Opening the second real workspace revokes the first FrontendWatch owner while
		// its already-captured host receipt remains delayed at the transparent barrier.
		await workbench.openFolder('second.tex', 'BASE_SECOND');
		oldOwnerGate.release.resolve(undefined);
		await oldOwnerGate.finished.promise;
		await new Promise((resolve) => setTimeout(resolve, 120));
		await workbench.flush();

		assert.ok(workbench.editorText().includes('BASE_SECOND'));
		assert.equal(workbench.editorText().includes('OLD_OWNER_ONLY'), false);
		assert.equal(workbench.activeWatchCount(), 1);
		assert.equal(workbench.notice('changed'), null);
	});
});

test('Home recent selection opens its file through DesktopPort and transfers the watch owner', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		await workbench.goHome();

		const recent = await waitFor(
			() => workbench.findButton((label) => label.includes('second.tex')),
			10_000,
			workbench.flush
		);
		recent.click();
		await workbench.waitForSource('BASE_SECOND');
		await waitFor(() => workbench.activeWatchCount() === 1 ? true : undefined, 10_000, workbench.flush);

		assert.equal(workbench.recentOpenCount(), 1);
		assert.equal(workbench.confirmCount(), 0, 'Opening a recent document must not confirm discarding a clean source');
		assert.ok(workbench.fileRow('second.tex'));
		assert.equal(workbench.notice('changed'), null);
	});
});

test('Save commits the dirty snapshot and the updated revision accepts later disk changes', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		workbench.pasteIntoSource('SAVE_DRAFT');
		await workbench.waitForSource('SAVE_DRAFT');

		const save = await waitFor(
			() => workbench.findButton((label) => label === 'Save' || label === '儲存'),
			10_000,
			workbench.flush
		);
		assert.equal(save.disabled, false);
		save.click();
		await waitFor(() => workbench.lastWrite('first.tex'), 10_000, workbench.flush);

		const saved = await fs.promises.readFile(workbench.firstPath, 'utf8');
		assert.ok(saved.includes('SAVE_DRAFT'));
		assert.ok(saved.includes('BASE_FIRST'));
		assert.equal(workbench.activeWatchCount(), 1, 'Saving must retain the current workspace watch');

		const external = '\\documentclass{article}\n\\begin{document}\nSAVE_EXTERNAL\n\\end{document}\n';
		await workbench.writeExternalAndWait(workbench.firstPath, external);
		await workbench.waitForSource('SAVE_EXTERNAL');
		assert.equal(workbench.notice('changed'), null);
	});
});

test('New confirms discarding a dirty source and Save As watches the new owner', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		workbench.pasteIntoSource('DISCARDED_OLD_DRAFT');
		await workbench.waitForSource('DISCARDED_OLD_DRAFT');

		const newDocument = workbench.findButton((label) => label === 'New document' || label === '新文件' || label === '新增文件');
		assert.ok(newDocument);
		const confirmations = workbench.confirmCount();
		newDocument.click();
		await waitFor(
			() => workbench.container.querySelector('.status-bar')?.textContent?.includes('untitled.tex') ? true : undefined,
			10_000,
			workbench.flush
		);
		assert.ok(workbench.confirmCount() > confirmations, 'New must confirm replacing a dirty document');
		assert.equal(workbench.editorText().includes('DISCARDED_OLD_DRAFT'), false);
		await waitFor(() => workbench.activeWatchCount() === 0 ? true : undefined, 10_000, workbench.flush);

		workbench.pasteIntoSource('NEW_DOCUMENT_TO_SAVE_AS');
		await workbench.waitForSource('NEW_DOCUMENT_TO_SAVE_AS');
		const saveAs = workbench.findButton((label) => label === 'Save as' || label === '另存新檔');
		assert.ok(saveAs);
		saveAs.click();

		await waitFor(() => {
			const status = workbench.container.querySelector('.status-bar')?.textContent ?? '';
			const save = workbench.findButton((label) => label === 'Save' || label === '儲存');
			return status.includes('saved-as.tex') && save?.disabled ? true : undefined;
		}, 10_000, workbench.flush);
		await waitFor(() => workbench.activeWatchCount() === 1 ? true : undefined, 10_000, workbench.flush);

		const savedAsPath = path.join(path.dirname(workbench.secondPath), 'saved-as.tex');
		const savedAs = await fs.promises.readFile(savedAsPath, 'utf8');
		assert.ok(savedAs.includes('NEW_DOCUMENT_TO_SAVE_AS'));
		assert.equal(savedAs.includes('DISCARDED_OLD_DRAFT'), false);
		const original = await fs.promises.readFile(workbench.firstPath, 'utf8');
		assert.ok(original.includes('BASE_FIRST'));
		assert.equal(original.includes('DISCARDED_OLD_DRAFT'), false);

		const external = '\\documentclass{article}\n\\begin{document}\nSAVE_AS_EXTERNAL\n\\end{document}\n';
		await workbench.writeExternalAndWait(savedAsPath, external);
		await workbench.waitForSource('SAVE_AS_EXTERNAL');
		assert.equal(workbench.notice('changed'), null);
	});
});

test('report template saves to a new TeX file through Save and subsequent saves use its disk revision', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.goHome();
		const report = await waitFor(() => workbench.findButton(label => label.startsWith('報告') || label.startsWith('Report')), 10_000, workbench.flush);
		assert.ok(report);
		report.click();
		await workbench.waitForSource('\\chapter{Introduction}');
		const save = workbench.findButton(label => label === 'Save' || label === '儲存');
		assert.ok(save);
		assert.equal(save.disabled, false);
		const savedPath = path.join(path.dirname(workbench.secondPath), 'saved-as.tex');
		assert.equal(fs.existsSync(savedPath), false);
		save.click();
		await waitFor(() => fs.existsSync(savedPath) ? true : undefined, 10_000, workbench.flush);
		await waitFor(() => workbench.activeWatchCount() === 1 ? true : undefined, 10_000, workbench.flush);
		assert.match(await fs.promises.readFile(savedPath, 'utf8'), /\\chapter\{Introduction\}/);
		workbench.pasteIntoSource('REPORT_SAVED_AGAIN');
		await workbench.waitForSource('REPORT_SAVED_AGAIN');
		workbench.findButton(label => label === 'Save' || label === '儲存')!.click();
		await waitFor(() => fs.readFileSync(savedPath, 'utf8').includes('REPORT_SAVED_AGAIN') ? true : undefined, 10_000, workbench.flush);
		assert.match(await fs.promises.readFile(savedPath, 'utf8'), /REPORT_SAVED_AGAIN/);
	});
});

test('cancel requested before compile start replies is applied to that compile', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const plan = workbench.prepareCompile();
		const compile = workbench.findButton((label) => label === 'Compile PDF' || label === '編譯 PDF');
		assert.ok(compile);
		compile.click();
		await plan.started;

		const cancel = await waitFor(
			() => workbench.findButton((label) => label === 'Cancel compilation' || label === '取消編譯'),
			10_000,
			workbench.flush
		);
		cancel.click();
		await workbench.flush();
		assert.equal(plan.cancellationCount(), 0, 'Cancellation waits for the pending start reply to provide its run identity');

		plan.releaseStart();
		await waitFor(() => {
			const status = workbench.container.querySelector('.status-bar')?.textContent ?? '';
			return status.includes('Compilation cancelled') || status.includes('編譯已取消') ? status : undefined;
		}, 10_000, workbench.flush);
		assert.equal(workbench.compileStartCount(), 1);
		assert.equal(plan.cancellationCount(), 1);
	});
});

test('file context actions are reachable and Escape restores file focus', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const row = await waitFor(() => workbench.fileRow('first.tex'), 10_000, workbench.flush);
		const win = row.ownerDocument.defaultView!;
		row.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 100 }));
		const menu = await waitFor(() => workbench.container.querySelector('.file-context-menu'), 10_000, workbench.flush);
		assert.ok(menu);
		assert.equal(menu.querySelectorAll('button').length, 3);
		assert.ok(menu.textContent?.includes('Compile PDF') || menu.textContent?.includes('編譯 PDF'));
		win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await workbench.flush();
		assert.equal(workbench.container.querySelector('.file-context-menu'), null);
		assert.equal(row.ownerDocument.activeElement, row);
	});
});

test('an included-file diagnostic navigates through DesktopPort into the real editor', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const included = '\\documentclass{article}\n\\begin{document}\nINCLUDED_SOURCE\n\\end{document}\n';
		await fs.promises.writeFile(path.join(path.dirname(workbench.firstPath), 'included.tex'), included, 'utf8');

		// The response is controlled at the existing DesktopPort compile contract; this is not native IPC coverage.
		const plan = workbench.prepareCompile();
		const compile = workbench.findButton((label) => label === 'Compile PDF' || label === '編譯 PDF');
		assert.ok(compile);
		compile.click();
		await plan.started;
		const identity = plan.identity();
		assert.ok(identity);
		plan.releaseStart();
		plan.resolveResult({
			status: 'failure',
			identity,
			log: 'Included-file diagnostic fixture',
			diagnostics: [{
				severity: 'error',
				message: 'Included-file diagnostic',
				path: 'included.tex',
				line: 3,
				column: 1
			}, {
				severity: 'error',
				message: 'Included-file diagnostic',
				path: 'included.tex',
				line: 3,
				column: 1
			}, {
				severity: 'error',
				message: 'Included-file diagnostic',
				path: 'included.tex',
				line: 3,
				column: 2
			}]
		});

		const diagnostic = await waitFor(
			() => {
				const button = workbench.findButton((label) => label.includes('included.tex:3'));
				return button && !button.disabled ? button : undefined;
			},
			10_000,
			workbench.flush
		);
		const problemsTab = workbench.container.querySelector<HTMLButtonElement>('#workbench-dock-tab-problems');
		assert.ok(problemsTab?.textContent?.includes('(2)'), 'Only exact duplicate diagnostics should be merged');
		const outputTab = workbench.container.querySelector<HTMLButtonElement>('#workbench-dock-tab-output');
		assert.ok(outputTab);
		outputTab.click();
		await waitFor(
			() => workbench.container.querySelector('.compile-output')?.textContent === 'Included-file diagnostic fixture' ? true : undefined,
			10_000,
			workbench.flush
		);
		problemsTab?.click();
		await workbench.flush();
		diagnostic.click();
		await workbench.waitForSource('INCLUDED_SOURCE');
		assert.equal(workbench.editorText().includes('BASE_FIRST'), false);
		assert.equal(workbench.container.querySelector('.status-bar')?.textContent?.includes('included.tex'), true);
	});
});

test('an invalid workspace PDF reports its header error without replacing the source', { timeout: 180_000 }, async () => {
	await withHostWorkbench(async (workbench) => {
		await workbench.openFolder('first.tex', 'BASE_FIRST');
		const original = workbench.editorText();
		const reads = workbench.readCount('invalid.pdf');
		const pdfRow = await waitFor(() => workbench.fileRow('invalid.pdf'), 10_000, workbench.flush);
		await waitFor(() => pdfRow.disabled ? undefined : true, 10_000, workbench.flush);
		pdfRow.click();

		const errorText = await waitFor(() => {
			const strip = Array.from(workbench.container.querySelectorAll<HTMLElement>('.error-strip'))
				.find((candidate) => !candidate.classList.contains('file-change-notice'));
			return strip?.textContent?.trim() || undefined;
		}, 10_000, workbench.flush);
		assert.ok(errorText.includes('Invalid PDF') || errorText.includes('不是有效的 PDF'));
		assert.equal(workbench.readCount('invalid.pdf'), reads + 1);
		assert.equal(workbench.editorText(), original, 'A rejected PDF must leave the current source untouched');
		assert.equal(workbench.container.querySelector('.preview-pane .pane-title')?.textContent?.includes('invalid.pdf'), false);
	});
});
