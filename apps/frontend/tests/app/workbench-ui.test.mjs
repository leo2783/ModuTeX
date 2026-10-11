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
	const server = await createServer({ root: frontendRoot, cacheDir: screenshotRoot + 'vite-workbench-ui', server: { host: '127.0.0.1', port: 0, strictPort: false } });
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
		assert.equal(await page.getByRole('button', { name: '視覺化', exact: true }).getAttribute('aria-pressed'), 'true');
		assert.equal(await page.locator('.editor-pane > .editor-bar').count(), 0);
		await page.getByRole('button', { name: '原始碼', exact: true }).click();
		await sourceEditor.waitFor({ state: 'visible' });
		await t.test('visual-first icons share one toolbar with format and cell tools', async () => {
			assert.deepEqual(await page.locator('.modes button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['視覺化', '原始碼']);
			assert.equal(await page.locator('.insert-bar .modes').count(), 1);
			for (const name of ['粗體', '斜體', '底線', '數學', '文字顏色', '表格', '程式碼區塊']) {
				const button = ['數學', '文字顏色'].includes(name) ? page.locator('summary[aria-label="'+name+'"]') : page.locator('.insert-bar').getByRole('button', { name, exact: true });
				assert.equal(await button.getAttribute('title'), name);
				assert.equal(await button.locator('svg').count(), name === '數學' ? 2 : 1);
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
			assert.match(values[1], /pmatrix/);
			await page.locator('.visual-math').nth(1).getByRole('button', { name: '編輯公式', exact: true }).click();
			const matrixField = page.locator('.inline-equation-draft math-field');
			await matrixField.waitFor({ state: 'visible' });
			assert.match(await matrixField.evaluate(field => field.value), /pmatrix/);
			const matrixOptions = page.locator('.inline-matrix-options');
			assert.equal(await matrixOptions.isVisible(), true);
			assert.equal(await matrixOptions.getByLabel('行', { exact: true }).inputValue(), '2');
			assert.equal(await matrixOptions.getByLabel('列', { exact: true }).inputValue(), '2');
			await matrixField.click();
			await page.waitForFunction(() => document.activeElement === document.querySelector('.inline-equation-draft math-field'));
			await matrixField.evaluate(field => { field.position = field.lastOffset; });
			await page.keyboard.type('+z');
			assert.match(await matrixField.evaluate(field => field.value), /\\end\{pmatrix\}\+z/);
			await matrixOptions.getByLabel('行', { exact: true }).fill('3');
			await matrixOptions.getByLabel('列', { exact: true }).fill('4');
			await matrixOptions.getByRole('button', { name: '套用尺寸', exact: true }).click();
			const resized = await matrixField.evaluate(field => field.value);
			assert.match(resized, /1 & 2/); assert.match(resized, /3 & 4/); assert.match(resized, /\+z/);
			assert.equal((resized.match(/ & /g) ?? []).length, 9, '3 rows × 4 columns');
			await matrixOptions.getByLabel('行', { exact: true }).fill('1');
			await matrixOptions.getByRole('button', { name: '套用尺寸', exact: true }).click();
			assert.equal(await matrixField.evaluate(field => field.value), resized, 'populated cells cannot be silently removed');
			assert.match(await page.locator('.inline-equation-error').textContent(), /清空/);
			await page.screenshot({ path: screenshotRoot + 'math-matrix-edit-dark-20261012.png' });
			await page.getByRole('button', { name: '取消公式', exact: true }).click();
			assert.match(await sourceEditor.textContent(), /\\begin\{array\}\{cc\}1 & 2/);
			await page.locator('summary[aria-label="數學"]').click();
			await page.getByRole('button', { name: '公式儲存格', exact: true }).click();
			const mathField = page.locator('.inline-equation-draft math-field');
			await mathField.waitFor({ state: 'visible' });
			assert.equal(await page.locator('.math-panel .formula textarea:visible').count(), 0);
			assert.equal(await page.locator('.inline-equation-error:not(:empty)').count(), 0);
			await mathField.click();
			await page.waitForFunction(() => document.activeElement === document.querySelector('.inline-equation-draft math-field'));
			await page.keyboard.type('x');
			await page.waitForFunction(() => document.querySelector('.inline-equation-draft math-field')?.value.includes('x'));
			assert.equal(await page.locator('.inline-equation-draft').getByRole('button', { name: '數學鍵盤', exact: true }).count(), 0);
			assert.equal(await page.evaluate(() => window.mathVirtualKeyboard?.visible ?? false), false);
			assert.equal(await mathField.evaluate(field => !!field.closest('.ProseMirror')), true);
			await page.getByRole('button', { name: '取消公式', exact: true }).click();
			assert.equal(await page.locator('.inline-equation-draft').count(), 0);
			await page.screenshot({ path: screenshotRoot + 'workbench-ui-dark-20261011.png' });
		});
		await t.test('Chinese IME composition retains text in a formula draft', async () => {
			const before = await sourceEditor.textContent();
			await page.locator('.visual-math-content').first().click();
			const draft = page.locator('.inline-equation-draft math-field');
			await draft.waitFor({ state: 'visible' }); await draft.click();
			await page.waitForFunction(() => document.activeElement === document.querySelector('.inline-equation-draft math-field'));
			await page.keyboard.press('Control+A');
			const session = await page.context().newCDPSession(page);
			try {
				await session.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
				await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
				assert.equal(await draft.count(), 1, 'IME candidate Enter must not finish the equation');
				await session.send('Input.insertText', { text: '中文' });
				await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
				assert.match(await draft.evaluate(field => field.value), /中文/);
				await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
				assert.equal(await draft.count(), 1, '229 must also be guarded after compositionend');
				await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
				await page.keyboard.press('Backspace');
				assert.match(await draft.evaluate(field => field.value), /中/);
				await session.send('Input.imeSetComposition', { text: '取消', selectionStart: 2, selectionEnd: 2 });
				await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
				assert.doesNotMatch(await draft.evaluate(field => field.value), /取消/);
			} finally {
				await session.detach();
				await page.getByRole('button', { name: '取消公式', exact: true }).click();
			}
			assert.equal(await sourceEditor.textContent(), before);
		});
		await t.test('display formulas are centered with readable type during and after editing', async () => {
			const content = page.locator('.visual-math:not(.visual-math-inline) .visual-math-content').first();
			const field = content.locator('math-field');
			const box = await content.boundingBox(), math = await field.boundingBox();
			assert.ok(Math.abs(box.x + box.width / 2 - math.x - math.width / 2) < 2);
			assert.equal(await field.evaluate(el => getComputedStyle(el).fontSize), '22px');
			await content.locator('math-field').click();
			const input = page.locator('.inline-equation-input'), draft = input.locator('math-field');
			await draft.waitFor({ state: 'visible' });
			const parent = await input.boundingBox(), editor = await draft.boundingBox();
			assert.ok(Math.abs(parent.x + parent.width / 2 - editor.x - editor.width / 2) < 2);
			assert.equal(await draft.evaluate(el => getComputedStyle(el).fontSize), '22px');
			await page.emulateMedia({ colorScheme: 'light' });
			await page.screenshot({ path: screenshotRoot + 'math-formula-edit-light-20261012.png' });
			await page.emulateMedia({ colorScheme: 'dark' });
			await page.getByRole('button', { name: '取消公式', exact: true }).click();
		});
		await t.test('formula cells edit in the document, cancel unchanged, and commit with Enter', async () => {
			const before = await sourceEditor.textContent();
			await page.locator('.visual-math-content math-field').first().click();
			const draft = page.locator('.inline-equation-draft math-field');
			await draft.waitFor({ state: 'visible' });
			await page.keyboard.press('Control+A'); await page.keyboard.type('z');
			await page.keyboard.press('Escape');
			assert.equal(await sourceEditor.textContent(), before);
			await page.locator('.source-block').filter({ hasText: 'Alpha paragraph.' }).first().click();
			const count = await page.locator('.visual-math').count();
			await page.locator('summary[aria-label="數學"]').click();
			await page.getByRole('button', { name: '公式儲存格', exact: true }).click();
			await draft.waitFor({ state: 'visible' });
			assert.equal(await draft.evaluate(field => field.value), '');
			await page.waitForFunction(() => document.activeElement === document.querySelector('.inline-equation-draft math-field'));
			await page.keyboard.type('x'); await page.keyboard.press('Enter');
			await page.waitForFunction(count => document.querySelectorAll('.visual-math').length === count + 1, count);
			assert.match(await sourceEditor.textContent(), /\\\[x\\\]/);
			const position = await page.locator('.visual-math').first().getAttribute('data-cell-index');
			assert.equal(Number(position), 1, 'toolbar inserts a formula cell below the selected paragraph');
			await page.locator('.visual-math').first().getByRole('button', { name: '編輯公式', exact: true }).click();
			await draft.waitFor({ state: 'visible' });
			await draft.click();
			await page.waitForFunction(() => document.activeElement === document.querySelector('.inline-equation-draft math-field'));
			await page.keyboard.press('Control+A'); await page.keyboard.type('y');
			await page.getByRole('button', { name: '完成公式', exact: true }).click();
			await page.waitForFunction(() => !document.querySelector('.inline-equation-draft'));
			await page.locator('.visual-math').first().getByRole('button', { name: '編輯公式', exact: true }).click();
			await draft.waitFor({ state: 'visible' }); assert.equal(await draft.evaluate(field => field.value), 'y');
			await page.keyboard.press('Escape');
		});
		await t.test('typing updates the document immediately without a shifting status banner or rebuilding math', async () => {
			const paragraph = page.locator('.source-block').filter({ hasText: 'Alpha paragraph.' }).first();
			await paragraph.click();
			await page.keyboard.press('End');
			await page.evaluate(() => {
				const editor = document.querySelector('.ProseMirror');
				const fields = [...document.querySelectorAll('.visual-math-content math-field')];
				window.typingEvidence = { frames: [], synchronous: [], fields };
				editor.addEventListener('beforeinput', event => {
					if (event.inputType !== 'insertText') return;
					const start = performance.now();
					requestAnimationFrame(() => window.typingEvidence.frames.push(performance.now() - start));
				});
				editor.addEventListener('input', event => {
					if (event.inputType === 'insertText') window.typingEvidence.synchronous.push(editor.textContent.includes(event.data));
				});
			});
			await page.keyboard.type(' Immediate input.', { delay: 5 });
			await page.waitForFunction(() => window.typingEvidence.frames.length === 17);
			const evidence = await page.evaluate(() => {
				const { frames, synchronous, fields } = window.typingEvidence;
				return { frames, synchronous, reused: fields.every((field, index) => field === document.querySelectorAll('.visual-math-content math-field')[index]), banner: document.querySelector('.visual-status') !== null };
			});
			assert.equal(evidence.synchronous.length, 17);
			assert.ok(evidence.synchronous.every(Boolean), 'each input is visible during the input event, before worker replies');
			assert.equal(evidence.reused, true);
			assert.equal(evidence.banner, false);
			const sorted = evidence.frames.toSorted((a, b) => a - b);
			console.log('typing input-to-frame ms', JSON.stringify({ count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)] }));
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '取消編輯', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('.source-block')].some(node => node.textContent.includes('Alpha paragraph.') && !node.textContent.includes('Immediate input.')));
			await paragraph.click(); await page.keyboard.press('End');
			await page.keyboard.type(' Kept edit.');
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '完成', exact: true }).click();
			assert.equal(await page.locator('.visual-cell-toolbar').count(), 0);
			assert.match(await paragraph.textContent(), /Kept edit\./);
		});
		await t.test('between-block insertion focuses a persistent editable paragraph and supports undo', async () => {
			const paragraphCount = await page.locator('.source-block').count();
			const inserter = page.locator('.visual-cell-boundary').first();
			await inserter.hover(); await inserter.getByRole('button', { name: '在此處插入區塊', exact: true }).click();
			await inserter.hover(); await inserter.getByRole('button', { name: '插入文字段落', exact: true }).click();
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
			await page.locator('.ProseMirror p').filter({ hasText: 'Beta paragraph.' }).click();
			await page.locator('summary[aria-label="數學"]').click();
			await page.locator('.insert-bar').getByRole('button', { name: '矩陣', exact: true }).click();
			const matrixField = page.locator('.inline-equation-draft math-field');
			await matrixField.waitFor({ state: 'visible' });
			await matrixField.click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('42');
			await matrixField.press('Control+End'); await page.keyboard.type('+x');
			await page.getByRole('button', { name: '完成公式', exact: true }).click();
			await page.waitForFunction((before) => document.querySelectorAll('.visual-math').length === before + 1, matrixCount);
			await page.waitForFunction((before) => document.querySelectorAll('.visual-math-content math-field').length === before + 1, matrixCount);
			assert.match(await page.locator('.visual-math-content math-field').last().evaluate((field) => field.value), /42/);
			await page.locator('.insert-bar').getByRole('button', { name: '表格', exact: true }).click();
			const panel = page.locator('.table-panel');
			const panelBox = await panel.boundingBox();
			assert.ok(panelBox.height < 420, `compact 3×3 table panel height: ${panelBox.height}`);
			assert.equal(await panel.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
			await page.screenshot({ path: screenshotRoot + 'table-panel-compact-dark-20261012.png' });
			await page.emulateMedia({ colorScheme: 'light' });
			await page.screenshot({ path: screenshotRoot + 'table-panel-compact-light-20261012.png' });
			await page.emulateMedia({ colorScheme: 'dark' });
			await panel.locator('summary').click();
			assert.equal(await panel.getByLabel('線條', { exact: true }).isVisible(), true);
			assert.equal(await panel.getByLabel('說明', { exact: true }).isVisible(), true);
			assert.equal(await panel.locator('.widths input').count(), 3);
			await panel.locator('summary').click();
			await page.locator('.table-panel td input').first().fill('Notebook table');
			await page.locator('.table-panel').getByRole('button', { name: '插入', exact: true }).click();
			const table = page.locator('.visual-table').last();
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).waitFor({ state: 'visible' });
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).click();
			const cellIndex = () => table.getAttribute('data-cell-index').then(Number);
			const indexBefore = await cellIndex();
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '上移儲存格', exact: true }).click();
			await page.waitForFunction(index => Number(document.querySelector('.visual-table')?.dataset.cellIndex) === index - 1, indexBefore);
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '下移儲存格', exact: true }).click();
			await page.waitForFunction(index => Number(document.querySelector('.visual-table')?.dataset.cellIndex) === index, indexBefore);
			await page.keyboard.press('Escape'); await page.keyboard.press('Alt+ArrowUp');
			await page.waitForFunction(index => Number(document.querySelector('.visual-table')?.dataset.cellIndex) === index - 1, indexBefore);
			await page.keyboard.press('Alt+ArrowDown');
			await page.waitForFunction(index => Number(document.querySelector('.visual-table')?.dataset.cellIndex) === index, indexBefore);
			await table.getByRole('button', { name: '編輯表格', exact: true }).click();
			const resizeHandle = page.locator('.column-boundary').first();
			assert.equal(await resizeHandle.locator('span').evaluate(element => getComputedStyle(element, '::before').content), '"↔"');
			await page.screenshot({ path: screenshotRoot + 'notebook-column-handles-dark.png' });
			await page.locator('.table-panel td input').first().fill('Discard this draft');
			await page.locator('.table-panel').getByRole('button', { name: '取消', exact: true }).click();
			assert.equal(await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).count(), 1);
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).click();
			page.once('dialog', dialog => dialog.dismiss());
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '刪除此儲存格', exact: true }).click();
			assert.equal(await table.count(), 1);
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).click();
			page.once('dialog', dialog => dialog.accept());
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '刪除此儲存格', exact: true }).click();
			await table.waitFor({ state: 'detached' });
			await page.locator('.source-block').filter({ hasText: 'Alpha paragraph.' }).first().click(); await page.keyboard.press('Control+z');
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
		await t.test('math catalog supports inline Greek, limits and calculus without a keyboard', async () => {
			const paragraph = page.locator('.source-block').filter({ hasText: 'Beta paragraph.' }).first();
			await paragraph.click(); await page.keyboard.press('End');
			await page.locator('summary[aria-label="數學"]').click();
			await page.getByRole('button', { name: '行內公式', exact: true }).click();
			await page.getByRole('button', { name: '展開數學選單', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '希臘字母' }).click();
			assert.equal(await page.getByRole('button', { name: 'Gamma', exact: true }).count(), 1);
			const fieldRect = await page.locator('.inline-equation-input').boundingBox();
			const menuRect = await page.locator('.inline-equation-catalog').boundingBox();
			assert.ok(menuRect.y >= fieldRect.y + fieldRect.height, 'menu is below the input instead of covering it');
			await page.getByRole('button', { name: 'alpha', exact: true }).click();
			await page.getByRole('button', { name: '展開數學選單', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '極限與級數' }).click();
			assert.equal(await page.getByRole('button', { name: '極限', exact: true }).count(), 1);
			await page.getByRole('button', { name: '返回種類', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '微積分與導數' }).click();
			assert.equal(await page.getByRole('button', { name: '微分元 dx', exact: true }).count(), 1);
			assert.equal(await page.getByRole('button', { name: '偏導數', exact: true }).count(), 1);
			await page.getByRole('button', { name: '返回種類', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '多行環境' }).click();
			assert.equal(await page.getByRole('button', { name: '多行函數', exact: true }).count(), 1);
			await page.screenshot({ path: screenshotRoot + 'math-parity-catalog-dark.png' });
			await page.getByRole('button', { name: '完成公式', exact: true }).click();
			await paragraph.locator('.visual-math-inline').waitFor({ state: 'visible' });
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			assert.match(await sourceEditor.innerText(), /\\\(\\alpha\s*\\\)/);
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
		});
		await t.test('code cells insert, edit and cancel without executable HTML', async () => {
			await page.getByRole('button', { name: '程式碼區塊', exact: true }).click();
			await page.getByLabel('程式碼語言', { exact: true }).selectOption('typescript');
			await page.locator('.code-panel textarea').fill('const value = "<script>alert(1)</script>";\nconsole.log(value);');
			await page.waitForFunction(() => document.querySelector('.code-highlight .tok-keyword'));
			assert.ok(await page.getByLabel('程式碼語言', { exact: true }).locator('option').count() > 100);
			await page.locator('.code-panel').getByRole('button', { name: '插入', exact: true }).click();
			const block = page.locator('.visual-raw').filter({ has: page.locator('.code-content') }).last();
			await block.locator('.code-content').waitFor({ state: 'visible' });
			assert.match(await block.locator('.code-content').innerText(), /<script>/);
			assert.equal(await block.locator('script').count(), 0);
			await page.waitForFunction(() => document.querySelector('.code-content .tok-keyword'));
			await block.getByRole('button', { name: '編輯程式碼', exact: true }).click();
			assert.equal(await page.getByLabel('程式碼語言', { exact: true }).inputValue(), 'typescript');
			await page.locator('.code-panel textarea').fill('discarded');
			await page.locator('.code-panel').getByRole('button', { name: '取消', exact: true }).click();
			assert.match(await block.locator('.code-content').innerText(), /console.log/);
			await page.screenshot({ path: screenshotRoot + 'math-parity-code-dark.png' });
		});
		await t.test('selected text color projects immediately and includes xcolor', async () => {
			const paragraph = page.locator('.source-block').filter({ hasText: 'Alpha paragraph.' }).first();
			await paragraph.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
			await page.locator('summary[aria-label="文字顏色"]').click();
			await page.getByRole('button', { name: '紅色', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('.source-block span')].some(span => span.style.color === 'rgb(180, 35, 24)'));
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			assert.match(await sourceEditor.innerText(), /\\usepackage\{xcolor\}/);
			assert.match(await sourceEditor.innerText(), /\\textcolor\[HTML\]\{B42318\}/);
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
		});
		await t.test('visual typing separates the document end and remains editable across consecutive inputs', async () => {
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			await page.getByRole('button', { name: '原始碼', exact: true }).click(); await sourceEditor.click(); await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\n2555\n\\par   58866\\end{document}');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			const paragraph = page.locator('.source-block').filter({ hasText: '58866' });
			await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type('XY');
			await page.waitForFunction(() => [...document.querySelectorAll('.source-block')].some(node => node.textContent.includes('58866XY')));
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			assert.match(await sourceEditor.innerText(), /58866XY\n\\end\{document\}/);
		});
		await t.test('real mouse dragging reorders arbitrary cells, retains paragraphs, cancels and shares undo', async () => {
			await sourceEditor.click(); await page.keyboard.press('Control+A');
			const original = '\\documentclass{article}\n\\begin{document}\nFirst\n\\par Second\n\\[x^2\\]\n\\par Third\n\\end{document}\n';
			await page.keyboard.insertText(original); await page.getByRole('button', { name: '視覺化', exact: true }).click();
			await page.waitForFunction(() => document.querySelectorAll('.notebook-cell').length === 4);
			const handles = page.locator('.cell-drag-handle'), cells = page.locator('.notebook-cell');
			const start = await handles.first().boundingBox(), last = await cells.last().boundingBox();
			await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
			const pickedUp = page.locator('.is-cell-picked-up .notebook-cell.is-selected');
			assert.equal(await pickedUp.count(), 1);
			assert.notEqual(await pickedUp.evaluate(node => getComputedStyle(node).boxShadow), 'none');
			assert.notEqual(await pickedUp.evaluate(node => getComputedStyle(node).transform), 'none');
			await page.mouse.move(last.x + 40, last.y + last.height - 2, { steps: 15 });
			assert.equal(await page.locator('.is-drop-target').count(), 1);
			await page.screenshot({ path: screenshotRoot + 'cell-drag-drop-target.png' }); await page.mouse.up();
			assert.equal(await page.locator('.is-cell-picked-up').count(), 0);
			await page.waitForFunction(() => [...document.querySelectorAll('.notebook-cell')].at(-1)?.textContent.trim() === 'First');
			assert.equal(await cells.count(), 4); assert.equal(await cells.last().getAttribute('class').then(value => value.includes('is-selected')), true);
			await page.getByRole('button', { name: '原始碼', exact: true }).click(); await sourceEditor.click(); await page.keyboard.press('Control+z');
			assert.equal((await sourceEditor.innerText()).trim(), original.trim());
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			await page.waitForFunction(() => [...document.querySelectorAll('.notebook-cell')].at(-1)?.textContent.trim() === 'Third');
			const endHandle = await handles.last().boundingBox(), first = await cells.first().boundingBox();
			await page.mouse.move(endHandle.x + 10, endHandle.y + 10); await page.mouse.down(); await page.mouse.move(first.x + 30, first.y + 1, { steps: 12 });
			await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal(await page.locator('.is-drop-target').count(), 0); assert.equal((await cells.first().innerText()).trim(), 'First');
			await handles.last().hover(); const retry = await handles.last().boundingBox(), target = await cells.first().boundingBox();
			await page.mouse.move(retry.x + retry.width / 2, retry.y + retry.height / 2); await page.mouse.down(); await page.mouse.move(target.x + 30, target.y + 1, { steps: 12 });
			assert.equal(await page.locator('.is-drop-target').count(), 1); await page.mouse.up();
			await page.waitForFunction(() => document.querySelector('.notebook-cell')?.textContent.trim() === 'Third');
		});
		await t.test('text cells switch title, abstract and heading levels without losing content', async () => {
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			await sourceEditor.click(); await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\nStructured text.\n\\end{document}\n');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			const structure = page.getByRole('combobox', { name: '文字層級', exact: true });
			for (const [kind, selector, source] of [
				['section', 'h2.source-block', /\\section\{Structured text\.\}/],
				['subsection', 'h3.source-block', /\\subsection\{Structured text\.\}/],
				['subsubsection', 'h4.source-block', /\\subsubsection\{Structured text\.\}/],
				['abstract', '.source-block[data-source-role="abstract"]', /\\begin\{abstract\}/],
				['title', 'h1.source-block', /\\title\{Structured text\.\}\s*\\maketitle/],
				['paragraph', 'p.source-block', /Structured text\./]
			]) {
				await page.locator('.source-block').filter({ hasText: 'Structured text.' }).click();
				await structure.selectOption(kind);
				await page.locator(selector).filter({ hasText: 'Structured text.' }).waitFor({ state: 'visible' });
				assert.match(await sourceEditor.textContent(), source);
				assert.equal(await page.locator('.visual-raw').count(), 0, 'generated structure stays visually editable');
			}
			await page.screenshot({ path: screenshotRoot + 'text-structure-20261012.png' });
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
