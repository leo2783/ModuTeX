// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { realPdf } from '../helpers/pdf-fixture.mjs';

const repository = path.resolve(import.meta.dirname, '../../../..');
const frontend = path.join(repository, 'apps/frontend');
const component = path.resolve(repository, process.env.MODUTEX_PDF_COMPONENT ?? 'apps/frontend/src/features/pdf/PdfView.svelte');

test('real PDF viewport preserves forward/inverse points through crop, rotation, zoom and lifecycle', { timeout: 120_000 }, async t => {
	await readFile(component);
	const directory = await mkdtemp(path.join(frontend, '.pdf-synctex-e2e-'));
	let server, browser;
	t.after(async () => {
		await browser?.close();
		await server?.close();
		assert.equal(path.dirname(directory), frontend);
		assert.ok(path.basename(directory).startsWith('.pdf-synctex-e2e-'));
		await rm(directory, { recursive: true, force: true });
	});
	await writeFile(path.join(directory, 'Harness.svelte'), `<script>
import PdfView from ${JSON.stringify(component.replaceAll('\\', '/'))};
let active = $state(true), reveal = $state(undefined), bytes = $state(new Uint8Array(${JSON.stringify(realPdf())}));
const points = [], errors = [];
let renders = 0;
window.pdfHarness = {
 reveal(value) { reveal = value; }, active(value) { active = value; },
 reload() { bytes = new Uint8Array(bytes); },
 snapshot() { return { points: [...points], errors: [...errors], renders }; }
};
</script>
<div style="width:340px;height:300px"><PdfView {bytes} {active} {reveal} locale="en" onPoint={point => points.push(point)} onError={error => errors.push(error)} onPageCount={() => {}} onRendered={() => renders++} /></div>`);
	await writeFile(path.join(directory, 'main.js'), "import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness, { target: document.getElementById('app') });");
	await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
	server = await createServer({ root: directory, configFile: false, plugins: [svelte()], server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } }, logLevel: 'error' });
	await server.listen();
	const address = server.httpServer.address();
	assert.equal(typeof address, 'object');
	browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
	const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1.5 });
	const pageErrors = [];
	page.on('pageerror', error => pageErrors.push(error.message));
	await page.goto(`http://127.0.0.1:${address.port}`);
	await page.waitForFunction(() => window.pdfHarness?.snapshot().renders >= 1);
	await page.locator('select').selectOption('200');
	await page.waitForFunction(() => window.pdfHarness.snapshot().renders >= 2);

	for (const [index, pageNumber] of [1, 2].entries()) {
		const request = { page: pageNumber, x: 360, y: 440, requestId: index + 1 };
		const previousRenders = await page.evaluate(() => window.pdfHarness.snapshot().renders);
		await page.evaluate(value => window.pdfHarness.reveal(value), request);
		if (pageNumber === 2) await page.waitForFunction(before => window.pdfHarness.snapshot().renders > before, previousRenders);
		await page.waitForFunction(() => document.querySelector('.pdf-scroll').scrollTop > 0);
		const center = await page.locator('.pdf-scroll').evaluate(element => {
			const rect = element.getBoundingClientRect();
			return { x: rect.left + element.clientLeft + element.clientWidth / 2, y: rect.top + element.clientTop + element.clientHeight / 2 };
		});
		await page.mouse.click(center.x, center.y);
		const point = await page.evaluate(() => window.pdfHarness.snapshot().points.at(-1));
		assert.equal(point.page, pageNumber);
		assert.ok(Math.abs(point.x - request.x) <= 1, JSON.stringify(point));
		assert.ok(Math.abs(point.y - request.y) <= 1, JSON.stringify(point));
	}
	await page.evaluate(() => {
		const canvas = document.querySelector('canvas');
		canvas.style.width = `${canvas.clientWidth * 0.75}px`;
		canvas.style.height = `${canvas.clientHeight * 0.75}px`;
		window.pdfHarness.reveal({ page: 2, x: 300, y: 350, requestId: 3 });
	});
	await page.waitForTimeout(50);
	await page.locator('canvas').focus();
	await page.keyboard.press('Enter');
	const scaledPoint = await page.evaluate(() => window.pdfHarness.snapshot().points.at(-1));
	assert.equal(scaledPoint.page, 2);
	assert.ok(Math.abs(scaledPoint.x - 300) <= 1, JSON.stringify(scaledPoint));
	assert.ok(Math.abs(scaledPoint.y - 350) <= 1, JSON.stringify(scaledPoint));
	const beforeReplay = await page.evaluate(() => window.pdfHarness.snapshot());
	await page.evaluate(() => window.pdfHarness.reveal({ page: 1, x: 360, y: 440, requestId: 1 }));
	await page.waitForTimeout(100);
	assert.equal((await page.evaluate(() => window.pdfHarness.snapshot())).renders, beforeReplay.renders, 'older completed reveal cannot change pages');
	const beforeInvalid = await page.evaluate(() => window.pdfHarness.snapshot());
	await page.evaluate(() => window.pdfHarness.reveal({ page: 999, x: 0, y: 0, requestId: 4 }));
	await page.waitForTimeout(100);
	assert.equal((await page.evaluate(() => window.pdfHarness.snapshot())).renders, beforeInvalid.renders);
	await page.locator('canvas').focus();
	await page.keyboard.press('Enter');
	assert.equal((await page.evaluate(() => window.pdfHarness.snapshot())).points.length, beforeInvalid.points.length + 1);
	const beforeReload = await page.evaluate(() => {
		window.retainedPdfCanvas = document.querySelector('canvas');
		return window.pdfHarness.snapshot().renders;
	});
	await page.evaluate(() => window.pdfHarness.reload());
	await page.waitForFunction(before => window.pdfHarness.snapshot().renders > before, beforeReload);
	assert.equal(await page.locator('select').inputValue(), '200', 'PDF reload preserves zoom');
	assert.equal(await page.locator('input[type="number"]').inputValue(), '2', 'PDF reload preserves current page');
	assert.equal(await page.evaluate(() => document.querySelector('canvas') === window.retainedPdfCanvas), true, 'PDF reload retains the canvas');
	await page.evaluate(() => window.pdfHarness.active(false));
	await page.waitForTimeout(50);
	await page.keyboard.press('Enter');
	assert.equal((await page.evaluate(() => window.pdfHarness.snapshot())).points.length, beforeInvalid.points.length + 1);
	assert.deepEqual(await page.evaluate(() => window.pdfHarness.snapshot().errors), []);
	assert.deepEqual(pageErrors, []);
});
