import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import {
	deferred,
	observePageRenders,
	observePdfLoadingTasks,
	pdfDocument,
	setupPdfJsdomEnvironment,
	threePages,
	within,
	type DOMWindow,
	type LoadingTaskRecord,
	type PageRenderRecord,
	type PublicLoadingTask
} from '../helpers/pdf-jsdom-harness.ts';

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
let restoreJsdom: (() => void) | null = null;

test.after(() => {
	try {
		restoreJsdom?.();
	} finally {
		dom = null;
		restoreJsdom = null;
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	}
});

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

const env = setupPdfJsdomEnvironment('https://pdf-view-race.test');
dom = env.dom;
restoreJsdom = env.restore;
const win = env.win;
const canvasBridge = env.canvasBridge;

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

test('shared JSDOM canvas bridge preserves drawImage overloads and resized backing surfaces', () => {
	assert.ok(dom);
	const source = win.document.createElement('canvas');
	source.width = 2;
	source.height = 2;
	const sourceContext = source.getContext('2d');
	assert.ok(sourceContext);
	sourceContext.fillStyle = '#ff0000';
	sourceContext.fillRect(0, 0, 1, 1);
	sourceContext.fillStyle = '#00ff00';
	sourceContext.fillRect(1, 0, 1, 1);
	sourceContext.fillStyle = '#0000ff';
	sourceContext.fillRect(0, 1, 1, 1);
	sourceContext.fillStyle = '#ffffff';
	sourceContext.fillRect(1, 1, 1, 1);

	const target = win.document.createElement('canvas');
	target.width = 8;
	target.height = 6;
	const targetContext = target.getContext('2d');
	assert.ok(targetContext);
	targetContext.drawImage(source, 0, 0);
	targetContext.drawImage(source, 4, 0, 4, 2);
	targetContext.drawImage(source, 1, 0, 1, 2, 0, 3, 1, 2);
	assert.deepEqual(pixelAt(target, 0, 0), [255, 0, 0, 255], 'three-argument drawImage keeps natural-size pixels');
	assert.deepEqual(pixelAt(target, 7, 1), [255, 255, 255, 255], 'five-argument drawImage keeps scaled pixels');
	assert.deepEqual(pixelAt(target, 0, 3), [0, 255, 0, 255], 'nine-argument drawImage keeps the cropped source region');
	assert.deepEqual(pixelAt(target, 0, 4), [255, 255, 255, 255]);

	const resizedSource = win.document.createElement('canvas');
	resizedSource.width = 1;
	resizedSource.height = 1;
	const initialSourceSurface = canvasBridge.nativeSurfaceFor(resizedSource);
	const initialSourceContext = resizedSource.getContext('2d');
	assert.ok(initialSourceContext);
	initialSourceContext.fillStyle = '#ff0000';
	initialSourceContext.fillRect(0, 0, 1, 1);
	resizedSource.width = 0;
	resizedSource.height = 0;
	const zeroSizeSourceSurface = canvasBridge.nativeSurfaceFor(resizedSource);
	assert.notEqual(zeroSizeSourceSurface, initialSourceSurface);
	resizedSource.width = 2;
	resizedSource.height = 2;
	const restoredSourceSurface = canvasBridge.nativeSurfaceFor(resizedSource);
	assert.notEqual(restoredSourceSurface, zeroSizeSourceSurface);
	assert.equal(restoredSourceSurface.width, 2);
	assert.equal(restoredSourceSurface.height, 2);
	const restoredSourceContext = resizedSource.getContext('2d');
	assert.ok(restoredSourceContext);
	restoredSourceContext.fillStyle = '#0000ff';
	restoredSourceContext.fillRect(0, 0, 2, 2);

	const resizedTarget = win.document.createElement('canvas');
	resizedTarget.width = 1;
	resizedTarget.height = 1;
	const previousTargetSurface = canvasBridge.nativeSurfaceFor(resizedTarget);
	const previouslyObtainedContext = resizedTarget.getContext('2d');
	assert.ok(previouslyObtainedContext);
	resizedTarget.width = 2;
	resizedTarget.height = 2;
	previouslyObtainedContext.drawImage(resizedSource, 0, 0);
	assert.notEqual(canvasBridge.nativeSurfaceFor(resizedTarget), previousTargetSurface);
	assert.deepEqual(pixelAt(resizedTarget, 1, 1), [0, 0, 255, 255], 'a stale context draws into the restored destination backing surface');
});

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
