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
			assert.equal(await page.evaluate(() => typeof window.mathVirtualKeyboard), 'undefined', 'virtual keyboard has no global runtime');
			assert.equal(await mathField.evaluate(field => field.shadowRoot.querySelector('[part="virtual-keyboard-toggle"]') === null), true);
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
			assert.ok(await page.locator('.visual-math-content math-field').evaluateAll(fields => fields.some(field => field.value.includes('42'))));
			await page.locator('.insert-bar').getByRole('button', { name: '表格', exact: true }).click();
			const panel = page.locator('.table-panel');
			const panelBox = await panel.boundingBox();
			await page.screenshot({ path: screenshotRoot + 'table-panel-choices-inspection.png' });
			assert.ok(panelBox.height < 420, `compact 3×3 table panel height: ${panelBox.height}`);
			assert.equal(await panel.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
			assert.equal(await panel.locator('select').count(), 0);
			await panel.getByRole('button', { name: '全框線', exact: true }).click();
			assert.equal(await panel.locator('table.full').count(), 1);
			await panel.getByRole('button', { name: '三線表', exact: true }).click();
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
			await page.locator('.table-panel').getByRole('button', { name: '取消', exact: true }).click();
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
			assert.equal(await resizeHandle.locator('svg').count(), 1);
			const leftBefore = await resizeHandle.evaluate(element => parseFloat(element.style.left));
			await resizeHandle.focus();
			await page.keyboard.press('ArrowRight');
			assert((await resizeHandle.evaluate(element => parseFloat(element.style.left))) > leftBefore);
			await page.keyboard.press('ArrowLeft');
			assert(Math.abs((await resizeHandle.evaluate(element => parseFloat(element.style.left))) - leftBefore) < 0.001);
			await page.screenshot({ path: screenshotRoot + 'notebook-column-handles-dark.png' });
			await page.locator('.table-panel td input').first().fill('Discard this draft');
			await page.locator('.table-panel').getByRole('button', { name: '取消', exact: true }).click();
			assert.equal(await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).count(), 1);
			page.once('dialog', dialog => dialog.dismiss());
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '刪除此儲存格', exact: true }).click();
			assert.equal(await table.count(), 1);
			page.once('dialog', dialog => dialog.accept());
			await page.locator('.visual-cell-toolbar').getByRole('button', { name: '刪除此儲存格', exact: true }).click();
			await table.waitFor({ state: 'detached' });
			await page.locator('.source-block').filter({ hasText: 'Alpha paragraph.' }).first().click(); await page.keyboard.press('Control+z');
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).waitFor({ state: 'visible' });
			await table.getByRole('button', { name: '編輯表格', exact: true }).click();
			await page.locator('.table-panel td input').first().fill('Revised notebook table');
			await page.locator('.table-panel').getByRole('button', { name: '套用', exact: true }).click();
			await table.getByRole('columnheader', { name: 'Revised notebook table', exact: true }).waitFor({ state: 'visible' });
			await page.locator('.source-block').filter({ hasText: 'Beta paragraph.' }).click();
			await page.keyboard.press('Control+z');
			await table.getByRole('columnheader', { name: 'Notebook table', exact: true }).waitFor({ state: 'visible' });
			await page.screenshot({ path: screenshotRoot + 'workbench-blocks-dark-20261011.png' });
			await page.emulateMedia({ colorScheme: 'light' });
			await page.screenshot({ path: screenshotRoot + 'workbench-blocks-light-20261011.png' });
			await page.emulateMedia({ colorScheme: 'dark' });
		});
		await t.test('math catalog supports inline Greek, limits and calculus without a keyboard', async () => {
			const paragraph = page.locator('.source-block').filter({ hasText: 'Beta paragraph.' }).first();
			const textEnd = await paragraph.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const rect = [...range.getClientRects()].filter(rect => rect.width > 1).at(-1); return { x: rect.right - 2, y: rect.top + rect.height / 2 }; });
			await page.mouse.click(textEnd.x, textEnd.y); await page.keyboard.press('End');
			await page.locator('summary[aria-label="數學"]').click();
			await page.getByRole('button', { name: '行內公式', exact: true }).click();
			await page.locator('.inline-equation-draft math-field').waitFor({ state: 'visible' });
			assert.equal(await page.locator('.inline-equation-draft').evaluate(node => node.parentElement.classList.contains('source-block')), true, 'inline draft stays in its text paragraph');
			await page.getByRole('button', { name: '極限（lim）', exact: true }).click();
			assert.equal(await page.getByRole('button', { name: '極限', exact: true }).count(), 1);
			const findFormula = page.getByRole('searchbox', { name: '搜尋公式', exact: true });
			await findFormula.fill('dx');
			assert.equal(await page.getByRole('button', { name: '微分元 dx', exact: true }).count(), 1);
			await findFormula.fill('lim');
			assert.equal(await page.getByRole('button', { name: '極限', exact: true }).count(), 1);
			await findFormula.fill('不存在的公式'); assert.match(await page.locator('.inline-equation-catalog').textContent(), /沒有符合/);
			await page.getByRole('button', { name: '微積分', exact: true }).click();
			assert.equal(await page.getByRole('button', { name: '封閉三重積分（上下限界）', exact: true }).count(), 1);
			assert.equal(await page.getByRole('button', { name: '微分元 dθ', exact: true }).count(), 1);
			await page.screenshot({ path: screenshotRoot + 'math-calculus-gallery-dark.png' });
			await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: screenshotRoot + 'math-calculus-gallery-light.png' }); await page.emulateMedia({ colorScheme: 'dark' });
			await page.getByRole('button', { name: '返回', exact: true }).click();
			await page.getByRole('button', { name: '展開數學選單', exact: true }).click();
			await page.getByRole('button', { name: '展開數學選單', exact: true }).click();
			await page.screenshot({ path: screenshotRoot + 'math-categories-gallery-dark.png' });
			await page.locator('.catalog-tab').filter({ hasText: '希臘字母' }).click();
			assert.equal(await page.locator('.inline-equation-catalog').evaluate(panel => panel.scrollTop), 0);
			await page.screenshot({ path: screenshotRoot + 'math-gallery-inspection.png' });
			assert.equal(await page.getByRole('button', { name: 'Gamma', exact: true }).count(), 1);
			const fieldRect = await page.locator('.inline-equation-input').boundingBox();
			const menuRect = await page.locator('.inline-equation-catalog').boundingBox();
			assert.ok(menuRect.y >= fieldRect.y + fieldRect.height, 'menu is below the input instead of covering it');
			await page.getByRole('button', { name: 'alpha', exact: true }).click();
			await page.getByRole('button', { name: '展開數學選單', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '極限（lim）與級數' }).click();
			assert.equal(await page.getByRole('button', { name: '極限', exact: true }).count(), 1);
			await page.getByRole('button', { name: '返回', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '微積分' }).click();
			assert.equal(await page.getByRole('button', { name: '微分元 dx', exact: true }).count(), 1);
			assert.equal(await page.getByRole('button', { name: '偏導數', exact: true }).count(), 1);
			await page.getByRole('button', { name: '返回', exact: true }).click();
			await page.locator('.catalog-tab').filter({ hasText: '多行環境' }).click();
			assert.equal(await page.getByRole('button', { name: '多行函數', exact: true }).count(), 1);
			await page.screenshot({ path: screenshotRoot + 'math-parity-catalog-dark.png' });
			await page.getByRole('button', { name: '完成公式', exact: true }).click();
			await paragraph.locator('.visual-math-inline').waitFor({ state: 'visible' });
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			assert.match(await sourceEditor.innerText(), /\\\(\\alpha\s*\\\)/);
			assert.match(await sourceEditor.innerText(), /Beta paragraph\.\\\(\\alpha\s*\\\)/, 'inline equation adds no paragraph or newline');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
		});
		await t.test('code cells insert, edit and cancel without executable HTML', async () => {
			await page.getByRole('button', { name: '程式碼區塊', exact: true }).click();
			await page.getByLabel('程式碼語言', { exact: true }).selectOption('typescript');
			await page.locator('.code-panel textarea').fill('const value = "<script>alert(1)</script>";\nconsole.log(value);');
			await page.waitForFunction(() => document.querySelector('.code-highlight .tok-keyword'));
			const layout = await page.locator('.code-panel').evaluate(panel => {
				const language = panel.querySelector('.language-row').getBoundingClientRect(), input = panel.querySelector('.code-input-stack').getBoundingClientRect();
				return { whitespace: getComputedStyle(panel).whiteSpace, gap: input.top - language.bottom, height: panel.getBoundingClientRect().height };
			});
			assert.equal(layout.whitespace, 'normal'); assert.ok(layout.gap <= 12); assert.ok(layout.height < 380);
			await page.screenshot({ path: screenshotRoot + 'code-panel-cohesive-dark.png' });
			await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: screenshotRoot + 'code-panel-cohesive-light.png' }); await page.emulateMedia({ colorScheme: 'dark' });
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
			await paragraph.scrollIntoViewIfNeeded(); const ink = await paragraph.evaluate(node => { const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text; while ((text = walk.nextNode()) && !text.textContent.includes('Alpha')) {} const range = document.createRange(), offset = text.textContent.indexOf('Alpha'); range.setStart(text, offset); range.setEnd(text, offset + 1); const box = range.getBoundingClientRect(); return { x: box.left + 2, y: box.top + box.height / 2 }; }); await page.mouse.click(ink.x, ink.y); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
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
		await t.test('Chinese composition, Enter and font-dependent wrapping preserve notebook text', async () => {
			await page.getByRole('button', { name: '原始碼', exact: true }).click(); await sourceEditor.click(); await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\n起始文字\n\\end{document}\n');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			const paragraph = page.locator('.source-block').filter({ hasText: '起始文字' });
			await paragraph.click(); await page.keyboard.press('End');
			const session = await page.context().newCDPSession(page);
			try {
				await session.send('Input.imeSetComposition', { text: '我', selectionStart: 1, selectionEnd: 1 });
				await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
				await session.send('Input.insertText', { text: '我' });
				await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
			} finally { await session.detach(); }
			await page.keyboard.press('Enter'); await page.keyboard.insertText('下一行');
			await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('下一行'));
			assert.equal(await page.getByText('這次編輯未套用，請重新選取內容後再試。', { exact: true }).count(), 0);
			assert.match(await sourceEditor.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')), /起始文字我\s*\n\s*下一行/);
			await page.keyboard.press('Enter');
			const long = '中文 English 123 '.repeat(60) + 'LongUnbrokenIdentifier'.repeat(20);
			await page.keyboard.insertText(long);
			const wrapped = page.locator('.source-block').filter({ hasText: 'LongUnbrokenIdentifier' });
			const heights = [];
			for (const width of [1280, 820]) {
				await page.setViewportSize({ width, height: 850 });
				if (width < 960) await page.locator('#workbench-tab-document').click();
				await wrapped.waitFor({ state: 'visible' });
				for (const font of [16, 24]) {
					const measured = await wrapped.evaluate((node, font) => { node.style.fontSize = font + 'px'; return { width: node.clientWidth, scroll: node.scrollWidth, height: node.getBoundingClientRect().height }; }, font);
					assert.ok(measured.scroll <= measured.width + 1, 'text stays inside its cell'); heights.push(measured.height);
				}
			}
			assert.ok(heights[1] > heights[0]); assert.ok(heights[3] > heights[2]);
			await wrapped.evaluate(node => node.style.removeProperty('font-size')); await page.setViewportSize({ width: 1280, height: 850 });
		});
		await t.test('images insert, copy, paste, survive reload and share document undo', async () => {
			await page.getByRole('button', { name: '原始碼', exact: true }).click(); await sourceEditor.click(); await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\nImage document\n\\end{document}\n');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80; const context = canvas.getContext('2d'); context.fillStyle = '#3d617b'; context.fillRect(0, 0, 120, 80); return canvas.toDataURL('image/png').split(',')[1]; });
			await page.getByLabel('選擇圖片', { exact: true }).setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
			await page.waitForFunction(() => document.querySelector('.visual-image img')?.naturalWidth === 120);
			assert.match(await sourceEditor.innerText(), /\\usepackage\{graphicx\}/);
			const button = page.locator('.visual-image-content').first(); await button.click();
			const copied = await button.evaluate(node => { const data = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('application/x-modutex-image'); });
			assert.equal(copied, png, 'copy retains the original image bytes');
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click();
			await page.locator('.ProseMirror').evaluate((node, copied) => { const data = new DataTransfer(); data.setData('application/x-modutex-image', copied); node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, copied);
			await page.waitForFunction(() => document.querySelectorAll('.visual-image img').length === 2 && [...document.querySelectorAll('.visual-image img')].every(image => image.naturalWidth === 120));
			const jpeg = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80; canvas.getContext('2d').fillRect(0, 0, 120, 80); return canvas.toDataURL('image/jpeg').split(',')[1]; });
			await page.getByLabel('選擇圖片', { exact: true }).setInputFiles({ name: 'test.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
			await page.waitForFunction(() => document.querySelectorAll('.visual-image img').length === 3 && [...document.querySelectorAll('.visual-image img')].every(image => image.naturalWidth === 120));
			const jpegButton = page.locator('.visual-image-content').filter({ has: page.locator('img[alt$=".jpg"]') });
			assert.equal(await jpegButton.evaluate(node => { const data = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('application/x-modutex-image'); }), jpeg);
			await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
			await page.evaluate(() => navigator.clipboard.writeText(''));
			await jpegButton.click(); await page.keyboard.press('Control+c');
			await page.waitForFunction(async () => (await navigator.clipboard.read()).some(item => item.types.includes('image/png')));
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click(); await page.keyboard.press('Control+v');
			await page.waitForFunction(() => document.querySelectorAll('.visual-image img').length === 4 && [...document.querySelectorAll('.visual-image img')].every(image => image.naturalWidth === 120));
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click(); await page.keyboard.press('Control+z');
			await page.waitForFunction(() => document.querySelectorAll('.visual-image').length === 3);
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click(); await page.keyboard.press('Control+z');
			await page.waitForFunction(() => document.querySelectorAll('.visual-image').length === 2);
			const source = await sourceEditor.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
			await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
			await page.evaluate(() => navigator.clipboard.writeText(''));
			await button.click(); await page.keyboard.press('Control+c');
			await page.waitForFunction(async () => (await navigator.clipboard.read()).some(item => item.types.includes('image/png')));
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click(); await page.keyboard.press('Control+v');
			await page.waitForFunction(() => document.querySelectorAll('.visual-image img').length === 3 && [...document.querySelectorAll('.visual-image img')].every(image => image.naturalWidth === 120));
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click(); await page.keyboard.press('Control+z');
			await page.waitForFunction(() => document.querySelectorAll('.visual-image').length === 2);
			await page.locator('.source-block').filter({ hasText: 'Image document' }).click(); await page.keyboard.press('Control+z');
			await page.waitForFunction(() => document.querySelectorAll('.visual-image').length === 1);
			page.once('dialog', dialog => dialog.accept()); await page.reload(); await page.getByRole('button', { name: '新文件', exact: true }).click();
			await page.getByRole('button', { name: '原始碼', exact: true }).click(); await sourceEditor.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(source);
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			await page.waitForFunction(() => document.querySelectorAll('.visual-image img').length === 2 && [...document.querySelectorAll('.visual-image img')].every(image => image.naturalWidth === 120));
		});
		await t.test('toolbar inserts at the clicked cell caret and retains both sides without a placeholder cell', async () => {
			for (const kind of ['inline', 'display', 'code', 'table']) for (const offset of [0, 6, 11]) {
				await page.getByRole('button', { name: '原始碼', exact: true }).click(); await sourceEditor.click(); await page.keyboard.press('Control+A');
				await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}beforeRIGHT\\end{document}\n');
				await page.getByRole('button', { name: '視覺化', exact: true }).click();
				await page.locator('.source-block').filter({ hasText: 'beforeRIGHT' }).click(); await page.keyboard.press('Home'); for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
				if (kind === 'inline' || kind === 'display') {
					await page.locator('summary[aria-label="數學"]').click(); await page.getByRole('button', { name: kind === 'inline' ? '行內公式' : '公式儲存格', exact: true }).click();
					const field = page.locator('.inline-equation-draft math-field'); await field.waitFor({ state: 'visible' });
					assert.equal(await page.locator('.inline-equation-draft').evaluate(node => !!node.closest('.source-block')), true);
					await field.press('x'); assert.equal(await field.evaluate(field => field.value), 'x', 'typed equation is ready before commit'); await page.getByRole('button', { name: '完成公式', exact: true }).click();
				} else if (kind === 'code') {
					await page.getByRole('button', { name: '程式碼區塊', exact: true }).click(); await page.locator('.code-panel textarea').fill('caretCode'); await page.locator('.code-panel').getByRole('button', { name: '插入', exact: true }).click();
				} else {
					await page.locator('.insert-bar').getByRole('button', { name: '表格', exact: true }).click(); await page.locator('.table-panel td input').first().fill('caretTable'); await page.locator('.table-panel').getByRole('button', { name: '插入', exact: true }).click();
				}
				await page.waitForFunction(() => !document.querySelector('.inline-equation-draft, .cell-panel-draft'));
				const source = await sourceEditor.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
				const token = kind === 'code' ? 'caretCode' : kind === 'table' ? 'caretTable' : 'x';
				const body = source.slice(source.indexOf('\\begin{document}') + '\\begin{document}'.length, source.indexOf('\\end{document}')).trim(), prefix = 'beforeRIGHT'.slice(0, offset), suffix = 'beforeRIGHT'.slice(offset);
				assert.ok(body.startsWith(prefix) && body.endsWith(suffix) && body.includes(token), kind + '/' + offset + ' retains text before and after the caret');
				assert.equal(await page.locator('.source-block').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim()).length), 0);
				if (kind === 'inline') assert.equal(await page.locator('.source-block').count(), 1);
			}
		});
		await t.test('text cells switch title, abstract and heading levels without losing content', async () => {
			await page.getByRole('button', { name: '原始碼', exact: true }).click();
			await sourceEditor.click(); await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\nStructured text.\n\\end{document}\n');
			await page.getByRole('button', { name: '視覺化', exact: true }).click();
			const structure = page.locator('summary[aria-label="文字層級"]');
			for (const [kind, selector, source] of [
				['section', 'h2.source-block', /\\section\{Structured text\.\}/],
				['subsection', 'h3.source-block', /\\subsection\{Structured text\.\}/],
				['subsubsection', 'h4.source-block', /\\subsubsection\{Structured text\.\}/],
				['abstract', '.source-block[data-source-role="abstract"]', /\\begin\{abstract\}/],
				['title', 'h1.source-block', /\\title\{Structured text\.\}\s*\\maketitle/],
				['paragraph', 'p.source-block', /Structured text\./]
			]) {
				await page.locator('.source-block').filter({ hasText: 'Structured text.' }).click();
				await structure.click(); await page.locator('.structure-options [data-structure="'+kind+'"]').click();
				await page.locator(selector).filter({ hasText: 'Structured text.' }).waitFor({ state: 'visible' });
				assert.match(await sourceEditor.textContent(), source);
				assert.equal(await page.locator('.visual-raw').count(), 0, 'generated structure stays visually editable');
			}
			await page.screenshot({ path: screenshotRoot + 'text-structure-20261012.png' });
		});
		await t.test('visible language switch updates editor tools and settings and persists across reload', async () => {
			const original = await sourceEditor.innerText();
			const language = page.locator('summary[aria-label="語言"]'); await language.waitFor({ state: 'visible' }); assert.equal(await language.locator('svg').count(), 1); assert.equal(await language.textContent(), '');
			await language.click(); assert.equal(await page.locator('.app').getAttribute('lang'), 'zh-Hant'); assert.equal(await page.getByRole('button', { name: '繁體中文', exact: true }).getAttribute('aria-pressed'), 'true');
			await page.keyboard.press('Escape'); assert.equal(await page.locator('.language-menu').evaluate(menu => menu.open), false); await language.click();
			await page.screenshot({ path: screenshotRoot + 'language-globe-menu.png' });
			await page.getByRole('button', { name: 'English', exact: true }).click(); assert.equal(await page.locator('.language-menu').evaluate(menu => menu.open), false);
			assert.equal(await page.locator('.app').getAttribute('lang'), 'en');
			assert.equal(await page.getByRole('button', { name: 'Code block', exact: true }).count(), 1);
			await page.locator('summary[aria-label="Math"]').click(); assert.equal(await page.getByRole('button', { name: 'Inline equation', exact: true }).count(), 1); await page.locator('summary[aria-label="Math"]').click();
			await page.locator('.insert-bar').getByRole('button', { name: 'Table', exact: true }).click();
			await page.getByRole('button', { name: 'All borders', exact: true }).waitFor({ state: 'visible' }); await page.locator('.table-panel').getByRole('button', { name: 'Cancel', exact: true }).click();
			assert.equal(await sourceEditor.innerText(), original, 'locale and canceled English tools preserve source');
			await page.getByRole('link', { name: 'Settings', exact: true }).click(); await page.locator('#language-value').selectOption('zh-Hant');
			assert.equal(await page.locator('.app').getAttribute('lang'), 'zh-Hant');
			await page.locator('summary[aria-label="語言"]').click(); await page.getByRole('button', { name: 'English', exact: true }).click();
			page.once('dialog', dialog => dialog.accept()); await page.reload();
			await page.locator('summary[aria-label="Language"]').waitFor({ state: 'visible' }); await page.locator('summary[aria-label="Language"]').click(); assert.equal(await page.locator('.app').getAttribute('lang'), 'en');
			await page.getByRole('button', { name: '繁體中文', exact: true }).click(); assert.equal(await page.locator('.app').getAttribute('lang'), 'zh-Hant');
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
