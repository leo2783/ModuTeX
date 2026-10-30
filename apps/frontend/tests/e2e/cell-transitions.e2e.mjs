import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const frontend = path.join(repository, 'apps/frontend');
const modulePath = value => value.replaceAll('\\', '/');
const sourceText = '\uFEFF\\documentclass{article}\r\n\\begin{document}\r\n\\par\r\n\\section{Neighbor}\r\n\\end{document}\r\n';

test('real browser preserves Unicode through structures, inserts one cell above H2 and bounds abstract height', { timeout: 90_000 }, async () => {
	const artifacts = path.join(repository, '.verification-artifacts');
	await mkdir(artifacts, { recursive: true });
	const fixture = await mkdtemp(path.join(artifacts, 'cell-transitions-'));
	let server, browser;
	const errors = [];
	const measurements = [];
	try {
		await writeFile(path.join(fixture, 'Harness.svelte'), `<script>
import SourceView from ${JSON.stringify(modulePath(path.join(frontend, 'src/features/source-editor/SourceView.svelte')))};
import { SourceDocument } from ${JSON.stringify(modulePath(path.join(frontend, 'src/features/document-core/core.ts')))};
import ${JSON.stringify(modulePath(path.join(frontend, 'src/styles/base.css')))};
let source = $state.raw(SourceDocument.open(new TextEncoder().encode(${JSON.stringify(sourceText)})));
export function snapshot() { return { text: source.read(), bytes: Array.from(source.toBytes()) }; }
</script>
<div style="height:700px"><SourceView document={source} label="main.tex" saving={false} savedVersion={null}
onChange={next => source = next} onRejected={() => { throw Error('Source rejected'); }}
onVisualRejected={() => { throw Error('Visual rejected'); }} onProjection={() => {}}
onParserFailure={() => { throw Error('Parser failed'); }} /></div>`);
		await writeFile(path.join(fixture, 'entry.js'), "import { mount } from 'svelte'; import Harness from './Harness.svelte'; window.testHost = mount(Harness, { target: document.getElementById('app') });");
		await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><body><main id="app"></main><script type="module" src="./entry.js"></script></body></html>');
		server = await createServer({ root: frontend, configFile: false, plugins: [svelte()], worker: { format: 'es' }, cacheDir: path.join(repository, 'node_modules/.vite/cell-transitions'), server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } }, logLevel: 'error' });
		await server.listen();
		browser = await chromium.launch({ channel: 'msedge', headless: true });
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${modulePath(path.join(fixture, 'index.html'))}`);
		const cells = page.locator('.ProseMirror > .notebook-cell');
		await cells.first().waitFor();
		const choose = async kind => {
			await page.getByRole('group', { name: '文字格式' }).getByLabel('文字層級').click();
			await page.locator(`[data-structure="${kind}"]`).click();
			await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
		};
		const original = await page.evaluate(() => window.testHost.snapshot());
		const text = '摘要𠀀 e\u0301 ' + String.fromCodePoint(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb) + ' العربية';
		await cells.first().click();
		await page.keyboard.insertText(text);
		for (const kind of ['abstract', 'title', 'paragraph', 'title', 'abstract', 'subsection']) {
			await choose(kind);
			assert.equal(await cells.count(), 2);
			assert.equal(await cells.first().textContent(), text);
			assert.equal(await cells.last().textContent(), 'Neighbor');
			assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true, `${kind} must restore editor focus`);
		}
		await page.locator('.cell-actions-bar button[title="在上方插入"]').click();
		await page.locator('.cell-insert-wrap.open').getByRole('button', { name: '文字', exact: true }).click();
		await page.waitForFunction(() => document.querySelectorAll('.ProseMirror > .notebook-cell').length === 3);
		assert.equal(await cells.first().textContent(), '');
		assert.equal(await cells.nth(1).textContent(), text);
		await page.keyboard.insertText('上方新格𮯰');
		await page.waitForFunction(() => window.testHost.snapshot().text.includes('上方新格𮯰'));
		assert.equal(await cells.first().textContent(), '上方新格𮯰');
		await page.keyboard.press('Control+z');
		await page.waitForFunction(() => !window.testHost.snapshot().text.includes('上方新格𮯰'));
		await page.locator('.ProseMirror[contenteditable="true"]:focus').waitFor();
		await page.keyboard.press('Control+z');
		await page.waitForFunction(() => document.querySelectorAll('.ProseMirror > .notebook-cell').length === 2);
		await page.locator('.ProseMirror[contenteditable="true"]:focus').waitFor();
		await cells.first().click(); await choose('abstract');
		for (const width of [1280, 640]) {
			await page.setViewportSize({ width, height: 800 });
			const size = await cells.first().evaluate(el => ({ text: el.textContent, height: el.getBoundingClientRect().height,
				lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight), overflow: el.scrollWidth > el.clientWidth }));
			assert.equal(size.text, text);
			assert.equal(size.overflow, false);
			assert.ok(size.height <= 2 * size.lineHeight + 32, `single-line abstract must not contain syntax-only blank rows: ${JSON.stringify(size)}`);
			measurements.push({ width, ...size });
			await page.screenshot({ path: path.join(artifacts, `cell-transition-abstract-${width}.png`) });
		}
		const stable = await page.evaluate(() => window.testHost.snapshot());
		await page.getByRole('button', { name: '取消編輯', exact: true }).click();
		assert.deepEqual((await page.evaluate(() => window.testHost.snapshot())).bytes, stable.bytes);
		await page.getByRole('button', { name: '原始碼', exact: true }).click();
		await page.getByRole('button', { name: '視覺化', exact: true }).click();
		assert.deepEqual((await page.evaluate(() => window.testHost.snapshot())).bytes, stable.bytes);
		assert.notDeepEqual(stable.bytes, original.bytes);
		assert.deepEqual(errors, []);
		await writeFile(path.join(artifacts, 'cell-transition-browser.json'), JSON.stringify({ measurements, errors }, null, 2));
	} finally {
		await browser?.close(); await server?.close();
		const owned = path.relative(artifacts, fixture);
		assert.ok(owned.startsWith('cell-transitions-') && !owned.includes(path.sep) && !owned.includes('..'));
		await rm(fixture, { recursive: true, force: true });
	}
});
