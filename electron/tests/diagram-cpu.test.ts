import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { DiagramCpu } from '../src/diagram-cpu';
import { prepareDrawioVectorSource } from '../src/drawio-vector-source';
import { sanitizeDrawioLightSVG, sanitizeValidatedSVG } from '../src/diagram-svg';

let owned: string;
let artifact: string;
beforeAll(async () => {
	owned = await mkdtemp(join(tmpdir(), 'modutex-cpu-test-'));
	artifact = join(owned, 'diagram-cpu-worker.js');
	await build({
		entryPoints: [resolve('electron/src/diagram-cpu-worker.ts')],
		outfile: artifact,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24'
	});
});
afterAll(async () => {
	await rm(owned, { recursive: true, force: true });
});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>中文</text></svg>';
describe('dedicated bounded production diagram CPU workers', () => {
	it('uses the unchanged validators and genuinely returns their exact output', async () => {
		const cpu = new DiagramCpu(artifact);
		try {
			const xml = '<mxGraphModel><root><mxCell value="中文"/></root></mxGraphModel>';
			expect(await cpu.prepare(xml)).toEqual(prepareDrawioVectorSource(xml));
			expect(await cpu.normalize(svg)).toEqual(sanitizeDrawioLightSVG(svg));
			expect(await cpu.validate(svg)).toEqual(sanitizeValidatedSVG(svg));
			await expect(cpu.normalize(svg.replace('<text>', '<script>'))).rejects.toThrow('INVALID_SVG');
			await expect(cpu.prepare('<!DOCTYPE mxfile><mxfile/>')).rejects.toThrow('INVALID_REQUEST');
		} finally {
			await cpu.close();
		}
	});
	it('rejects already aborted and missing worker artifacts without returning a validation receipt', async () => {
		const controller = new AbortController();
		controller.abort();
		const cpu = new DiagramCpu(join(owned, 'absent.js'));
		try {
			await expect(cpu.validate(svg, controller.signal)).rejects.toThrow('RENDER_ABORTED');
			await expect(cpu.validate(svg)).rejects.toThrow('RENDER_FAILED');
		} finally {
			await cpu.close();
		}
	});
	it('terminates hung active/queued work and rejects overflow, timeout, error and bad responses', async () => {
		const fault = resolve('electron/tests/fixtures/diagram-cpu-fault.cjs');
		const cpu = new DiagramCpu(fault, 200);
		const active = Array.from({ length: 6 }, () => cpu.prepare('hang'));
		const assertions = active.map((work) => expect(work).rejects.toThrow('RENDER_TIMEOUT'));
		await expect(cpu.prepare('overflow')).rejects.toThrow('REQUEST_ALREADY_RUNNING');
		await Promise.all(assertions);
		await cpu.close();
		for (const input of ['error', 'exit', 'bad']) {
			const faults = new DiagramCpu(fault);
			try {
				await expect(faults.prepare(input)).rejects.toThrow('RENDER_FAILED');
			} finally {
				await faults.close();
			}
		}
		const malformed = new DiagramCpu(fault);
		try {
			await expect(malformed.validate('bad-size')).rejects.toThrow('RENDER_FAILED');
		} finally {
			await malformed.close();
		}
	});
	it('shutdown cancels all owned work and prevents later work', async () => {
		const cpu = new DiagramCpu(resolve('electron/tests/fixtures/diagram-cpu-fault.cjs'));
		const work = cpu.prepare('hang');
		const assertion = expect(work).rejects.toThrow('RENDER_ABORTED');
		await cpu.close();
		await assertion;
		await expect(cpu.validate(svg)).rejects.toThrow('RENDER_ABORTED');
	});
	it('aborts active and queued work without later dispatch or blocking a valid replacement', async () => {
		const cpu = new DiagramCpu(resolve('electron/tests/fixtures/diagram-cpu-fault.cjs'));
		const controllers = Array.from({ length: 3 }, () => new AbortController());
		const assertions = controllers.map((controller) => expect(cpu.prepare('hang', controller.signal)).rejects.toThrow('RENDER_ABORTED'));
		controllers.forEach((controller) => controller.abort());
		await Promise.all(assertions);
		await expect(cpu.prepare('bad')).rejects.toThrow('RENDER_FAILED');
		await cpu.close();
	});
});
