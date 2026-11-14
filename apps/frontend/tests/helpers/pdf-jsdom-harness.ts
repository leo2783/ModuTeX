import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNativeCanvasBridge, type NativeCanvasFactory } from './native-canvas-bridge.ts';

const require = createRequire(import.meta.url);

export type DOMWindow = Window & typeof globalThis & {
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

export type TaskOutcome =
	| { status: 'fulfilled' }
	| { status: 'rejected'; error: unknown };

export type PublicLoadingTask = {
	promise: Promise<unknown>;
	destroy(): Promise<void>;
};

export type LoadingTaskRecord = {
	task: PublicLoadingTask;
	promise: Promise<unknown>;
	settled: Promise<TaskOutcome>;
	destroyCalls: number;
	destroyResults: Promise<TaskOutcome>[];
};

export type RenderState = 'pending' | 'fulfilled' | 'rejected';

export type PublicRenderTask = {
	promise: Promise<unknown>;
	cancel(): void;
	onContinue: ((continueRendering: () => void) => void) | null;
};

export type PageRenderRecord = {
	readonly task: PublicRenderTask;
	readonly page: number | undefined;
	readonly width: number | undefined;
	readonly settled: Promise<TaskOutcome>;
	readonly continuationSeen: Promise<boolean>;
	readonly outcome: RenderState;
	readonly released: boolean;
	resume(): void;
};

export function pdfDocument(commands: readonly string[]): Uint8Array {
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

export function onePage(): Uint8Array {
	return pdfDocument(['0 0 0 rg 60 60 20 20 re f']);
}

export function twoPages(): Uint8Array {
	return pdfDocument(['0 0 0 rg 10 10 20 20 re f', '0 0 0 rg 60 60 20 20 re f']);
}

export function threePages(): Uint8Array {
	return pdfDocument([
		'1 0 0 rg 10 10 20 20 re f',
		'0 1 0 rg 40 40 20 20 re f',
		'0 0 1 rg 70 70 20 20 re f'
	]);
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

export async function within<T>(
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

export function observePdfLoadingTasks(
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

export function observePageRenders(
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

export function setupPdfJsdomEnvironment(url = 'https://pdf-view.test'): {
	dom: { window: DOMWindow };
	win: DOMWindow;
	canvasBridge: ReturnType<typeof installNativeCanvasBridge>;
	restore(): void;
} {
	const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
	const exposeGlobal = (key: string, value: unknown): void => {
		if (!previousDescriptors.has(key)) {
			previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		}
		Object.defineProperty(globalThis, key, {
			value,
			writable: true,
			configurable: true
		});
	};

	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
		url,
		pretendToBeVisual: true
	});
	const win = dom.window;

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

	class JSDOMMediaQueryList extends EventTarget implements MediaQueryList {
		readonly media: string;
		readonly matches = false;
		onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null = null;
		constructor(query: string) {
			super();
			this.media = query;
		}
		addListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null): void {
			if (callback) this.addEventListener('change', callback as unknown as EventListener);
		}
		removeListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null): void {
			if (callback) this.removeEventListener('change', callback as unknown as EventListener);
		}
	}
	win.matchMedia = (query: string): MediaQueryList => new JSDOMMediaQueryList(query);

	const nativeCanvas = require('@napi-rs/canvas') as Record<string, unknown> & NativeCanvasFactory;
	const canvasBridge = installNativeCanvasBridge(win, nativeCanvas);
	const windowRecord = win as unknown as Record<string, unknown>;
	const runtimeRecord = globalThis as unknown as Record<string, unknown>;
	for (const key of ['DOMMatrix', 'ImageData', 'Path2D']) {
		const value = nativeCanvas?.[key];
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

	return {
		dom,
		win,
		canvasBridge,
		restore() {
			try {
				dom.window.close();
			} finally {
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
		}
	};
}
