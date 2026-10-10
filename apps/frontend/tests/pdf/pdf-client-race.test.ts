import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const require = createRequire(import.meta.url);

type DOMWindow = Window & typeof globalThis & {
	close(): void;
};

const { JSDOM } = require('jsdom') as {
	JSDOM: new (
		html?: string,
		options?: { url?: string; pretendToBeVisual?: boolean }
	) => {
		window: DOMWindow;
	};
};

type TaskOutcome =
	| { status: 'fulfilled' }
	| { status: 'rejected'; error: unknown };

type LoadingTaskRecord = {
	task: PublicLoadingTask;
	promise: Promise<unknown>;
	settled: Promise<TaskOutcome>;
	destroyCalls: number;
	destroyResults: Promise<TaskOutcome>[];
};

type PublicLoadingTask = {
	promise: Promise<unknown>;
	destroy(): Promise<void>;
};

type RenderState = 'pending' | 'fulfilled' | 'rejected';

type PublicRenderTask = {
	promise: Promise<unknown>;
	cancel(): void;
	onContinue: ((continueRendering: () => void) => void) | null;
};

type PageRenderRecord = {
	readonly task: PublicRenderTask;
	readonly page: number | undefined;
	readonly width: number | undefined;
	readonly settled: Promise<TaskOutcome>;
	readonly continuationSeen: Promise<boolean>;
	readonly outcome: RenderState;
	readonly released: boolean;
	resume(): void;
};

type MountedPdfView = {
	setActive(value: boolean): void;
};

type PdfViewHarnessApi = {
	mount: (
		component: unknown,
		options: { target: HTMLElement; props: Record<string, unknown> }
	) => MountedPdfView;
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	PdfViewHarness: unknown;
	createProbeTask(bytes: Uint8Array): PublicLoadingTask;
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const pdfViewPath = fileURLToPath(new URL('../../src/features/pdf/PdfView.svelte', import.meta.url))
	.replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;
const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

function restoreGlobals(): void {
	for (const [key, descriptor] of previousDescriptors) {
		if (descriptor === undefined) {
			if (!Reflect.deleteProperty(globalThis, key)) {
				throw new Error(`Could not restore global ${key}`);
			}
		} else {
			Object.defineProperty(globalThis, key, descriptor);
		}
	}
	previousDescriptors.clear();
}

test.after(() => {
	try {
		dom?.window.close();
	} finally {
		dom = null;
		try {
			restoreGlobals();
		} finally {
			if (tempDir) {
				fs.rmSync(tempDir, { recursive: true, force: true });
				tempDir = null;
			}
		}
	}
});

/** A small, valid PDF fixture with a distinct solid vector on each page. */
function pdfDocument(commands: readonly string[]): Uint8Array {
	assert.ok(commands.length > 0, 'the PDF fixture must have at least one page');
	const pageRefs = commands.map((_, index) => `${index + 3} 0 R`).join(' ');
	const firstContentObject = commands.length + 3;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		`<< /Type /Pages /Kids [${pageRefs}] /Count ${commands.length} >>`,
		...commands.map((_, index) =>
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents ${firstContentObject + index} 0 R >>`
		),
		...commands.map((value) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`)
	];
	let value = '%PDF-1.7\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(value.length);
		value += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = value.length;
	value += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	value += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
	value += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(value);
}

function threePages(): Uint8Array {
	return pdfDocument([
		'1 0 0 rg 10 10 20 20 re f',
		'0 1 0 rg 40 40 20 20 re f',
		'0 0 1 rg 70 70 20 20 re f'
	]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function within<T>(
	promise: Promise<T>,
	description: string,
	timeoutMs = 15_000
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
			})
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function waitUntil(
	predicate: () => boolean,
	description: string,
	timeoutMs = 15_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		api.flushSync();
		if (predicate()) return;
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`Timed out waiting for ${description}`);
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
	}
}

function observePdfLoadingTasks(
	prototype: object,
	listener: (record: LoadingTaskRecord) => void
): () => void {
	const promiseDescriptor = Object.getOwnPropertyDescriptor(prototype, 'promise');
	const destroyDescriptor = Object.getOwnPropertyDescriptor(prototype, 'destroy');
	if (typeof promiseDescriptor?.get !== 'function' || typeof destroyDescriptor?.value !== 'function') {
		throw new Error('The real PDF.js loading-task prototype lacks its public lifecycle methods');
	}

	const originalPromiseGetter = promiseDescriptor.get;
	const originalDestroy = destroyDescriptor.value as (...args: unknown[]) => Promise<void>;
	const records = new WeakMap<object, LoadingTaskRecord>();

	Object.defineProperty(prototype, 'promise', {
		...promiseDescriptor,
		get(this: object) {
			const promise = Reflect.apply(originalPromiseGetter, this, []) as Promise<unknown>;
			if (!records.has(this)) {
				const record: LoadingTaskRecord = {
					task: this as PublicLoadingTask,
					promise,
					settled: Promise.resolve(promise).then(
						() => ({ status: 'fulfilled' as const }),
						(error: unknown) => ({ status: 'rejected' as const, error })
					),
					destroyCalls: 0,
					destroyResults: []
				};
				records.set(this, record);
				listener(record);
			}
			return promise;
		}
	});

	Object.defineProperty(prototype, 'destroy', {
		...destroyDescriptor,
		value: function (this: object, ...args: unknown[]) {
			const record = records.get(this);
			if (record) record.destroyCalls += 1;
			const result = Reflect.apply(originalDestroy, this, args) as Promise<void>;
			if (record) {
				record.destroyResults.push(Promise.resolve(result).then(
					() => ({ status: 'fulfilled' as const }),
					(error: unknown) => ({ status: 'rejected' as const, error })
				));
			}
			return result;
		}
	});

	return () => {
		Object.defineProperty(prototype, 'promise', promiseDescriptor);
		Object.defineProperty(prototype, 'destroy', destroyDescriptor);
	};
}

/**
 * Observe the real page.render result. When requested, its public onContinue hook
 * pauses that same PDF.js render task so the test can deterministically exercise
 * cancellation and replacement without substituting a PDF provider or renderer.
 */
function observePageRenders(
	prototype: object,
	listener: (record: PageRenderRecord) => void,
	holdContinuations = false
): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(prototype, 'render');
	if (typeof descriptor?.value !== 'function') {
		throw new Error('The real PDF.js page prototype lacks its public render method');
	}
	const originalRender = descriptor.value as (this: object, ...args: unknown[]) => PublicRenderTask;

	Object.defineProperty(prototype, 'render', {
		...descriptor,
		value: function (this: object, ...args: unknown[]): PublicRenderTask {
			const task = Reflect.apply(originalRender, this, args) as PublicRenderTask;
			const page = (this as { pageNumber?: number }).pageNumber;
			const parameters = args[0] as { viewport?: { width?: number } } | undefined;
			const width = parameters?.viewport?.width;
			let outcome: RenderState = 'pending';
			let continuation: (() => void) | undefined;
			let released = false;
			let continuationReported = false;
			const continuationSeen = deferred<boolean>();
			const settled = Promise.resolve(task.promise).then(
				() => {
					outcome = 'fulfilled';
					return { status: 'fulfilled' as const };
				},
				(error: unknown) => {
					outcome = 'rejected';
					return { status: 'rejected' as const, error };
				}
			);
			const record: PageRenderRecord = {
				task,
				page,
				width,
				settled,
				continuationSeen: continuationSeen.promise,
				get outcome() { return outcome; },
				get released() { return released; },
				resume() {
					released = true;
					const next = continuation;
					continuation = undefined;
					next?.();
				}
			};

			if (holdContinuations) {
				task.onContinue = (next) => {
					if (released) {
						next();
						return;
					}
					continuation = next;
					if (!continuationReported) {
						continuationReported = true;
						continuationSeen.resolve(true);
					}
				};
			}
			listener(record);
			return task;
		}
	});

	return () => Object.defineProperty(prototype, 'render', descriptor);
}

const explicitDomKeys = [
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
	'CharacterData',
	'Attr',
	'HTMLInputElement',
	'HTMLSelectElement',
	'HTMLOptionElement',
	'HTMLButtonElement',
	'HTMLAnchorElement',
	'HTMLDivElement',
	'HTMLLabelElement',
	'HTMLSpanElement',
	'HTMLCanvasElement',
	'HTMLTemplateElement',
	'HTMLStyleElement',
	'HTMLLinkElement',
	'Event',
	'EventTarget',
	'CustomEvent',
	'KeyboardEvent',
	'MouseEvent',
	'UIEvent',
	'MutationObserver',
	'ImageData',
	'DOMMatrix',
	'Path2D'
] as const;

function exposeGlobal(key: string, value: unknown): void {
	if (!previousDescriptors.has(key)) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	Object.defineProperty(globalThis, key, {
		value,
		writable: true,
		configurable: true
	});
}

const buildDir = fs.mkdtempSync(path.join(frontendRoot, '.pdf-client-race-'));
tempDir = buildDir;
const harnessPath = path.join(buildDir, 'PdfViewHarness.svelte');
const entryFile = path.join(buildDir, 'entry.js');
const harnessImportPath = harnessPath.replaceAll('\\', '/');

fs.writeFileSync(
	harnessPath,
	`<script lang="ts">
	import PdfView from '${pdfViewPath}';

	let { bytes, active: initiallyActive = true, onError, onPageCount } = $props<{
		bytes: Uint8Array;
		active?: boolean;
		onError: (message: string) => void;
		onPageCount: (count: number) => void;
	}>();
	let active = $state(initiallyActive);

	export function setActive(value: boolean) {
		active = value;
	}
</script>

<PdfView {bytes} {active} locale="en" {onError} {onPageCount} />
`
);

fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import PdfViewHarness from '${harnessImportPath}';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

export { mount, unmount, flushSync, tick, PdfViewHarness };

export function createProbeTask(bytes) {
	GlobalWorkerOptions.workerSrc = workerUrl;
	return getDocument({
		data: new Uint8Array(bytes),
		enableXfa: false,
		stopAtErrors: true,
		disableAutoFetch: true,
		disableStream: true,
		useSystemFonts: true,
		maxImageSize: 16777216
	});
}
`
);

await build({
	configFile: false,
	root: frontendRoot,
	plugins: [svelte()],
	resolve: {
		conditions: ['browser', 'default']
	},
	build: {
		write: true,
		outDir: buildDir,
		emptyOutDir: false,
		assetsInlineLimit: 16_777_216,
		lib: {
			entry: entryFile,
			formats: ['es'],
			fileName: () => 'pdf-view-client.mjs'
		},
		sourcemap: false,
		minify: false
	},
	logLevel: 'silent'
});

const jsdom = new JSDOM(
	'<!DOCTYPE html><html><body></body></html>',
	{ url: 'https://pdf-view-race.test', pretendToBeVisual: true }
);
dom = jsdom;
const win = jsdom.window;

for (const key of explicitDomKeys) {
	if (!previousDescriptors.has(key)) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	if (key in win) {
		Object.defineProperty(globalThis, key, {
			value: win[key as keyof DOMWindow],
			writable: true,
			configurable: true
		});
	}
}

// Bridge only the DOM canvas surface to genuine installed native rasterization.
// JSDOM has no layout: ResizeObserver intentionally emits nothing, and RAF is
// timer-backed. Assertions cover real PDF.js tasks and native pixels, not browser
// resize/frame scheduling or browser/desktop GUI acceptance.
const nativeCanvas = require('@napi-rs/canvas') as Record<string, unknown> & {
	createCanvas(width: number, height: number): {
		width: number;
		height: number;
		getContext(type: '2d'): CanvasRenderingContext2D;
	};
};
const nativeSurfaces = new WeakMap<HTMLCanvasElement, ReturnType<typeof nativeCanvas.createCanvas>>();
Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', {
	configurable: true,
	value: function (this: HTMLCanvasElement, kind: string) {
		if (kind !== '2d') return null;
		let surface = nativeSurfaces.get(this);
		if (!surface) {
			surface = nativeCanvas.createCanvas(this.width, this.height);
			nativeSurfaces.set(this, surface);
		}
		if (surface.width !== this.width) surface.width = this.width;
		if (surface.height !== this.height) surface.height = this.height;
		return surface.getContext('2d');
	}
});

const windowRecord = win as unknown as Record<string, unknown>;
const runtimeRecord = globalThis as unknown as Record<string, unknown>;
for (const key of ['DOMMatrix', 'ImageData', 'Path2D']) {
	const value = nativeCanvas[key];
	if (typeof value !== 'function') continue;
	if (typeof windowRecord[key] === 'undefined') {
		Object.defineProperty(win, key, { value, writable: true, configurable: true });
	}
	if (typeof runtimeRecord[key] === 'undefined') exposeGlobal(key, value);
}

class ResizeObserverStub {
	constructor(_callback: ResizeObserverCallback) {}
	observe(_target: Element): void {}
	unobserve(_target: Element): void {}
	disconnect(): void {}
}

Object.defineProperty(win, 'ResizeObserver', {
	value: ResizeObserverStub,
	writable: true,
	configurable: true
});
exposeGlobal('ResizeObserver', ResizeObserverStub);
Object.defineProperty(win, 'devicePixelRatio', { value: 1, configurable: true });

const requestFrame = (callback: FrameRequestCallback): number =>
	setTimeout(() => callback(Date.now()), 0) as unknown as number;
const cancelFrame = (handle: number): void => clearTimeout(handle);
Object.defineProperty(win, 'requestAnimationFrame', {
	value: requestFrame,
	writable: true,
	configurable: true
});
Object.defineProperty(win, 'cancelAnimationFrame', {
	value: cancelFrame,
	writable: true,
	configurable: true
});
exposeGlobal('requestAnimationFrame', requestFrame);
exposeGlobal('cancelAnimationFrame', cancelFrame);

assert.ok(
	win.document.createElement('canvas').getContext('2d'),
	'JSDOM must provide the installed native Node canvas context for PdfView rendering'
);

const bundleUrl = pathToFileURL(path.join(buildDir, 'pdf-view-client.mjs')).href;
// Load PDF.js's installed legacy compatibility layer for Node's typed-array
// codecs; the component and probe still use the real bundled PDF.js client.
await import('pdfjs-dist/legacy/build/pdf.mjs');
const api = (await import(bundleUrl)) as PdfViewHarnessApi;

const probe = api.createProbeTask(threePages());
const taskPrototype = Object.getPrototypeOf(probe) as object;
let renderPrototype: object | null = null;
try {
	const probeDocument = await within(probe.promise, 'the real PDF.js probe document to load') as {
		getPage(pageNumber: number): Promise<{ cleanup(): unknown }>;
	};
	const probePage = await within(probeDocument.getPage(1), 'a real PDF.js page proxy');
	renderPrototype = Object.getPrototypeOf(probePage) as object;
	probePage.cleanup();
} finally {
	await within(probe.destroy(), 'the real PDF.js probe task to be destroyed');
}
assert.ok(renderPrototype, 'a real PDF.js page proxy must expose its render prototype');

function createTarget(): HTMLDivElement {
	assert.ok(dom);
	const target = dom.window.document.createElement('div');
	dom.window.document.body.append(target);
	return target;
}

function mountView(
	target: HTMLElement,
	bytes: Uint8Array,
	active: boolean,
	onError: (message: string) => void,
	onPageCount: (count: number) => void
): MountedPdfView {
	// App.svelte keys PdfView by pdfBytes. Replacements below use a real
	// unmount/remount rather than expecting a live bytes prop mutation to reload.
	return api.mount(api.PdfViewHarness, {
		target,
		props: { bytes, active, onError, onPageCount }
	});
}

function setScrollWidth(target: HTMLElement, width = 640): void {
	const scroll = target.querySelector('.pdf-scroll') as HTMLDivElement | null;
	assert.ok(scroll, 'the actual PdfView scroll surface must be mounted');
	Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: width });
}

function clickButton(target: HTMLElement, label: string): void {
	const button = Array.from(target.querySelectorAll('button'))
		.find((item) => item.textContent?.trim() === label);
	assert.ok(button, `the ${label} control must be present`);
	button.click();
	api.flushSync();
}

function setZoom(target: HTMLElement, value: number): void {
	const select = target.querySelector('.zoom select') as HTMLSelectElement | null;
	assert.ok(select, 'the actual PdfView zoom control must be mounted');
	select.value = String(value);
	assert.ok(dom);
	select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	api.flushSync();
}

function canvasIn(target: HTMLElement): HTMLCanvasElement {
	const canvas = target.querySelector('canvas');
	assert.ok(canvas, 'the actual PdfView canvas must be mounted');
	return canvas;
}

function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): number[] {
	const context = canvas.getContext('2d');
	assert.ok(context, 'the native canvas must provide a 2D context');
	return Array.from(context.getImageData(x, y, 1, 1).data);
}

async function waitForRenderedPage(
	target: HTMLElement,
	page: number,
	errors: string[]
): Promise<void> {
	await waitUntil(
		() => errors.length > 0 || canvasIn(target).getAttribute('aria-label') === `PDF page ${page}`,
		`PDF page ${page} to render`
	);
	assert.deepEqual(errors, [], `PdfView must not report an error while rendering page ${page}`);
}

async function waitForLateCallbacks(): Promise<void> {
	await within(
		new Promise<void>((resolve) => setTimeout(resolve, 25)),
		'late PdfView callbacks',
		2_000
	);
	api.flushSync();
}

async function assertTaskDestroyedOnce(
	record: LoadingTaskRecord,
	description: string,
	expectedLoadStatus: 'fulfilled' | 'rejected' = 'fulfilled'
): Promise<void> {
	const loaded = await within(record.settled, `${description} loading task to settle`);
	assert.equal(loaded.status, expectedLoadStatus);
	assert.equal(record.task.promise, record.promise, 'the observed task must retain its actual public promise');
	assert.equal(record.destroyCalls, 1, `${description} must destroy its actual loading task once`);
	assert.equal(record.destroyResults.length, 1);
	const [destroyResult] = record.destroyResults;
	assert.ok(destroyResult, `${description} must expose the actual destroy result`);
	assert.equal(
		(await within(destroyResult, `${description} loading task destruction`)).status,
		'fulfilled'
	);
}

async function cleanupMounted(
	instance: MountedPdfView | undefined,
	pendingUnmount: Promise<void> | undefined
): Promise<void> {
	if (!instance) return;
	await within(pendingUnmount ?? api.unmount(instance), 'PdfView cleanup', 5_000);
}

test('rapid page and zoom requests leave the latest real PDF.js render on canvas', async () => {
	const target = createTarget();
	const errors: string[] = [];
	const pageCounts: number[] = [];
	const loadingSeen = deferred<LoadingTaskRecord>();
	const loadingRecords: LoadingTaskRecord[] = [];
	const stopLoading = observePdfLoadingTasks(taskPrototype, (record) => {
		loadingRecords.push(record);
		loadingSeen.resolve(record);
	});
	const renders: PageRenderRecord[] = [];
	const stopRenders = observePageRenders(renderPrototype as object, (record) => renders.push(record), true);
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;

	try {
		instance = mountView(
			target,
			threePages(),
			true,
			(message) => errors.push(message),
			(count) => pageCounts.push(count)
		);
		setScrollWidth(target);

		const loading = await within(loadingSeen.promise, 'PdfView to create its real PDF.js loading task');
		const loadedDocument = await within(loading.promise, 'the real three-page PDF to load') as { numPages: number };
		assert.equal(loadedDocument.numPages, 3);
		await waitUntil(() => pageCounts.length === 1, 'the actual document page count');
		assert.deepEqual(pageCounts, [3]);
		assert.equal((await within(loading.settled, 'the successful loading task')).status, 'fulfilled');

		await waitUntil(() => renders.length > 0, 'PdfView to start its first real page render');
		const first = renders[0];
		assert.ok(first);
		await within(first.continuationSeen, 'the first PDF.js render continuation to pause');
		assert.equal(first.page, 1);
		assert.equal(first.outcome, 'pending', 'the first actual render must still be in flight');

		clickButton(target, 'Next page');
		clickButton(target, 'Next page');
		setZoom(target, 50);
		setZoom(target, 200);
		clickButton(target, 'Previous page');

		const pageInput = target.querySelector('input[type="number"]') as HTMLInputElement | null;
		const zoomSelect = target.querySelector('.zoom select') as HTMLSelectElement | null;
		assert.ok(pageInput);
		assert.ok(zoomSelect);
		assert.equal(pageInput.value, '2');
		assert.equal(zoomSelect.value, '200');
		assert.equal(
			(await within(first.settled, 'the superseded PDF.js render to be cancelled')).status,
			'rejected'
		);
		assert.equal(first.outcome, 'rejected');

		await waitUntil(
			() => renders.some((record) => record.page === 2 && record.width === 200),
			'the final page-two, 200-percent PDF.js render'
		);
		const latest = renders.find((record) => record.page === 2 && record.width === 200);
		assert.ok(latest);
		await within(latest.continuationSeen, 'the final PDF.js render continuation to pause');
		assert.equal(latest.outcome, 'pending');
		assert.equal(renders.length, 2, 'intermediate page and zoom requests must be replaced while drawing');

		latest.resume();
		await waitForRenderedPage(target, 2, errors);
		const canvas = canvasIn(target);
		assert.equal(canvas.width, 200, 'the final canvas must use the latest 200-percent zoom');
		assert.equal(canvas.height, 200);
		assert.deepEqual(pixelAt(canvas, 100, 100), [0, 255, 0, 255], 'the final canvas must show page two');
		assert.deepEqual(pageCounts, [3], 'render requests must not republish the document page count');
		assert.deepEqual(errors, []);
		assert.equal((await within(latest.settled, 'the final PDF.js render to finish')).status, 'fulfilled');

		pendingUnmount = api.unmount(instance);
		await within(pendingUnmount, 'PdfView unmount after the final render');
		await assertTaskDestroyedOnce(loading, 'the rendered PDF');
		await waitForLateCallbacks();
		assert.deepEqual(errors, []);
		assert.deepEqual(pageCounts, [3]);
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
		} finally {
			try {
				stopRenders();
			} finally {
				stopLoading();
				target.remove();
			}
		}
	}
});

test('malformed bytes report one load error and unmount destroys the real task', async () => {
	const target = createTarget();
	const errors: string[] = [];
	const pageCounts: number[] = [];
	const loadingSeen = deferred<LoadingTaskRecord>();
	const stopLoading = observePdfLoadingTasks(taskPrototype, loadingSeen.resolve);
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;

	try {
		instance = mountView(
			target,
			new TextEncoder().encode('this is not a PDF document'),
			true,
			(message) => errors.push(message),
			(count) => pageCounts.push(count)
		);

		const loading = await within(loadingSeen.promise, 'PdfView to create a real task for malformed bytes');
		assert.equal((await within(loading.settled, 'the malformed PDF.js load to reject')).status, 'rejected');
		await waitUntil(() => errors.length > 0, 'PdfView to report the malformed PDF load');
		assert.deepEqual(errors, ['PDF_LOAD'], 'malformed bytes must report one load error');
		assert.deepEqual(pageCounts, []);

		pendingUnmount = api.unmount(instance);
		await within(pendingUnmount, 'malformed PdfView unmount');
		await assertTaskDestroyedOnce(loading, 'the malformed PDF', 'rejected');
		await waitForLateCallbacks();
		assert.deepEqual(errors, ['PDF_LOAD'], 'unmount must not publish another load error');
		assert.deepEqual(pageCounts, []);
		assert.equal(target.querySelector('.pdf-view'), null, 'unmount must remove the client view');
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
		} finally {
			stopLoading();
			target.remove();
		}
	}
});

test('an inactive initial load renders only the latest page after resuming', async () => {
	const target = createTarget();
	const errors: string[] = [];
	const pageCounts: number[] = [];
	const loadingSeen = deferred<LoadingTaskRecord>();
	const stopLoading = observePdfLoadingTasks(taskPrototype, loadingSeen.resolve);
	const renders: PageRenderRecord[] = [];
	const stopRenders = observePageRenders(renderPrototype as object, (record) => renders.push(record));
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;

	try {
		instance = mountView(
			target,
			threePages(),
			false,
			(message) => errors.push(message),
			(count) => pageCounts.push(count)
		);
		setScrollWidth(target);

		const loading = await within(loadingSeen.promise, 'inactive PdfView to create its real loading task');
		await within(loading.promise, 'the inactive PDF to load');
		await waitUntil(() => pageCounts.length === 1, 'the inactive document page count');
		assert.equal((await within(loading.settled, 'the inactive loading task')).status, 'fulfilled');
		assert.deepEqual(pageCounts, [3]);
		assert.equal(renders.length, 0, 'an inactive initial load must not start a canvas render');

		clickButton(target, 'Next page');
		clickButton(target, 'Next page');
		setZoom(target, 100);
		const pageInput = target.querySelector('input[type="number"]') as HTMLInputElement | null;
		assert.ok(pageInput);
		assert.equal(pageInput.value, '3');
		assert.equal(renders.length, 0, 'page and zoom changes while inactive must remain paused');
		assert.equal(canvasIn(target).getAttribute('aria-label'), 'PDF preview');

		instance.setActive(true);
		api.flushSync();
		await within(api.tick(), 'the PdfView resume update');
		await waitForRenderedPage(target, 3, errors);
		assert.equal(renders.length, 1);
		assert.equal(renders[0]?.page, 3, 'resume must render the latest page, not the initial page');
		assert.equal((await within(renders[0]!.settled, 'the resumed PDF.js render')).status, 'fulfilled');
		const canvas = canvasIn(target);
		assert.equal(canvas.width, 100);
		assert.equal(canvas.height, 100);
		assert.deepEqual(pixelAt(canvas, 80, 20), [0, 0, 255, 255], 'the resumed canvas must show page three');
		assert.deepEqual(errors, []);

		pendingUnmount = api.unmount(instance);
		await within(pendingUnmount, 'resumed PdfView unmount');
		await assertTaskDestroyedOnce(loading, 'the resumed PDF');
		await waitForLateCallbacks();
		assert.deepEqual(errors, []);
		assert.deepEqual(pageCounts, [3]);
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
		} finally {
			try {
				stopRenders();
			} finally {
				stopLoading();
				target.remove();
			}
		}
	}
});

test('disposing during an actual page render suppresses callbacks and destroys its loading task once', async () => {
	const target = createTarget();
	const errors: string[] = [];
	const pageCounts: number[] = [];
	const loadingSeen = deferred<LoadingTaskRecord>();
	const stopLoading = observePdfLoadingTasks(taskPrototype, loadingSeen.resolve);
	const renders: PageRenderRecord[] = [];
	const stopRenders = observePageRenders(renderPrototype as object, (record) => renders.push(record), true);
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;

	try {
		instance = mountView(
			target,
			threePages(),
			true,
			(message) => errors.push(message),
			(count) => pageCounts.push(count)
		);
		setScrollWidth(target);

		const loading = await within(loadingSeen.promise, 'PdfView to create its real loading task');
		await within(loading.promise, 'the PDF to load before rendering');
		await waitUntil(() => pageCounts.length === 1, 'the actual document page count');
		await waitUntil(() => renders.length > 0, 'the real page render to start');
		const render = renders[0];
		assert.ok(render);
		await within(render.continuationSeen, 'the actual page render to pause at its public continuation');
		assert.equal(render.outcome, 'pending', 'the PDF.js render task must still be in flight');
		assert.deepEqual(errors, []);

		pendingUnmount = api.unmount(instance);
		await within(pendingUnmount, 'PdfView unmount during its page render');
		assert.equal(
			(await within(render.settled, 'the cancelled actual PDF.js render to settle')).status,
			'rejected'
		);
		assert.equal(render.outcome, 'rejected');
		await assertTaskDestroyedOnce(loading, 'the disposed PDF');
		await waitForLateCallbacks();
		assert.deepEqual(errors, [], 'a disposed render must not publish a late render error');
		assert.deepEqual(pageCounts, [3], 'a disposed view must not publish another page-count callback');
		assert.equal(target.querySelector('.pdf-view'), null);
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
		} finally {
			try {
				stopRenders();
			} finally {
				stopLoading();
				target.remove();
			}
		}
	}
});

test('a keyed-style PDF replacement uses a fresh PdfView and loading task', async () => {
	const target = createTarget();
	const loadingRecords: LoadingTaskRecord[] = [];
	const stopLoading = observePdfLoadingTasks(taskPrototype, (record) => loadingRecords.push(record));
	const firstErrors: string[] = [];
	const firstPageCounts: number[] = [];
	const secondErrors: string[] = [];
	const secondPageCounts: number[] = [];
	let firstInstance: MountedPdfView | undefined;
	let firstUnmount: Promise<void> | undefined;
	let secondInstance: MountedPdfView | undefined;
	let secondUnmount: Promise<void> | undefined;

	try {
		firstInstance = mountView(
			target,
			threePages(),
			false,
			(message) => firstErrors.push(message),
			(count) => firstPageCounts.push(count)
		);
		setScrollWidth(target);
		await waitUntil(() => loadingRecords.length === 1, 'the first keyed-view loading task');
		const firstLoading = loadingRecords[0];
		assert.ok(firstLoading);
		await within(firstLoading.promise, 'the first PDF to load');
		await waitUntil(() => firstPageCounts.length === 1, 'the first PDF page count');
		setZoom(target, 100);
		firstInstance.setActive(true);
		api.flushSync();
		await within(api.tick(), 'the first keyed-view resume update');
		await waitForRenderedPage(target, 1, firstErrors);
		assert.deepEqual(pixelAt(canvasIn(target), 20, 80), [255, 0, 0, 255]);

		firstUnmount = api.unmount(firstInstance);
		await within(firstUnmount, 'the first keyed PdfView unmount');
		await assertTaskDestroyedOnce(firstLoading, 'the first keyed PDF');
		assert.equal(target.querySelector('.pdf-view'), null);

		secondInstance = mountView(
			target,
			pdfDocument(['0 0 1 rg 10 10 20 20 re f']),
			false,
			(message) => secondErrors.push(message),
			(count) => secondPageCounts.push(count)
		);
		setScrollWidth(target);
		await waitUntil(() => loadingRecords.length === 2, 'the replacement keyed-view loading task');
		const secondLoading = loadingRecords[1];
		assert.ok(secondLoading);
		assert.notEqual(secondLoading.task, firstLoading.task, 'replacement must create a new PDF.js task');
		assert.notEqual(secondLoading.promise, firstLoading.promise);
		await within(secondLoading.promise, 'the replacement PDF to load');
		await waitUntil(() => secondPageCounts.length === 1, 'the replacement PDF page count');
		assert.deepEqual(secondPageCounts, [1]);
		setZoom(target, 100);
		secondInstance.setActive(true);
		api.flushSync();
		await within(api.tick(), 'the replacement keyed-view resume update');
		await waitForRenderedPage(target, 1, secondErrors);
		assert.deepEqual(
			pixelAt(canvasIn(target), 20, 80),
			[0, 0, 255, 255],
			'a fresh keyed view must render the replacement PDF bytes'
		);

		secondUnmount = api.unmount(secondInstance);
		await within(secondUnmount, 'the replacement keyed PdfView unmount');
		await assertTaskDestroyedOnce(secondLoading, 'the replacement keyed PDF');
		await waitForLateCallbacks();
		assert.deepEqual(firstErrors, []);
		assert.deepEqual(firstPageCounts, [3]);
		assert.deepEqual(secondErrors, []);
		assert.deepEqual(secondPageCounts, [1]);
	} finally {
		try {
			await cleanupMounted(firstInstance, firstUnmount);
		} finally {
			try {
				await cleanupMounted(secondInstance, secondUnmount);
			} finally {
				stopLoading();
				target.remove();
			}
		}
	}
});
