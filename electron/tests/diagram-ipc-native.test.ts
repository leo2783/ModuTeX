import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { DiagramCpu } from '../src/diagram-cpu';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { registerDiagramNativeIpc, type DiagramRelinkEvent } from '../src/diagram-ipc';
import { DiagramPublicationIndeterminateError } from '../src/diagram-publication';
const source = 'assets/diagrams/test-123e4567-e89b-42d3-a456-426614174000.drawio';
const id = '123e4567-e89b-42d3-a456-426614174001';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>text</text></svg>';
const roots: string[] = [];
let cpuRoot: string;
let cpu: DiagramCpu;
beforeAll(async () => {
	cpuRoot = await mkdtemp(path.join(os.tmpdir(), 'modutex-ipc-cpu-'));
	const artifact = path.join(cpuRoot, 'diagram-cpu-worker.js');
	await build({
		entryPoints: [path.resolve('electron/src/diagram-cpu-worker.ts')],
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
	await rm(cpuRoot, { recursive: true, force: true });
});
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'modutex-diagram-ipc-'));
	roots.push(root);
	let generation = 1;
	const event = { sender: { id: 1 }, senderFrame: 'main', url: 'app://bundle/index.html' };
	const handlers = new Map<string, (event: DiagramRelinkEvent, payload: unknown) => Promise<unknown>>();
	// No fake PDF success: render fault injection is only used for negative lifecycle tests.
	const render = vi.fn(async (_svg: string, _signal: AbortSignal): Promise<{ pdf: Uint8Array; widthPx: number; heightPx: number }> => {
		throw new Error('RENDER_FAILED');
	});
	const native = registerDiagramNativeIpc({
		cpu,
		registrar: {
			handle: (channel, handler) => {
				handlers.set(channel, handler);
			}
		},
		render,
		authorize(input) {
			const actual = input as typeof event;
			if (actual.senderFrame !== 'main' || actual.url !== event.url) throw new Error('UNTRUSTED_SENDER');
			const captured = generation;
			return {
				root,
				generation,
				assertCurrent() {
					if (generation !== captured) throw new Error('STALE_WORKSPACE');
				}
			};
		}
	});
	const call = (channel: string, payload: unknown, sender = event) => handlers.get(`diagram:${channel}`)!(sender, payload);
	const saved = (await call('write', { relativePath: source, content: '<mxGraphModel/>' })) as { sha256: string };
	const request = { requestId: id, sourceRelPath: source, expectedSourceSha256: saved.sha256, svg };
	return {
		call,
		event,
		render,
		request,
		native,
		advance() {
			generation++;
			native.invalidate(1);
		}
	};
}
describe('native diagram exact payload and owner/generation integration', () => {
	it('cancels asynchronous vector preparation when the workspace owner changes', async () => {
		const f = await fixture();
		const work = f.call('prepare-drawio-vector', { xml: '<mxGraphModel><root><mxCell/></root></mxGraphModel>' });
		const assertion = expect(work).rejects.toThrow('RENDER_ABORTED');
		f.advance();
		await assertion;
		await expect(f.call('prepare-drawio-vector', { xml: '<mxGraphModel/>' })).resolves.toMatchObject({ xml: '<mxGraphModel/>' });
	});
	it('preserves worker validator errors as SVG_REJECTED before native rendering', async () => {
		const f = await fixture();
		expect(await f.call('render-pdf', { ...f.request, svg: svg.replace('<text>', '<script>') })).toEqual({
			ok: false,
			errorCode: 'SVG_REJECTED'
		});
		expect(f.render).not.toHaveBeenCalled();
	});
	it('uses realFS write/read/status without renderer workspace/output path', async () => {
		const f = await fixture();
		expect(await f.call('read', { relativePath: source })).toMatchObject({
			content: '<mxGraphModel/>',
			sha256: f.request.expectedSourceSha256
		});
		expect(await f.call('status', { relativePath: source })).toMatchObject({ state: 'stale', ready: false });
		await expect(f.call('write', { relativePath: source, content: 'x', root: '/evil' })).rejects.toThrow('INVALID_REQUEST');
		await expect(f.call('write', { relativePath: source.replace('.drawio', '.pdf'), content: 'x' })).rejects.toThrow('INVALID_PATH');
	});
	it('rejects wrong frame/URL, extra key/accessor/prototype/symbol before rendering', async () => {
		const f = await fixture();
		expect(await f.call('render-pdf', f.request, { ...f.event, senderFrame: 'iframe' })).toEqual({
			ok: false,
			errorCode: 'UNTRUSTED_SENDER'
		});
		for (const payload of [
			{ ...f.request, outputRelPath: 'assets/diagrams/else.pdf' },
			{
				...f.request,
				publicationUnlink: () => {
					throw new Error('renderer must never select FS adapter');
				}
			},
			{ ...f.request, [Symbol('hidden')]: 1 },
			Object.create(f.request),
			{
				...f.request,
				get svg() {
					throw new Error('getter must not run');
				}
			}
		]) {
			expect(await f.call('render-pdf', payload)).toEqual({ ok: false, errorCode: 'INVALID_REQUEST' });
		}
		expect(f.render).not.toHaveBeenCalled();
	});
	it('rejects source hash mismatch and forged request IDs', async () => {
		const f = await fixture();
		expect(await f.call('render-pdf', { ...f.request, expectedSourceSha256: '0'.repeat(64) })).toEqual({
			ok: false,
			errorCode: 'SOURCE_CHANGED'
		});
		expect(await f.call('render-pdf', { ...f.request, requestId: '../escape' })).toEqual({ ok: false, errorCode: 'INVALID_REQUEST' });
		expect(f.render).not.toHaveBeenCalled();
	});
	it('never exposes an internal indeterminate receipt or raw cause through IPC', async () => {
		const f = await fixture();
		// Negative boundary injection only: no fake successful PDF/publication.
		f.render.mockRejectedValueOnce(
			new DiagramPublicationIndeterminateError(
				{ v: 1, sourceSha256: f.request.expectedSourceSha256, svgSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64) },
				new Error('private/raw/marker/cause')
			)
		);
		expect(await f.call('render-pdf', f.request)).toEqual({ ok: false, errorCode: 'WRITE_FAILED' });
	});
	it('allows cancellation only for the same live owner; duplicates fail', async () => {
		const f = await fixture();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.render.mockImplementationOnce(async (_svg, signal) => {
			entered();
			await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('RENDER_ABORTED')), { once: true }));
			throw new Error('unreachable');
		});
		const work = f.call('render-pdf', f.request);
		await started;
		expect(await f.call('render-pdf', f.request)).toEqual({ ok: false, errorCode: 'REQUEST_ALREADY_RUNNING' });
		expect(await f.call('cancel-pdf', { requestId: id }, { ...f.event, sender: { id: 2 } })).toEqual({ cancelled: false });
		expect(await f.call('cancel-pdf', { requestId: id })).toEqual({ cancelled: true });
		expect(await work).toEqual({ ok: false, errorCode: 'RENDER_ABORTED' });
		expect(await f.call('render-pdf', f.request)).toEqual({ ok: false, errorCode: 'REQUEST_ALREADY_RUNNING' });
	});
	it('workspace generation change aborts render and preserves unpublished status', async () => {
		const f = await fixture();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.render.mockImplementationOnce(async (_svg, signal) => {
			entered();
			await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('RENDER_ABORTED')), { once: true }));
			throw new Error('unreachable');
		});
		const work = f.call('render-pdf', f.request);
		await started;
		f.advance();
		expect(await work).toEqual({ ok: false, errorCode: 'RENDER_ABORTED' });
		expect(await f.call('status', { relativePath: source })).toMatchObject({ ready: false });
	});
});
