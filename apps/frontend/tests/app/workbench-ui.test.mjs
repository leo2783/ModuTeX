import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const screenshotRoot = fileURLToPath(new URL('../../../../.verification-artifacts/', import.meta.url));
const channel = process.env.MODUTEX_TEST_BROWSER_CHANNEL || 'chrome';
if (!['chrome', 'msedge'].includes(channel)) throw new Error('Unsupported browser channel');

test('actual frontend modes, math rendering and help layout', { timeout: 120000 }, async (t) => {
	const server = await createServer({ root: frontendRoot, server: { host: '127.0.0.1', port: 0, strictPort: false } });
	let browser;
	try {
		await server.listen();
		const address = server.httpServer.address();
		assert.equal(typeof address, 'object');
		browser = await chromium.launch({ channel, headless: true, args: ['--disable-gpu'] });
		const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: 'dark' });
		page.setDefaultTimeout(10000);
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto(`http://127.0.0.1:${address.port}/`);
		await page.getByRole('button', { name: '新文件', exact: true }).click();
		const sourceEditor = page.locator('.source-view .source .cm-content');
		await sourceEditor.waitFor({ state: 'visible' });
		await t.test('explicit modes are separated from icon format and insert tools', async () => {
			assert.deepEqual(await page.locator('.modes button').allTextContents(), ['原始碼', '視覺化']);
			assert.equal(await page.locator('.insert-bar .modes').count(), 0);
			for (const name of ['粗體', '斜體', '底線', '公式', '矩陣', '表格']) {
				const button = page.locator('.insert-bar').getByRole('button', { name, exact: true });
				assert.equal(await button.getAttribute('title'), name);
				assert.equal(await button.locator('svg').count(), 1);
			}
		});
		await t.test('visual equations and matrix use actual MathLive elements', async () => {
			await sourceEditor.click();
			await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\nAlpha paragraph.\n\n\\[\\frac{1}{2}\\]\n\n\\[\\left(\\begin{array}{cc}1 & 2 \\\\ 3 & 4\\end{array}\\right)\\]\n\nBeta paragraph.\n\\end{document}\n');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			await page.waitForFunction(() => document.querySelectorAll('.visual-math-content math-field').length === 2);
			const values = await page.locator('.visual-math-content math-field').evaluateAll((fields) => fields.map((field) => field.value));
			assert.match(values[0], /frac/);
			assert.match(values[1], /array/);
			await page.locator('.insert-bar').getByRole('button', { name: '公式', exact: true }).click();
			const mathField = page.locator('.math-input math-field');
			await mathField.waitFor({ state: 'visible' });
			assert.equal(await page.locator('.math-panel .formula textarea:visible').count(), 0);
			assert.equal(await page.locator('.math-input .input-error').count(), 0);
			await mathField.click();
			await page.waitForFunction(() => document.activeElement === document.querySelector('.math-input math-field'));
			await page.keyboard.type('x');
			await page.waitForFunction(() => document.querySelector('.math-input math-field')?.value.includes('x'));
			await page.locator('.math-panel').getByRole('button', { name: '取消', exact: true }).click();
			await page.screenshot({ path: screenshotRoot + 'workbench-ui-dark-20261011.png' });
		});
		await t.test('between-block insertion focuses a persistent editable paragraph and supports undo', async () => {
			const paragraphCount = await page.locator('.source-block').count();
			const inserter = page.locator('.visual-block-inserter').first();
			await inserter.getByRole('button', { name: '在此處插入內容', exact: true }).click();
			await inserter.getByRole('button', { name: '插入文字段落', exact: true }).click();
			await page.waitForFunction((before) => document.activeElement?.classList.contains('ProseMirror') && document.querySelectorAll('.source-block').length === before + 1, paragraphCount);
			await page.keyboard.type('New notebook cell.');
			await page.waitForFunction(() => Array.from(document.querySelectorAll('.source-block')).some((node) => node.textContent.includes('New notebook cell.') && !node.textContent.includes('Alpha paragraph.')));
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			const value = await sourceEditor.textContent();
			assert.match(value, /\\par\s*New notebook cell\./);
			assert.match(value, /Alpha paragraph\./);
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			await page.locator('.source-block').filter({ hasText: 'New notebook cell.' }).click();
			await page.keyboard.press('Control+z');
			await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent.includes('New notebook cell.'));
		});
		await t.test('matrix and table blocks insert and re-edit through the document controls', async () => {
			const matrixCount = await page.locator('.visual-math').count();
			let boundary = page.locator('.visual-block-inserter').last();
			await boundary.getByRole('button', { name: '在此處插入內容', exact: true }).click();
			await boundary.getByRole('button', { name: '插入矩陣', exact: true }).click();
			await page.locator('.matrix-grid input').first().fill('42');
			await page.waitForFunction(() => document.querySelector('.matrix-preview-host math-field')?.value.includes('42'));
			await page.locator('.math-panel').getByRole('button', { name: '插入', exact: true }).click();
			await page.waitForFunction((before) => document.querySelectorAll('.visual-math').length === before + 1, matrixCount);
			await page.waitForFunction((before) => document.querySelectorAll('.visual-math-content math-field').length === before + 1, matrixCount);
			assert.match(await page.locator('.visual-math-content math-field').last().evaluate((field) => field.value), /42/);
			boundary = page.locator('.visual-block-inserter').last();
			await boundary.getByRole('button', { name: '在此處插入內容', exact: true }).click();
			await boundary.getByRole('button', { name: '插入表格', exact: true }).click();
			await page.locator('.table-panel td input').first().fill('Notebook table');
			await page.locator('.table-panel').getByRole('button', { name: '插入', exact: true }).click();
			const table = page.locator('.visual-table').last();
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).waitFor({ state: 'visible' });
			await table.getByRole('button', { name: '編輯表格', exact: true }).click();
			await page.locator('.table-panel td input').first().fill('Revised notebook table');
			await page.locator('.table-panel').getByRole('button', { name: '套用', exact: true }).click();
			await table.getByRole('columnheader', { name: 'Revised notebook table', exact: true }).waitFor({ state: 'visible' });
			await table.getByRole('columnheader', { name: 'Revised notebook table', exact: true }).click();
			await page.keyboard.press('Control+z');
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).waitFor({ state: 'visible' });
			await page.screenshot({ path: screenshotRoot + 'workbench-blocks-dark-20261011.png' });
			await page.emulateMedia({ colorScheme: 'light' });
			await page.screenshot({ path: screenshotRoot + 'workbench-blocks-light-20261011.png' });
			await page.emulateMedia({ colorScheme: 'dark' });
		});
		await t.test('help topics are readable in both themes at desktop widths', async () => {
			await page.getByRole('link', { name: '說明', exact: true }).click();
			const topics = page.getByRole('navigation', { name: '說明分類' });
			await topics.waitFor({ state: 'visible' });
			for (const colorScheme of ['dark', 'light']) {
				await page.emulateMedia({ colorScheme });
				for (const width of [1280, 760]) {
					await page.setViewportSize({ width, height: 850 });
					const boxes = await topics.locator('a').evaluateAll((links) => links.map((link) => {
						const box = link.getBoundingClientRect();
						return { x: box.x, y: box.y, width: box.width, height: box.height };
					}));
					assert.ok(boxes.length > 2);
					assert.ok(boxes.every((box) => box.width >= 150 && box.height < 70));
					assert.ok(boxes.every((box, index) => index === 0 || box.y > boxes[index - 1].y));
					assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
				}
				await page.screenshot({ path: screenshotRoot + `help-ui-${colorScheme}-20261011.png` });
			}
		});
		assert.deepEqual(errors, []);
	} finally {
		await browser?.close();
		await server.close();
	}
});
