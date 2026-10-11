import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const initial = '\\documentclass{article}\n\\begin{document}\nUnsaved close fixture.\n\\end{document}\n';
function bounded(promise, milliseconds, name) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ' timed out')), milliseconds); })]).finally(() => clearTimeout(timer));
}

test('native window close resolves dirty documents without losing cancelled drafts', { timeout: 120000 }, async (t) => {
	for (const action of ['unavailable-close-chunk', 'background-then-discard', 'cancel-then-discard', 'save', 'discard', 'failed-save-then-discard']) await t.test(action, async () => {
		const fixture = mkdtempSync(join(tmpdir(), 'modutex-close-'));
		assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
		const file = join(fixture, 'main.tex');
		writeFileSync(file, initial);
		writeFileSync(join(fixture, 'frontend-recent-v1.json'), JSON.stringify({ version: 1, entries: [{ id: randomUUID(), selected: file, kind: 'file', openedAt: Date.now() }] }));
		let desktop, browser, exited;
		try {
			browser = await electron.launch({ executablePath: require('electron'), args: ['.', '--disable-gpu'], cwd: repository, env: { ...process.env, MODUTEX_RENDERER: 'frontend-built', TEXPILE_USER_DATA: fixture } });
			desktop = browser.process();
			exited = new Promise((resolveExit) => desktop.once('exit', (code) => resolveExit(code)));
			const page = await browser.firstWindow();
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
			if (action === 'unavailable-close-chunk') await browser.evaluate(({ BrowserWindow }) => {
				globalThis.closeChunkAttempts = 0;
				BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest({ urls: ['app://frontend/*'] }, (details, callback) => {
					const blocked = /CloseDialog[^/]*\.js/.test(details.url);
					if (blocked) globalThis.closeChunkAttempts++;
					callback({ cancel: blocked });
				});
			});
			if (action === 'failed-save-then-discard') writeFileSync(file, 'Disk changed independently.');
			if (action === 'background-then-discard') await browser.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].minimize(); });
			// Request BrowserWindow.close in the main process, as native X does.
			// This covers the native lifecycle without pretending to click the OS titlebar.
			await browser.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
			const dialog = page.getByRole('dialog');
			await dialog.waitFor({ state: 'visible' });
			if (action === 'unavailable-close-chunk') assert.equal(await browser.evaluate(() => globalThis.closeChunkAttempts), 0, 'Closing must not request a dialog chunk');
			if (action === 'background-then-discard') await browser.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].restore(); });
			if (action === 'cancel-then-discard') {
				await dialog.getByRole('button', { name: /取消|Cancel/, exact: true }).click();
				await dialog.waitFor({ state: 'hidden' });
				assert.match(await editor.textContent(), /close draft/);
				assert.equal(readFileSync(file, 'utf8'), initial);
				assert.equal(page.isClosed(), false);
				assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), true);
				await browser.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
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
