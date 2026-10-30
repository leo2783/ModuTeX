// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const frontend = resolve(process.env.MODUTEX_MCP_FRONTEND_ROOT ?? join(repository, 'apps/frontend'));
const modulePath = value => value.replaceAll('\\', '/');

test('real MCP editor methods preserve UTF-16 selection, mode, atomic undo and lifetime guards', { timeout: 90_000 }, async () => {
	const fixture = await mkdtemp(join(repository, '.verification-artifacts', 'mcp-editor-'));
	let server, browser, page;
	const errors = [], consoleErrors = [];
	try {
		const core = process.env.MODUTEX_MCP_TEST_CORE ?? modulePath(join(frontend, 'src/features/document-core/core.ts'));
		await writeFile(join(fixture, 'Harness.svelte'), `<script>
import SourceView from ${JSON.stringify(modulePath(join(frontend, 'src/features/source-editor/SourceView.svelte')))};
import { SourceDocument } from ${JSON.stringify(core)};
import { EditorView } from '@codemirror/view';
import { historyTransaction } from ${JSON.stringify(modulePath(join(frontend, 'src/features/source-editor/state.ts')))};
let source = $state.raw(SourceDocument.open(new TextEncoder().encode('\\ufeffA𠀀\\r\\nB\\rC\\n')));
let active = $state(true), saving = $state(false), view;
export function snapshot() { return { id: source.documentId, version: source.version, text: source.read(), bytes: Array.from(source.toBytes()) }; }
export function call(name, ...args) { return view[name](...args); }
export function api() { return view; }
export function activity(value) { active = value; }
export function select(anchor, head) { EditorView.findFromDOM(globalThis.document.querySelector('.cm-editor')).dispatch({ selection: { anchor, head } }); }
export function undo() { const editor = EditorView.findFromDOM(globalThis.document.querySelector('.cm-editor')); const transaction = historyTransaction(editor.state, 'undo'); if (!transaction) throw new Error('Missing undo transaction'); editor.dispatch(transaction); }
</script>
<SourceView bind:this={view} document={source} label="main.tex" {active} {saving} savedVersion={null} onChange={(next) => source = next} onRejected={() => { throw new Error('Rejected edit'); }} onVisualRejected={() => { throw new Error('Rejected visual edit'); }} onProjection={() => {}} onParserFailure={() => {}} />`);
		await writeFile(join(fixture, 'entry.js'), `import { mount, unmount, flushSync, tick } from 'svelte'; import Harness from './Harness.svelte'; const host = mount(Harness, {target: document.getElementById('app')}); window.testHost = host; window.testTick = async () => { flushSync(); await tick(); flushSync(); }; window.testUnmount = () => unmount(host);`);
		await writeFile(join(fixture, 'index.html'), '<!doctype html><html><body><main id="app" style="height:700px"></main><script type="module" src="./entry.js"></script></body></html>');
		server = await createServer({ root: frontend, configFile: false, plugins: [svelte()], worker: { format: 'es' }, cacheDir: join(repository, 'node_modules/.vite/mcp-editor'), server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } }, logLevel: 'error' });
		await server.listen();
		browser = await chromium.launch({ channel: 'msedge', headless: true });
		page = await browser.newPage();
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 700)); });
		await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${modulePath(join(fixture, 'index.html'))}`);
		await page.waitForFunction(() => window.testHost && document.querySelector('.cm-editor'));
		const original = await page.evaluate(() => window.testHost.snapshot());
		await page.evaluate(async () => { const s = window.testHost.snapshot(); if (!window.testHost.call('setEditorViewMode', 'source', s.id, s.version)) throw new Error('Mode change rejected'); await window.testTick(); window.testHost.select(0, 5); });
		const selection = await page.evaluate(() => { const s = window.testHost.snapshot(); return window.testHost.call('getEditorSelection', s.id, s.version); });
		assert.deepEqual(selection.cursor, { line: 2, column: 2 });
		assert.deepEqual(selection.selection, { start: { line: 1, column: 1 }, end: { line: 2, column: 2 } });
		assert.equal(await page.getByRole('button', { name: '原始碼', exact: true }).getAttribute('aria-pressed'), 'true');
		assert.equal(await page.evaluate(() => { const s = window.testHost.snapshot(); return window.testHost.call('getEditorSelection', s.id, s.version + 1); }), null);
		const replacement = 'X𠀀\r\nY\rZ\n';
		assert.equal(await page.evaluate(async ({ original, replacement }) => { const accepted = window.testHost.call('applyAtomicSourcePatch', original.id, original.version, { from: 0, to: original.text.length, insert: replacement, expected: original.text }); await window.testTick(); return accepted; }, { original, replacement }), true);
		assert.equal((await page.evaluate(() => window.testHost.snapshot())).text, replacement);
		await page.evaluate(async () => { window.testHost.undo(); await window.testTick(); });
		assert.deepEqual((await page.evaluate(() => window.testHost.snapshot())).bytes, original.bytes);
		await page.evaluate(async () => { window.testHost.activity(false); await window.testTick(); });
		assert.equal(await page.evaluate(() => { const s = window.testHost.snapshot(); return window.testHost.call('setEditorViewMode', 'visual', s.id, s.version); }), false);
		await page.evaluate(async () => { window.savedMcpState = window.testHost.snapshot(); window.savedMcpApi = window.testHost.api(); await window.testUnmount(); });
		assert.equal(await page.evaluate(() => { const s = window.savedMcpState; return window.savedMcpApi.getEditorSelection(s.id, s.version); }), null);
		assert.deepEqual(errors, []);
	} catch (cause) {
		throw new Error(JSON.stringify({ errors, consoleErrors }), { cause });
	} finally {
		await browser?.close();
		await server?.close();
		const owned = relative(join(repository, '.verification-artifacts'), fixture);
		assert(owned.startsWith('mcp-editor-') && !owned.includes(sep) && !owned.includes('..'));
		await rm(fixture, { recursive: true, force: true });
	}
});
