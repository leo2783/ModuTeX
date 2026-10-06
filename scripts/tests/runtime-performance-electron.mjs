// Opt-in, bounded diagnostic. Runs production CPU paths in the genuine Electron main process.
// No network sink, downloader, alternate PDF producer, or production instrumentation.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
assert.equal(process.versions.node, '24.19.0');
assert.equal(require('electron/package.json').version, '43.5.0');
const electronDirectory = path.dirname(require.resolve('electron/package.json'));
const binaryRelative = (await fs.readFile(path.join(electronDirectory, 'path.txt'), 'utf8')).trim();
assert.ok(!path.isAbsolute(binaryRelative) && !binaryRelative.includes('..'));
const electron = path.join(electronDirectory, 'dist', binaryRelative);
await fs.access(electron);
assert.equal((await fs.readFile(path.join(electronDirectory, 'dist/version'), 'utf8')).trim(), '43.5.0');
const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-runtime-bench-')));
let child, childDone, failure;
const compareOnly = process.argv.includes('--worker-comparison');
try {
	const payload = path.join(owned, 'payload');
	await fs.mkdir(payload);
	const producer = path.join(payload, 'production.cjs');
	await build({
		entryPoints: [path.join(root, 'electron/src/diagram-cpu-worker.ts')],
		outfile: path.join(payload, 'diagram-cpu-worker.js'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24'
	});
	await build({
		stdin: {
			resolveDir: root,
			contents: `export {prepareDrawioVectorSource} from './electron/src/drawio-vector-source.ts'; export {sanitizeDrawioLightSVG} from './electron/src/diagram-svg.ts'; export {renderDiagramSvgToPdf} from './electron/src/diagram-pdf.ts'; export {diagramCpu} from './electron/src/diagram-cpu.ts';`
		},
		outfile: producer,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24',
		external: ['electron']
	});
	// Real ASAR caller/worker resolution, with the worker inside the archive (no alternate path).
	const archive = path.join(owned, 'payload.asar');
	const { createPackage } = await import('@electron/asar');
	await createPackage(payload, archive);
	const entry = path.join(owned, 'entry.cjs');
	await build({
		stdin: {
			resolveDir: root,
			contents: `(${measure.toString()})(...${JSON.stringify([path.join(archive, 'production.cjs'), owned, compareOnly])}).catch(e=>{console.error(e);require('electron').app.exit(1)});`
		},
		outfile: entry,
		platform: 'node',
		format: 'cjs'
	});
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	child = spawn(electron, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	childDone = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code) => resolve(code));
	});
	let timer;
	const code = await Promise.race([
		childDone,
		new Promise((_resolve, reject) => {
			timer = setTimeout(() => {
				child.kill();
				reject(new Error('bounded benchmark exceeded 180 seconds'));
			}, 180_000);
		})
	]).finally(() => clearTimeout(timer));
	assert.equal(code, 0);
} catch (error) {
	failure = error;
} finally {
	try {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill();
			let cleanupTimer;
			await Promise.race([
				childDone,
				new Promise((_resolve, reject) => {
					cleanupTimer = setTimeout(() => reject(new Error(`Owned child did not exit; evidence retained at ${owned}`)), 5000);
				})
			]).finally(() => clearTimeout(cleanupTimer));
		}
		assert.ok(path.basename(owned).startsWith('modutex-runtime-bench-') && path.dirname(owned) === (await fs.realpath(os.tmpdir())));
		await fs.rm(owned, { recursive: true, force: true });
	} catch (cleanupError) {
		throw new AggregateError(failure ? [failure, cleanupError] : [cleanupError], 'Runtime benchmark cleanup failed');
	}
}
if (failure) throw failure;

async function measure(producer, owned, compareOnly) {
	const assert = require('node:assert/strict');
	const path = require('node:path');
	const { app, BrowserWindow } = require('electron');
	assert.equal(process.versions.electron, '43.5.0');
	const { prepareDrawioVectorSource, sanitizeDrawioLightSVG, renderDiagramSvgToPdf, diagramCpu } = require(producer);
	app.setPath('userData', path.join(owned, 'profile'));
	app.setPath('sessionData', path.join(owned, 'profile'));
	await app.whenReady();
	app.on('window-all-closed', () => {});
	const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
	console.log(
		JSON.stringify({ benchmark: 'runtime', electron: process.versions.electron, node: process.versions.node, platform: process.platform })
	);
	// Limits checked by production functions; legal source leaves headroom for convertToSvg output.
	const cell = `<mxCell value="${'x'.repeat(1800)}"/>`;
	const legal = `<mxGraphModel><root>${cell.repeat(5000)}</root></mxGraphModel>`;
	const highNodes = `<mxGraphModel><root>${'<mxCell/>'.repeat(100_000)}</root></mxGraphModel>`;
	const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><text x="0" y="20">${'x'.repeat(24 * 1024 * 1024)}</text></svg>`;
	const denseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160">${'<rect x="1" y="2" width="3" height="4" fill="#123456"/>'.repeat(19_990)}</svg>`;
	for (const [name, input, execute, expectedError] of [
		['drawio-legal-9MiB', legal, prepareDrawioVectorSource, false],
		['drawio-rejected-100k-nodes', highNodes, prepareDrawioVectorSource, true],
		['svg-legal-24MiB', largeSvg, sanitizeDrawioLightSVG, false],
		['svg-legal-19990-nodes', denseSvg, sanitizeDrawioLightSVG, false]
	]) {
		for (let iteration = 0; iteration < 3; iteration++) {
			await pause();
			const scheduled = performance.now();
			const lag = new Promise((resolve) => setTimeout(() => resolve(performance.now() - scheduled), 0));
			const start = performance.now();
			if (expectedError) assert.throws(() => execute(input), /INVALID_REQUEST/);
			else assert.ok(execute(input));
			const cpuMs = performance.now() - start;
			console.log(
				JSON.stringify({ benchmark: 'main-sync', name, iteration, bytes: Buffer.byteLength(input), cpuMs, timerDelayMs: await lag })
			);
		}
		if (compareOnly) {
			let heartbeats = 0,
				maxHeartbeatGap = 0,
				last = performance.now();
			const heartbeat = setInterval(() => {
				const now = performance.now();
				maxHeartbeatGap = Math.max(maxHeartbeatGap, now - last);
				last = now;
				heartbeats++;
			}, 5);
			const started = performance.now();
			try {
				const result = name.startsWith('drawio') ? diagramCpu.prepare(input) : diagramCpu.normalize(input);
				if (expectedError) await assert.rejects(result, /INVALID_REQUEST/);
				else assert.ok(await result);
			} finally {
				clearInterval(heartbeat);
			}
			console.log(
				JSON.stringify({
					benchmark: 'worker-comparison',
					name,
					bytes: Buffer.byteLength(input),
					elapsedMs: performance.now() - started,
					heartbeats,
					maxHeartbeatGapMs: maxHeartbeatGap,
					callerAndWorkerInAsar: true
				})
			);
		}
	}
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><text x="10" y="30">Repeated vector text</text><path d="M0 0 L100 100"/></svg>';
	let latestSession;
	let created = 0;
	const onWindow = (_event, win) => {
		created++;
		latestSession = win.webContents.session;
	};
	app.on('browser-window-created', onWindow);
	async function snapshot(iteration) {
		await pause();
		const memory = await process.getProcessMemoryInfo();
		const metrics = app.getAppMetrics();
		console.log(
			JSON.stringify({
				benchmark: 'pdf-native-lifecycle',
				iteration,
				created,
				liveWindows: BrowserWindow.getAllWindows().length,
				mainPrivateKiB: memory.private,
				mainResidentKiB: memory.residentSet,
				processes: metrics.map((item) => ({
					type: item.type,
					privateKiB: item.memory?.privateBytes,
					residentKiB: item.memory?.workingSetSize
				}))
			})
		);
	}
	await snapshot(0);
	const repetitions = compareOnly ? 1 : 30;
	for (let iteration = 1; iteration <= repetitions; iteration++) {
		const start = performance.now();
		const result = await renderDiagramSvgToPdf(svg, new AbortController().signal);
		assert.ok(result.pdf.byteLength > 0);
		assert.equal(BrowserWindow.getAllWindows().length, 0);
		assert.equal(await latestSession.protocol.isProtocolHandled('diagram-pdf'), false);
		assert.equal(latestSession.listenerCount('will-download'), 0);
		console.log(
			JSON.stringify({ benchmark: 'pdf-success', iteration, elapsedMs: performance.now() - start, pdfBytes: result.pdf.byteLength })
		);
		if (iteration % 5 === 0 || compareOnly) {
			const controller = new AbortController();
			const cancel = (_event, win) => win.webContents.once('did-start-loading', () => controller.abort());
			app.once('browser-window-created', cancel);
			await assert.rejects(renderDiagramSvgToPdf(svg, controller.signal), /RENDER_ABORTED/);
			assert.equal(BrowserWindow.getAllWindows().length, 0);
			assert.equal(await latestSession.protocol.isProtocolHandled('diagram-pdf'), false);
			assert.equal(latestSession.listenerCount('will-download'), 0);
			await snapshot(iteration);
		}
	}
	app.removeListener('browser-window-created', onWindow);
	await diagramCpu.close();
	console.log(
		JSON.stringify({
			benchmark: 'pdf-native-lifecycle',
			verdict: compareOnly
				? 'ASAR production caller/worker: 1 real PDF and 1 native-load abort; cleanup passed'
				: '30 real PDFs and 6 native-load aborts; no live windows/protocol/download listeners; memory observations are diagnostic, not leak-proof'
		})
	);
	app.exit(0);
}
