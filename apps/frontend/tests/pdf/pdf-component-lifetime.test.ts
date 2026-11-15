import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { File as NodeFile } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import {
	deferred,
	onePage,
	setupPdfJsdomEnvironment,
	twoPages,
	within,
	type DOMWindow,
	type LoadingTaskRecord,
	type PublicLoadingTask
} from '../helpers/pdf-jsdom-harness.ts';

type MountedPdfView = { setActive(value: boolean): void; setBytes(value: Uint8Array): void };
type PdfViewHarnessApi = {
	mount: {
		(component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }): MountedPdfView;
		(component: unknown, options: { target: HTMLElement }): unknown;
	};
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	PdfViewHarness: unknown;
	App: unknown;
	createProbeTask(bytes: Uint8Array): PublicLoadingTask;
	observePdfLoadingTasks: (
		prototype: object,
		listener: (record: LoadingTaskRecord) => void
	) => () => void;
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const appPath = fileURLToPath(new URL('../../src/App.svelte', import.meta.url)).replaceAll('\\', '/');
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

const buildDir = fs.mkdtempSync(path.join(frontendRoot, '.pdf-lifetime-'));
tempDir = buildDir;
const harnessPath = path.join(buildDir, 'PdfViewHarness.svelte');
const entryFile = path.join(buildDir, 'entry.js');
const harnessImportPath = harnessPath.replaceAll('\\', '/');

fs.writeFileSync(
	harnessPath,
	`<script lang="ts">
	import PdfView from '${pdfViewPath}';

	let { bytes: initialBytes, onError, onPageCount } = $props<{
		bytes: Uint8Array;
		onError: (message: string) => void;
		onPageCount: (count: number) => void;
	}>();
	let bytes = $state(initialBytes);
	let active = $state(true);

	export function setActive(value: boolean) {
		active = value;
	}
	export function setBytes(value: Uint8Array) {
		bytes = value;
	}
</script>

{#key bytes}
<PdfView {bytes} {active} locale="en" {onError} {onPageCount} />
{/key}
`
);

fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import PdfViewHarness from '${harnessImportPath}';
import App from '${appPath}';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

export { mount, unmount, flushSync, tick, PdfViewHarness, App };

// Return the actual public getDocument result. This uses the same bundled worker
// URL as PdfView and does not replace or wrap PDF.js's loading-task provider.
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

// The prototype comes from a real, already-settled probe task. Instrument only
// its public methods and forward the original receiver, arguments, and results.
export function observePdfLoadingTasks(prototype, listener) {
	const promiseDescriptor = Object.getOwnPropertyDescriptor(prototype, 'promise');
	const destroyDescriptor = Object.getOwnPropertyDescriptor(prototype, 'destroy');
	if (typeof promiseDescriptor?.get !== 'function' || typeof destroyDescriptor?.value !== 'function') {
		throw new Error('The real PDF.js loading-task prototype lacks its public lifecycle methods');
	}

	const originalPromiseGetter = promiseDescriptor.get;
	const originalDestroy = destroyDescriptor.value;
	const records = new WeakMap();

	Object.defineProperty(prototype, 'promise', {
		...promiseDescriptor,
		get() {
			const promise = originalPromiseGetter.call(this);
			if (!records.has(this)) {
				const record = {
					task: this,
					promise,
					settled: Promise.resolve(promise).then(
						() => ({ status: 'fulfilled' }),
						(error) => ({ status: 'rejected', error })
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
		value: function (...args) {
			const record = records.get(this);
			if (record) record.destroyCalls += 1;
			const result = originalDestroy.apply(this, args);
			if (record) {
				record.destroyResults.push(Promise.resolve(result).then(
					() => ({ status: 'fulfilled' }),
					(error) => ({ status: 'rejected', error })
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
`
);

await build({
	configFile: false,
	worker: { format: 'es' },
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

const env = setupPdfJsdomEnvironment('https://pdf-view.test');
dom = env.dom;
restoreJsdom = env.restore;
const win = env.win;

const bundleUrl = pathToFileURL(path.join(buildDir, 'pdf-view-client.mjs')).href;
// Node 24 lacks newer typed-array codecs used by the browser build. Load the
// installed PDF.js legacy compatibility layer, without replacing the component's API.
await import('pdfjs-dist/legacy/build/pdf.mjs');
const api = (await import(bundleUrl)) as PdfViewHarnessApi;

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

async function waitForTaskRecord(
	records: LoadingTaskRecord[],
	index: number,
	description: string
): Promise<LoadingTaskRecord> {
	await waitUntil(() => records.length > index, description);
	const record = records[index];
	assert.ok(record);
	return record;
}

async function assertSingleSuccessfulDestroy(record: LoadingTaskRecord, description: string): Promise<void> {
	await waitUntil(() => record.destroyCalls > 0, description);
	assert.equal(record.destroyCalls, 1, 'the real loading task must be destroyed exactly once');
	assert.equal(record.destroyResults.length, 1, 'the real destroy result must be observed');
	const [result] = record.destroyResults;
	assert.ok(result);
	assert.equal((await within(result, description)).status, 'fulfilled');
}

async function assertObservedTasksReleased(records: LoadingTaskRecord[], description: string): Promise<void> {
	await within(Promise.all(records.map((record) => record.settled)), `${description} loading tasks to settle`);
	for (const [index, record] of records.entries()) {
		await assertSingleSuccessfulDestroy(record, `${description} task ${index} destruction`);
	}
}

function canvasPixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
	const context = canvas.getContext('2d');
	assert.ok(context);
	const px = Math.min(canvas.width - 1, Math.floor((x / 100) * canvas.width));
	const py = Math.min(canvas.height - 1, Math.floor((y / 100) * canvas.height));
	return Array.from(context.getImageData(px, py, 1, 1).data);
}

async function waitForCanvasPixel(
	target: HTMLElement,
	x: number,
	y: number,
	expected: number[],
	description: string
): Promise<void> {
	await waitUntil(() => {
		const canvas = target.querySelector('canvas');
		if (!canvas || canvas.width < 1 || canvas.height < 1) return false;
		const context = canvas.getContext('2d');
		if (!context) return false;
		const px = Math.min(canvas.width - 1, Math.floor((x / 100) * canvas.width));
		const py = Math.min(canvas.height - 1, Math.floor((y / 100) * canvas.height));
		return Array.from(context.getImageData(px, py, 1, 1).data)
			.every((value, index) => value === expected[index]);
	}, description);
}

function selectFile(input: HTMLInputElement, file: NodeFile): void {
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [file] as unknown as FileList
	});
	input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

async function waitForRenderedPage(
	target: HTMLElement,
	page: number,
	errors: string[]
): Promise<void> {
	await waitUntil(
		() => errors.length > 0 || target.querySelector('canvas')?.getAttribute('aria-label') === `PDF page ${page}`,
		`PDF page ${page} to render`
	);
	assert.deepEqual(errors, [], `PdfView must not report an error while rendering page ${page}`);
}

async function cleanupMounted(
	instance: MountedPdfView | undefined,
	pendingUnmount: Promise<void> | undefined
): Promise<void> {
	if (!instance) return;
	const cleanup = pendingUnmount ?? api.unmount(instance);
	await within(cleanup, 'PdfView cleanup', 5_000);
}

// Obtain and fully destroy a genuine public getDocument task before installing
// the prototype observer used by the component lifecycle tests.
const probe = api.createProbeTask(twoPages());
const taskPrototype = Object.getPrototypeOf(probe) as object;
try {
	await within(probe.promise, 'the real PDF.js probe document to load');
} finally {
	await within(probe.destroy(), 'the real PDF.js probe task to be destroyed');
}

test('PdfView unmounts an in-flight real PDF.js task without late callbacks', async () => {
	assert.ok(dom);
	const target = dom.window.document.createElement('div');
	dom.window.document.body.append(target);

	const pageCounts: number[] = [];
	const errors: string[] = [];
	const taskSeen = deferred<LoadingTaskRecord>();
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;
	let observed = false;
	const stopObserving = api.observePdfLoadingTasks(taskPrototype, (record) => {
		if (observed) return;
		observed = true;
		taskSeen.resolve(record);
		if (!instance) throw new Error('PDF.js loading began before PdfView mounted');
		pendingUnmount = api.unmount(instance);
	});

	try {
		instance = api.mount(api.PdfViewHarness, {
			target,
			props: {
				bytes: twoPages(),
				onError: (message: string) => errors.push(message),
				onPageCount: (count: number) => pageCounts.push(count)
			}
		});

		const record = await within(taskSeen.promise, 'PdfView to create its real PDF.js task');
		assert.ok(pendingUnmount, 'PdfView must be unmounted as soon as its loading task is observed');
		const earlyUnmount = pendingUnmount;
		await within(earlyUnmount, 'early PdfView unmount');
		await within(record.settled, 'the destroyed PDF.js loading task to settle');
		assert.equal(record.destroyCalls, 1, 'unmount must call the real PDF.js destroy method once');
		assert.equal(record.destroyResults.length, 1);
		const [destroyResult] = record.destroyResults;
		assert.ok(destroyResult, 'the real destroy call result must be observed');
		assert.equal((await within(destroyResult, 'early PDF.js task destruction')).status, 'fulfilled');
		await within(new Promise<void>((resolve) => setTimeout(resolve, 20)), 'late loading callbacks');
		api.flushSync();
		assert.deepEqual(pageCounts, [], 'a disposed PdfView must not publish a late page count');
		assert.deepEqual(errors, [], 'a disposed PdfView must not publish a late load error');
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
		} finally {
			try {
				stopObserving();
			} finally {
				target.remove();
			}
		}
	}
});

test('PdfView renders after loading, pauses and resumes with active, and destroys after unmount', async () => {
	assert.ok(dom);
	const target = dom.window.document.createElement('div');
	dom.window.document.body.append(target);

	const pageCounts: number[] = [];
	const errors: string[] = [];
	const taskSeen = deferred<LoadingTaskRecord>();
	const pageCountSeen = deferred<number>();
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;
	let observed = false;
	const stopObserving = api.observePdfLoadingTasks(taskPrototype, (record) => {
		if (observed) return;
		observed = true;
		taskSeen.resolve(record);
	});

	try {
		instance = api.mount(api.PdfViewHarness, {
			target,
			props: {
				bytes: twoPages(),
				onError: (message: string) => errors.push(message),
				onPageCount: (count: number) => {
					pageCounts.push(count);
					pageCountSeen.resolve(count);
				}
			}
		});

		const scroll = target.querySelector('.pdf-scroll') as HTMLDivElement | null;
		assert.ok(scroll, 'the actual PdfView scroll surface must be mounted');
		Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 640 });
		const canvas = target.querySelector('canvas') as HTMLCanvasElement | null;
		assert.ok(canvas, 'the actual PdfView canvas must be mounted');

		const record = await within(taskSeen.promise, 'PdfView to create its real PDF.js task');
		assert.equal(await within(pageCountSeen.promise, 'the real PDF.js document to load'), 2);
		assert.equal((await within(record.settled, 'the real PDF.js load to settle')).status, 'fulfilled');
		await waitForRenderedPage(target, 1, errors);
		assert.deepEqual(pageCounts, [2]);

		instance.setActive(false);
		api.flushSync();
		await within(api.tick(), 'the inactive PdfView update');
		const nextButton = Array.from(target.querySelectorAll('button'))
			.find((button) => button.textContent?.trim() === 'Next page');
		assert.ok(nextButton, 'the PDF next-page control must be present');
		nextButton.click();
		api.flushSync();
		await within(api.tick(), 'the inactive page change');
		await within(new Promise<void>((resolve) => setTimeout(resolve, 30)), 'inactive render queue pause');
		assert.equal(canvas.getAttribute('aria-label'), 'PDF page 1', 'inactive PdfView must not render the changed page');

		instance.setActive(true);
		api.flushSync();
		await within(api.tick(), 'the active PdfView update');
		await waitForRenderedPage(target, 2, errors);
		assert.deepEqual(pageCounts, [2], 'active changes must not republish the page count');

		const completedUnmount = api.unmount(instance);
		pendingUnmount = completedUnmount;
		await within(completedUnmount, 'PdfView unmount after a completed load');
		assert.equal(record.destroyCalls, 1, 'unmount must destroy the real completed task once');
		assert.equal(record.destroyResults.length, 1);
		const [destroyResult] = record.destroyResults;
		assert.ok(destroyResult, 'the real destroy call result must be observed');
		assert.equal((await within(destroyResult, 'completed PDF.js task destruction')).status, 'fulfilled');
		await within(new Promise<void>((resolve) => setTimeout(resolve, 20)), 'late completed-load callbacks');
		api.flushSync();
		assert.deepEqual(pageCounts, [2], 'unmount must not publish another page count');
		assert.deepEqual(errors, [], 'a successful PdfView must not publish a late error');
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
		} finally {
			try {
				stopObserving();
			} finally {
				target.remove();
			}
		}
	}
});

test('keyed PdfView replacement retires the old real document and renders the new one', async () => {
	assert.ok(dom);
	const target = dom.window.document.createElement('div');
	dom.window.document.body.append(target);
	const pageCounts: number[] = [];
	const errors: string[] = [];
	const records: LoadingTaskRecord[] = [];
	const pageCountSeen = deferred<number>();
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;
	const stopObserving = api.observePdfLoadingTasks(taskPrototype, (record) => records.push(record));

	try {
		instance = api.mount(api.PdfViewHarness, {
			target,
			props: {
				bytes: twoPages(),
				onError: (message: string) => errors.push(message),
				onPageCount: (count: number) => {
					pageCounts.push(count);
					pageCountSeen.resolve(count);
				}
			}
		});
		const scroll = target.querySelector('.pdf-scroll') as HTMLDivElement | null;
		assert.ok(scroll);
		Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 640 });
		const oldCanvas = target.querySelector('canvas') as HTMLCanvasElement | null;
		assert.ok(oldCanvas);

		const original = await waitForTaskRecord(records, 0, 'the original keyed PDF.js task');
		assert.equal(await within(pageCountSeen.promise, 'the original page count'), 2);
		assert.equal((await within(original.settled, 'the original PDF.js load')).status, 'fulfilled');
		await waitForRenderedPage(target, 1, errors);
		assert.deepEqual(canvasPixel(oldCanvas, 65, 35), [255, 255, 255, 255]);

		instance.setBytes(onePage());
		api.flushSync();
		const replacementScroll = target.querySelector('.pdf-scroll') as HTMLDivElement | null;
		assert.ok(replacementScroll, 'the keyed replacement must have a PDF scroll surface');
		assert.notEqual(replacementScroll, scroll, 'the keyed replacement must have a fresh scroll surface');
		Object.defineProperty(replacementScroll, 'clientWidth', { configurable: true, value: 640 });
		const replacement = await waitForTaskRecord(records, 1, 'the keyed replacement PDF.js task');
		assert.equal((await within(replacement.settled, 'the replacement PDF.js load')).status, 'fulfilled');
		await waitUntil(() => pageCounts.length === 2, 'the replacement page count');
		assert.deepEqual(pageCounts, [2, 1]);
		await waitForCanvasPixel(target, 65, 35, [0, 0, 0, 255], 'the replacement vector pixels');
		const replacementCanvas = target.querySelector('canvas');
		assert.ok(replacementCanvas);
		assert.notEqual(replacementCanvas, oldCanvas, 'the keyed parent must mount a fresh PdfView canvas');
		await assertSingleSuccessfulDestroy(original, 'the replaced original PDF.js task');
		assert.equal(replacement.destroyCalls, 0, 'the currently published document must remain alive');
		assert.deepEqual(errors, []);

		pendingUnmount = api.unmount(instance);
		api.flushSync();
		await within(pendingUnmount, 'keyed replacement unmount');
		await assertObservedTasksReleased(records, 'keyed replacement');
		await within(new Promise<void>((resolve) => setTimeout(resolve, 20)), 'late keyed replacement callbacks');
		api.flushSync();
		assert.deepEqual(pageCounts, [2, 1]);
		assert.deepEqual(errors, []);
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
			await assertObservedTasksReleased(records, 'keyed replacement cleanup');
		} finally {
			try {
				stopObserving();
			} finally {
				target.remove();
			}
		}
	}
});

test('rapid keyed replacements and unmount settle and destroy every observed real loading task', async () => {
	assert.ok(dom);
	const target = dom.window.document.createElement('div');
	dom.window.document.body.append(target);
	const pageCounts: number[] = [];
	const errors: string[] = [];
	const records: LoadingTaskRecord[] = [];
	const pageCountSeen = deferred<number>();
	let instance: MountedPdfView | undefined;
	let pendingUnmount: Promise<void> | undefined;
	let replaceOnNextTask = false;
	let unmountOnFollowingTask = false;
	const stopObserving = api.observePdfLoadingTasks(taskPrototype, (record) => {
		records.push(record);
		if (replaceOnNextTask && records.length === 2) {
			replaceOnNextTask = false;
			if (!instance) throw new Error('The keyed parent must be mounted before replacement');
			instance.setBytes(twoPages());
			api.flushSync();
		} else if (unmountOnFollowingTask && records.length === 3) {
			unmountOnFollowingTask = false;
			if (!instance) throw new Error('The keyed parent must be mounted before unmount');
			pendingUnmount = api.unmount(instance);
			api.flushSync();
		}
	});

	try {
		instance = api.mount(api.PdfViewHarness, {
			target,
			props: {
				bytes: twoPages(),
				onError: (message: string) => errors.push(message),
				onPageCount: (count: number) => {
					pageCounts.push(count);
					pageCountSeen.resolve(count);
				}
			}
		});
		const original = await waitForTaskRecord(records, 0, 'the initial rapid-replacement task');
		assert.equal(await within(pageCountSeen.promise, 'the initial rapid-replacement page count'), 2);
		assert.equal((await within(original.settled, 'the initial rapid-replacement load')).status, 'fulfilled');
		await waitForRenderedPage(target, 1, errors);

		replaceOnNextTask = true;
		unmountOnFollowingTask = true;
		instance.setBytes(onePage());
		api.flushSync();
		await waitUntil(
			() => records.length === 3 && pendingUnmount !== undefined,
			'two keyed replacements followed by unmount'
		);
		assert.ok(pendingUnmount);
		await within(pendingUnmount, 'rapid keyed replacement unmount');
		await assertObservedTasksReleased(records, 'rapid keyed replacement');
		await within(new Promise<void>((resolve) => setTimeout(resolve, 20)), 'late rapid-replacement callbacks');
		api.flushSync();
		assert.deepEqual(pageCounts, [2], 'obsolete keyed children must not publish page counts');
		assert.deepEqual(errors, [], 'obsolete keyed children must not publish errors');
	} finally {
		try {
			await cleanupMounted(instance, pendingUnmount);
			await assertObservedTasksReleased(records, 'rapid keyed replacement cleanup');
		} finally {
			try {
				stopObserving();
			} finally {
				target.remove();
			}
		}
	}
});

test('actual App keeps the published PDF when opening a replacement fails before publication', async () => {
	assert.ok(dom);
	dom.window.location.hash = '#/workbench';
	const target = dom.window.document.createElement('div');
	dom.window.document.body.append(target);
	const records: LoadingTaskRecord[] = [];
	let instance: unknown;
	let pendingUnmount: Promise<void> | undefined;
	const stopObserving = api.observePdfLoadingTasks(taskPrototype, (record) => records.push(record));

	try {
		instance = api.mount(api.App, { target });
		api.flushSync();
		await waitUntil(() => !!target.querySelector('.preview-pane'), 'the actual App PDF pane');
		const input = target.querySelector('input[type="file"][accept=".pdf"]') as HTMLInputElement | null;
		assert.ok(input, 'the actual App PDF input must be mounted');

		selectFile(input, new NodeFile([twoPages()], 'published.pdf', { type: 'application/pdf' }));
		const publishedTask = await waitForTaskRecord(records, 0, 'the PDF published by the actual App');
		assert.equal((await within(publishedTask.settled, 'the App-published PDF load')).status, 'fulfilled');
		await waitUntil(
			() => target.querySelector('.preview-pane')?.textContent?.includes('共 2 頁') === true,
			'the actual App page count'
		);
		const publishedCanvas = target.querySelector('.preview-pane canvas');
		assert.ok(publishedCanvas);

		// App.openPdf only assigns pdfBytes after readPdf succeeds. A rejected
		// file read therefore must not change the key or unmount the good PdfView.
		selectFile(input, new NodeFile(['not a PDF'], 'rejected.pdf', { type: 'application/pdf' }));
		await waitUntil(() => !!target.querySelector('.error-strip[role="alert"]'), 'the actual App file-read error');
		assert.equal(records.length, 1, 'a pre-publication read failure must not create another PDF.js task');
		assert.equal(target.querySelector('.preview-pane canvas'), publishedCanvas, 'the last published keyed child must remain mounted');
		assert.ok(target.querySelector('.preview-pane')?.textContent?.includes('共 2 頁'));
		assert.equal(publishedTask.destroyCalls, 0, 'the published PDF must remain alive after the failed read');

		pendingUnmount = api.unmount(instance);
		api.flushSync();
		await within(pendingUnmount, 'actual App unmount');
		await assertObservedTasksReleased(records, 'actual App publication');
		await within(new Promise<void>((resolve) => setTimeout(resolve, 20)), 'late actual App callbacks');
		api.flushSync();
		assert.equal(records.length, 1);
	} finally {
		try {
			if (instance) {
				const cleanup = pendingUnmount ?? api.unmount(instance);
				api.flushSync();
				await within(cleanup, 'actual App cleanup');
			}
			await assertObservedTasksReleased(records, 'actual App cleanup');
		} finally {
			try {
				stopObserving();
			} finally {
				target.remove();
				dom.window.location.hash = '#/';
			}
		}
	}
});
