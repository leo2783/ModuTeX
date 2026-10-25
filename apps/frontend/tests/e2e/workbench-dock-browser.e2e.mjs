// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../../../..');
const frontend = path.join(root, 'apps/frontend');

test('bottom dock uses one scroll region and preserves its session across real pointer and tab actions', { timeout: 90000 }, async t => {
    const directory = await mkdtemp(path.join(frontend, '.dock-browser-'));
    let server, browser;
    t.after(async () => {
        await browser?.close();
        await server?.close();
        assert.equal(path.dirname(directory), frontend);
        assert(path.basename(directory).startsWith('.dock-browser-'));
        await rm(directory, { recursive: true, force: true });
    });
    const component = path.join(frontend, 'src/components/WorkbenchDock.svelte').replaceAll('\\', '/');
    const terminalView = path.join(frontend, 'src/features/terminal/xterm-view.ts').replaceAll('\\', '/');
    const baseStyles = path.join(frontend, 'src/styles/base.css').replaceAll('\\', '/');
    await writeFile(path.join(directory, 'Harness.svelte'), `<script>
import WorkbenchDock from ${JSON.stringify(component)};
import { createXtermView } from ${JSON.stringify(terminalView)};
let activeTab = $state(null);
const evidence = window.dockEvidence = { starts: 0, closes: 0, disposes: 0, fits: 0, resizes: 0 };
const controller = { availability: async () => ({ available: true, reason: '', detail: '' }),
 start: async () => { evidence.starts++; }, send: () => true,
 resize: () => { evidence.resizes++; return true; }, close: async () => { evidence.closes++; } };
const sessionFactory = async (_owner, callbacks) => { window.dockCallbacks = callbacks; return controller; };
const viewFactory = async (host, handlers) => {
 const view = createXtermView(host, handlers);
 window.dockTerminalSize = () => view.size();
 return { ...view, fit: () => { evidence.fits++; view.fit(); },
  dispose: () => { evidence.disposes++; view.dispose(); } };
};
const diagnostics = Array.from({length: 100}, (_, i) => ({ severity: 'error', message: 'Problem ' + i,
 path: 'main.tex', line: i + 1, column: 1 }));
</script>
<div class="shell"><div class="editor">Document</div><WorkbenchDock locale="en" workspaceId="ws-test"
 bind:activeTab {diagnostics} compileLog={'Output line\\n'.repeat(300)}
 terminalSessionFactory={sessionFactory} terminalViewFactory={viewFactory} /></div>
<style>:global(html),:global(body){margin:0;height:100%;overflow:hidden}.shell{height:100dvh;display:flex;flex-direction:column;min-height:0}.editor{flex:1;min-height:0}</style>`);
    await writeFile(path.join(directory, 'main.js'), `import {mount} from 'svelte';import ${JSON.stringify(baseStyles)};import Harness from './Harness.svelte';mount(Harness,{target:document.getElementById('app')});`);
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
    server = await createServer({ root: directory, configFile: false, plugins: [svelte()],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, logLevel: 'error' });
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.getByRole('tab', { name: /^Problems/ }).click();
    const dock = page.locator('.workbench-dock');
    const before = await dock.boundingBox();
    const separator = page.getByRole('separator', { name: 'Resize bottom panel height' });
    const handle = await separator.boundingBox();
    assert(handle && handle.height >= 6, 'resize handle must have a real pointer target');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 70, { steps: 6 });
    await page.mouse.up();
    assert((await dock.boundingBox()).height > before.height + 40, 'real pointer drag must resize the dock');
    for (const width of [1280, 800]) {
        await page.setViewportSize({ width, height: 720 });
        const scrollOwners = await dock.evaluate(element => [...element.querySelectorAll('*')].filter(node => {
            const style = getComputedStyle(node);
            return node.getClientRects().length && /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
        }).map(node => node.id));
        assert.deepEqual(scrollOwners, ['workbench-dock-body']);
        assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
    }
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: /Start terminal/ }).click();
    await page.waitForFunction(() => dockEvidence.starts === 1);
    await page.evaluate(async () => {
        await window.dockCallbacks.onOutput(new TextEncoder().encode('X'.repeat(2000) + '\r\n' + 'Terminal history\r\n'.repeat(100)));
    });
    let previousColumns = await page.evaluate(() => window.dockTerminalSize().cols);
    for (const width of [640, 480]) {
        await page.setViewportSize({ width, height: 720 });
        await page.waitForFunction(previous => window.dockTerminalSize().cols < previous, previousColumns);
        previousColumns = await page.evaluate(() => window.dockTerminalSize().cols);
        const widths = await dock.evaluate(element => [element, ...element.querySelectorAll('.workbench-dock-body, .terminal-panel-content, .terminal-toolbar, .terminal-panel, .terminal-host')].map(node => ({ name: node.className, scroll: node.scrollWidth, client: node.clientWidth })));
        assert(widths.every(value => value.scroll <= value.client + 1), JSON.stringify(widths));
        await page.locator('.terminal-host').hover();
        await page.mouse.wheel(400, 0);
        assert.equal(await page.locator('.workbench-dock-body').evaluate(element => element.scrollLeft), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.getByRole('tab', { name: /^Problems/ }).click();
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    assert.equal(await page.locator('.workbench-dock-body').isVisible(), false);
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.waitForFunction(() => dockEvidence.fits > 0 && dockEvidence.resizes > 0);
    const state = await page.evaluate(() => dockEvidence);
    assert.equal(state.starts, 1);
    assert.equal(state.closes, 0);
    assert.equal(state.disposes, 0);
    await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Home');
    assert.equal(await page.getByRole('tab', { name: /^Problems/ }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: /^Problems/ }).press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Output', exact: true }).getAttribute('aria-selected'), 'true');
    assert.deepEqual(errors, []);
});
