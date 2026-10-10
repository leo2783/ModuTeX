import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const initial = '\\documentclass{article}\n\\begin{document}\nUnsaved close fixture.\n\\end{document}\n';
function bounded(promise, milliseconds, name) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ' timed out')), milliseconds); })]).finally(() => clearTimeout(timer));
}

test('native window close resolves dirty documents without losing cancelled drafts', { timeout: 120000 }, async (t) => {
	for (const action of ['cancel-then-discard', 'save', 'discard', 'failed-save-then-discard']) await t.test(action, async () => {
		const fixture = mkdtempSync(join(tmpdir(), 'modutex-close-'));
		assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
		const file = join(fixture, 'main.tex');
		writeFileSync(file, initial);
		writeFileSync(join(fixture, 'frontend-recent-v1.json'), JSON.stringify({ version: 1, entries: [{ id: randomUUID(), selected: file, kind: 'file', openedAt: Date.now() }] }));
		let desktop, browser, exited;
		try {
			desktop = spawn(require('electron'), ['.', '--disable-gpu', '--remote-debugging-port=0'], { cwd: repository, windowsHide: true, env: { ...process.env, MODUTEX_RENDERER: 'frontend-built', TEXPILE_USER_DATA: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
			exited = new Promise((resolveExit) => desktop.once('exit', (code) => resolveExit(code)));
			const endpoint = await bounded(new Promise((resolveEndpoint, reject) => {
				let output = '';
				desktop.once('error', reject);
				desktop.once('exit', (code) => reject(new Error('Electron exited before CDP: ' + code)));
				for (const stream of [desktop.stdout, desktop.stderr]) stream.on('data', (chunk) => { output += chunk.toString(); const found = output.match(/DevTools listening on (ws:\/\/\S+)/); if (found) resolveEndpoint(found[1]); });
			}), 25000, 'native startup');
			browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
			const context = browser.contexts()[0];
			const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 });
			page.setDefaultTimeout(10000);
			// Electron cancels dirty beforeunload itself. Its transient CDP event is
			// not a browser prompt that Playwright can accept/dismiss.
			page.on('dialog', (prompt) => { assert.equal(prompt.type(), 'beforeunload'); });
			await page.waitForURL('app://frontend/index.html');
			await page.getByRole('button', { name: /開啟.*main.tex|Open.*main.tex/ }).click();
			await page.getByRole('button', { name: /原始碼|Source/, exact: true }).click();
			const editor = page.locator('.source-view .source .cm-content');
			await editor.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText('% close draft');
			if (action === 'failed-save-then-discard') writeFileSync(file, 'Disk changed independently.');
			// Renderer window.close requests the actual Electron window close path,
			// including beforeunload. This is not OS titlebar click automation.
			await page.evaluate(() => { window.close(); });
			const dialog = page.getByRole('dialog');
			await dialog.waitFor({ state: 'visible' });
			if (action === 'cancel-then-discard') {
				await dialog.getByRole('button', { name: /取消|Cancel/, exact: true }).click();
				await dialog.waitFor({ state: 'hidden' });
				assert.match(await editor.textContent(), /close draft/);
				assert.equal(readFileSync(file, 'utf8'), initial);
				assert.equal(page.isClosed(), false);
				assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), true);
				await page.evaluate(() => { window.close(); });
				await dialog.waitFor({ state: 'visible' });
			}
			if (action === 'failed-save-then-discard') {
				await dialog.getByRole('button', { name: /儲存後關閉|Save and close/ }).click();
				await dialog.getByRole('alert').waitFor({ state: 'visible' });
				assert.match(await editor.textContent(), /close draft/);
				assert.equal(page.isClosed(), false);
				assert.equal(readFileSync(file, 'utf8'), 'Disk changed independently.');
			}
			await dialog.getByRole('button', { name: action === 'save' ? /儲存後關閉|Save and close/ : /捨棄.*關閉|Discard.*close/ }).click();
			assert.equal(await bounded(exited, 10000, 'confirmed native close'), 0);
			assert.equal(readFileSync(file, 'utf8'), action === 'save' ? initial + '% close draft' : action === 'failed-save-then-discard' ? 'Disk changed independently.' : initial);
		} finally {
			if (desktop && desktop.exitCode === null && desktop.signalCode === null) { desktop.kill(); await bounded(exited, 5000, 'owned process cleanup'); }
			if (browser) await bounded(browser.close(), 5000, 'CDP disconnect');
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});
