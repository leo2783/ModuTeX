import assert from 'node:assert/strict';
import { cpus, totalmem, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const channel = process.env.MODUTEX_TEST_BROWSER_CHANNEL || 'chrome';
if (!['chrome', 'msedge'].includes(channel)) throw new Error('Unsupported browser channel');
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
	name: 'benchmark-page', configureServer(server) {
		server.middlewares.use('/benchmark', (_req, res) => {
			res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body><script type="module">import {measure} from "/tests/performance/visual-runtime.ts"; window.measure = measure;</script></body>');
		});
	}
}] });
let browser;
try {
	await server.listen(); const address = server.httpServer.address();
	assert.equal(typeof address, 'object');
	browser = await chromium.launch({ channel, headless: true, args: ['--disable-gpu'] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${address.port}/benchmark`);
	await page.waitForFunction(() => typeof window.measure === 'function');
	const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
	const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize').value; };
	const records = [];
	await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
	for (const cells of [100, 500, 2000]) {
		const before = await heap();
		const result = await page.evaluate(cells => window.measure(cells), cells);
		records.push({ ...result, disposedHeapBytes: await heap(), beforeHeapBytes: before });
	}
	assert.deepEqual(errors, []);
	const { profile } = await cdp.send('Profiler.stop');
	const samples = new Map();
	for (const id of profile.samples ?? []) samples.set(id, (samples.get(id) ?? 0) + 1);
	const cpuHotspots = profile.nodes.map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url,
		line: node.callFrame.lineNumber + 1, selfSamples: samples.get(node.id) ?? 0 })).sort((a, b) => b.selfSamples - a.selfSamples).slice(0, 20);
	console.log(JSON.stringify({ scope: 'Real Chrome VisualEditor synchronous source receipt + typing/selection/refresh; excludes App, Worker scheduling, IME and native Electron',
		machine: { node: process.version, platform: process.platform, os: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), browser: browser.version() },
		gate: 'Measurement only; no approved latency/heap threshold or leak claim', records, cpuHotspots }, null, 2));
} finally { await browser?.close(); await server.close(); }
