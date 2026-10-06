import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { DiagramCpu } from '../src/diagram-cpu';

// Failure-only lifecycle fault injection. No fake PDF success; real printing is the Electron smoke.
const state = vi.hoisted(() => ({
	windows: [] as any[],
	sessions: [] as any[],
	ready: Promise.resolve(),
	onReady: undefined as (() => void) | undefined,
	onWindow: undefined as (() => void) | undefined,
	load: () => new Promise<void>(() => {}),
	print: () => new Promise<Buffer>(() => {})
}));
vi.mock('electron', async () => {
	const { EventEmitter } = await import('node:events');
	class OwnedWindow extends EventEmitter {
		dead = false;
		webContents: any;
		constructor(readonly options: unknown) {
			super();
			this.webContents = Object.assign(new EventEmitter(), {
				id: state.windows.length + 1,
				setWindowOpenHandler: vi.fn(),
				getURL: () => '',
				printToPDF: () => state.print()
			});
			state.windows.push(this);
			state.onWindow?.();
		}
		isDestroyed() {
			return this.dead;
		}
		destroy() {
			this.dead = true;
			this.emit('closed');
		}
		loadURL() {
			return state.load();
		}
	}
	return {
		app: {
			whenReady: () => {
				state.onReady?.();
				return state.ready;
			}
		},
		BrowserWindow: OwnedWindow,
		session: {
			fromPartition: (partition: string, options: unknown) => {
				const owned = Object.assign(new EventEmitter(), {
					partition,
					options,
					protocol: { handle: vi.fn(), unhandle: vi.fn() },
					webRequest: { onBeforeRequest: vi.fn() },
					setPermissionCheckHandler: vi.fn(),
					setPermissionRequestHandler: vi.fn(),
					closeAllConnections: vi.fn(async () => {})
				});
				state.sessions.push(owned);
				return owned;
			}
		}
	};
});
import { renderDiagramSvgToPdf as renderProductionPdf } from '../src/diagram-pdf';
let owned: string;
let cpu: DiagramCpu;
beforeAll(async () => {
	owned = await mkdtemp(join(tmpdir(), 'modutex-pdf-cpu-'));
	const artifact = join(owned, 'diagram-cpu-worker.js');
	await build({
		entryPoints: [resolve('electron/src/diagram-cpu-worker.ts')],
		outfile: artifact,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24'
	});
	cpu = new DiagramCpu(artifact);
});
afterAll(async () => {
	await cpu.close();
	await rm(owned, { recursive: true, force: true });
});
const renderDiagramSvgToPdf = (svg: string, signal: AbortSignal) => renderProductionPdf(svg, signal, cpu);
async function waitForWindow() {
	if (state.windows.length) return;
	await new Promise<void>((resolve) => {
		state.onWindow = resolve;
	});
	// The constructor callback precedes producer listener registration in the same turn.
	await Promise.resolve();
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><text x="10" y="30">vector</text><path d="M0 0L100 100"/></svg>';
afterEach(() => {
	vi.useRealTimers();
	state.windows.length = 0;
	state.sessions.length = 0;
	state.ready = Promise.resolve();
	state.onReady = undefined;
	state.onWindow = undefined;
	state.load = () => new Promise<void>(() => {});
});
function cleanupProof() {
	for (const win of state.windows) expect(win.dead).toBe(true);
	for (const win of state.windows) {
		expect(win.listenerCount('closed')).toBe(0);
		expect(win.webContents.eventNames()).toHaveLength(0);
	}
	for (const ses of state.sessions) {
		expect(ses.partition.startsWith('persist:')).toBe(false);
		expect(ses.protocol.unhandle).toHaveBeenCalledWith('diagram-pdf');
		const retiredGuard = ses.webRequest.onBeforeRequest.mock.calls.at(-1)![0];
		const callback = vi.fn();
		retiredGuard({ url: 'https://example.invalid/late' }, callback);
		expect(callback).toHaveBeenCalledWith({ cancel: true });
		expect(ses.webRequest.onBeforeRequest.mock.calls.some(([guard]: unknown[]) => guard === null)).toBe(false);
		expect(ses.listenerCount('will-download')).toBe(0);
		expect(ses.closeAllConnections).toHaveBeenCalledOnce();
	}
}
describe('isolated PDF producer failure lifetime', () => {
	it('validates before creating any session/window', async () => {
		await expect(renderDiagramSvgToPdf(SVG.replace('<text', '<foreignObject'), new AbortController().signal)).rejects.toThrow(
			'INVALID_SVG'
		);
		expect(state.windows).toHaveLength(0);
		expect(state.sessions).toHaveLength(0);
	});
	it('rejects already-aborted work without creating a window', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(renderDiagramSvgToPdf(SVG, controller.signal)).rejects.toThrow('RENDER_ABORTED');
		expect(state.windows).toHaveLength(0);
	});
	it('aborts a real producer load lifecycle and releases handlers', async () => {
		const controller = new AbortController();
		const work = renderDiagramSvgToPdf(SVG, controller.signal);
		await waitForWindow();
		expect(state.windows).toHaveLength(1);
		expect((state.windows[0].options as any).webPreferences).toMatchObject({
			javascript: false,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webviewTag: false
		});
		controller.abort();
		await expect(work).rejects.toThrow('RENDER_ABORTED');
		cleanupProof();
	});
	it('includes waiting for app readiness in the 30 second lifetime', async () => {
		vi.useFakeTimers();
		let ready!: () => void;
		state.ready = new Promise((resolve) => {
			ready = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			state.onReady = resolve;
		});
		const work = renderDiagramSvgToPdf(SVG, new AbortController().signal);
		const assertion = expect(work).rejects.toThrow('RENDER_TIMEOUT');
		await entered; // Actual async worker finished, native readiness remains unresolved.
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
		ready();
		await Promise.resolve();
		expect(state.windows).toHaveLength(0);
	});
	it('times out a hung load without returning a late result', async () => {
		vi.useFakeTimers();
		let late!: () => void;
		state.load = () =>
			new Promise((resolve) => {
				late = resolve;
			});
		const work = renderDiagramSvgToPdf(SVG, new AbortController().signal);
		const assertion = expect(work).rejects.toThrow('RENDER_TIMEOUT');
		await waitForWindow();
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
		cleanupProof();
		late();
		await Promise.resolve();
		expect(state.windows).toHaveLength(1);
	});
	it('crash and attempted navigation fail closed', async () => {
		const work = renderDiagramSvgToPdf(SVG, new AbortController().signal);
		const assertion = expect(work).rejects.toThrow('RENDER_FAILED');
		await waitForWindow();
		state.windows[0].webContents.emit('render-process-gone');
		await assertion;
		cleanupProof();
	});
	it('preserves the abort together with cleanup failures and still clears other handlers', async () => {
		const controller = new AbortController();
		const work = renderDiagramSvgToPdf(SVG, controller.signal);
		await waitForWindow();
		state.sessions[0].closeAllConnections.mockRejectedValueOnce(new Error('injected cleanup failure'));
		controller.abort();
		try {
			await work;
			throw new Error('unexpected success');
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['RENDER_ABORTED', 'CLEANUP_FAILED']);
		}
		cleanupProof();
	});
});
