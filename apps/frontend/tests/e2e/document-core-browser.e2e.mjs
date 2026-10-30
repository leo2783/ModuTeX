// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../dist-tauri/', import.meta.url));
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };

test('production CSP permits real Rust WASM, parser worker edits, outline updates and undo', { timeout: 90_000 }, async () => {
	const server = createServer(async (request, response) => {
		try {
			const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
			const filename = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
			if (!filename.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
			const bytes = await readFile(filename);
			response.writeHead(200, { 'Content-Type': contentTypes[extname(filename)] ?? 'application/octet-stream' }).end(bytes);
		} catch { response.writeHead(404).end(); }
	});
	await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
	let browser;
	let page;
	const failures = [], violations = [], wasmResponses = [], consoleErrors = [], workerErrors = [];
	try {
		const channel = process.env.MODUTEX_TEST_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
		if (channel && !['msedge', 'chrome'].includes(channel)) throw new Error('Unsupported browser channel');
		browser = await chromium.launch({ channel, headless: true });
		page = await browser.newPage();
		page.on('pageerror', error => failures.push(error.message));
		page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
		page.on('response', response => { if (new URL(response.url()).pathname.endsWith('.wasm')) wasmResponses.push(response); });
		await page.exposeFunction('recordCspViolation', message => violations.push(message));
		await page.exposeFunction('recordWorkerError', message => workerErrors.push(message));
		await page.addInitScript(() => {
			const NativeWorker = window.Worker;
			window.Worker = class extends NativeWorker {
				constructor(...args) { super(...args); this.addEventListener('error', event => { void window.recordWorkerError(event.message); }); }
			};
		});
		await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => { void window.recordCspViolation(event.violatedDirective + ': ' + event.blockedURI); }));
		await page.goto(`http://127.0.0.1:${server.address().port}/`);
		await page.getByRole('button', { name: /^(新文件|New document)$/ }).click();
		await page.getByRole('button', { name: /^(原始碼|Source)$/ }).click();
		const editor = page.locator('.cm-content');
		await editor.waitFor({ state: 'visible' });
		await editor.click();
		await page.keyboard.press('Control+End');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Home');
		const inserted = '\n\\section{Rust worker 中文𠀀}\n';
		await page.keyboard.insertText(inserted);
		const heading = page.locator('.outline-row', { hasText: 'Rust worker 中文𠀀' });
		await heading.waitFor({ state: 'visible' });
		assert.ok((await editor.textContent()).includes('Rust worker 中文𠀀'));
		await page.keyboard.press('Control+z');
		await heading.waitFor({ state: 'detached' });
		assert.equal((await editor.textContent()).includes('Rust worker 中文𠀀'), false);
		assert.ok(wasmResponses.length > 0, 'Production application must fetch a real WASM asset');
		for (const response of wasmResponses) {
			assert.equal(response.status(), 200);
			assert.equal(response.headers()['content-type'], 'application/wasm');
			assert.deepEqual((await response.body()).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
		}
		assert.deepEqual(violations, []);
		assert.deepEqual(failures, []);
		assert.deepEqual(workerErrors, []);
	} catch (cause) {
		const outline = await page?.locator('.outline-section').textContent().catch(() => null);
		const alerts = await page?.locator('[role="alert"]').allTextContents().catch(() => []);
		throw new Error(JSON.stringify({ failures, violations, consoleErrors, workerErrors, outline, alerts }), { cause });
	} finally {
		await browser?.close();
		await new Promise(done => server.close(done));
	}
});
