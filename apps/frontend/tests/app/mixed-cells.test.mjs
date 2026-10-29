import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { clickFileAction } from '../../../../tests/scripts/helpers/app-file-actions.mjs';
import { articleText, articleChunks } from '../helpers/mixed-article.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = ['section', 'subsection', 'subsubsection', 'abstract', 'article-single', 'article-multiple'].flatMap(kind =>
 ['png', 'jpeg'].flatMap(format => ['light', 'dark'].map(theme => ({ kind, format, theme })))).filter(value => !process.env.MODUTEX_MATRIX_CASE || `${value.kind}/${value.format}` === process.env.MODUTEX_MATRIX_CASE);
assert.ok(cases.length, 'unknown matrix case filter');
if (!process.env.MODUTEX_MATRIX_CASE) assert.equal(cases.length, 24);
const fence = value => `% ModuTeX cell begin\n${value}\n% ModuTeX cell end\n`;
assert.equal([...articleText].length, 5000);

test('isolated mixed-cell matrix', { timeout: 180000, concurrency: 2 }, async t => {
 const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
 await server.listen();
 const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
 t.after(async () => { await browser.close(); await server.close(); });
 const url = `http://127.0.0.1:${server.httpServer.address().port}`;
 await Promise.allSettled(cases.map(({ kind, format, theme }) => t.test(`${kind}/${format}/${theme}: Chinese, English, formatting, math and images share a movable cell`, async t => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: theme });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  try {
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await clickFileAction(page, /^(新增文件|New document)$/);
  await page.getByRole('button', { name: '原始碼', exact: true }).click();
  const editor = page.locator('.source-view .source .cm-content');
  const readSource = async () => (await editor.locator('.cm-line').allTextContents()).join('\n');
  const title = '\\textcolor[HTML]{FF0000}{\\textbf{\\underline{混合 Mixed}}}';
  const heading = kind === 'abstract' ? `\\begin{abstract}${title}\\end{abstract}` : `\\${kind}{${title}}`;
  const bodyText = '\\par\nBody 內文 \\(x^2+\\frac{1}{2}\\)';
  const sections = [`\\title{${title}}\\maketitle\n\\begin{abstract}${title} English abstract 摘要\\end{abstract}\n${articleText.slice(0,1000)}`, `\\section{${title}}\n${articleText.slice(1000,2000)} \\(a+b\\)`, `\\subsection{${title}}\n${articleText.slice(2000,3000)} English`, `\\subsubsection{${title}}\n${articleText.slice(3000,4000)} \\(E=mc^2\\)`, `${articleText.slice(4000)}\n${bodyText}`];
  const content = kind === 'article-single' ? fence(sections.join('\n\\par\n')) : kind === 'article-multiple' ? sections.map((section, index) => fence((index ? '\\par\n' : '') + section)).join('') : fence(heading + '\n' + bodyText);
  const initialCells = kind === 'article-multiple' ? 6 : 2;
  const source = '\\documentclass{article}\n\\usepackage{amsmath,xcolor}\n\\usepackage[UTF8,scheme=plain,fontset=fandol]{ctex}\n\\author{}\\date{}\n\\begin{document}\n' + content + '\\par\nTail END\n\\end{document}\n';
  await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(source);
  await page.getByRole('button', { name: '視覺化', exact: true }).click();
  await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells);
  const formatted = page.locator('.source-block').filter({ hasText: '混合 Mixed' }).first();
  async function selectFormattedText() {
   await formatted.click();
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
   await page.waitForFunction(() => window.getSelection()?.toString() === '混合 Mixed');
   // Native Shift+End updates the DOM selection before selectionchange reaches ProseMirror.
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  for (const [button, tag] of [['粗體', 'strong'], ['底線', 'u']]) {
   await selectFormattedText(); await page.locator('.insert-bar').getByRole('button', { name: button, exact: true }).click();
   await page.waitForFunction(({tag}) => { const block=[...document.querySelectorAll('.source-block')].find(node=>node.textContent.includes('混合 Mixed'));return block&&!block.querySelector(tag); }, {tag});
   assert.equal(await formatted.locator(tag).count(), 0, `${button} can be removed from mixed heading text`);
   await selectFormattedText(); await page.locator('.insert-bar').getByRole('button', { name: button, exact: true }).click();
   await page.waitForFunction(({tag}) => { const block=[...document.querySelectorAll('.source-block')].find(node=>node.textContent.includes('混合 Mixed'));return !!block?.querySelector(tag); }, {tag});
  }
  await selectFormattedText(); await page.locator('summary[aria-label="文字顏色"]').click();
  await page.getByRole('button', { name: '紅色', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.source-block span')].some(span => span.style.color === 'rgb(180, 35, 24)'));
  const body = page.locator('.source-block').filter({ hasText: 'Body 內文' });
  await body.click(); await page.keyboard.press('End');
  const encoded = await page.evaluate(format => { const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 60; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3d617b'; ctx.fillRect(0, 0, 120, 60); return canvas.toDataURL('image/' + format).split(',')[1]; }, format);
  await page.getByLabel('選擇圖片', { exact: true }).setInputFiles({ name: `matrix.${format === 'jpeg' ? 'jpg' : 'png'}`, mimeType: 'image/' + format, buffer: Buffer.from(encoded, 'base64') });
  await page.waitForFunction(() => document.querySelector('.visual-image img')?.naturalWidth === 120);
  assert.equal(await page.locator('.notebook-cell').count(), initialCells, 'image and text must remain one user cell');
  const owner = await body.getAttribute('data-cell-owner');
  assert.equal(await page.locator('.visual-image').getAttribute('data-cell-owner'), owner);
  await page.waitForFunction(() => [...document.querySelectorAll('math-field')].some(field => field.value?.includes('frac')));
  assert.ok(await page.locator('math-field').count(), 'mixed cell retains actual MathLive presentation');
  const style = await formatted.evaluate(element => {
   const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let found;
   while ((found = walker.nextNode()) && !found.textContent.includes('混合 Mixed')) {}
   const text = found?.parentElement ?? element;
   const ancestors = []; for (let node = text; node && node !== element.parentElement; node = node.parentElement) { const s = getComputedStyle(node); ancestors.push({ weight: s.fontWeight, decoration: s.textDecorationLine, color: s.color }); }
   return ancestors;
  });
  assert.ok(style.some(s => Number(s.weight) >= 700), JSON.stringify(style));
  assert.ok(style.some(s => s.decoration.includes('underline')), JSON.stringify(style));
  assert.ok(style.some(s => s.color === 'rgb(180, 35, 24)'), JSON.stringify(style));
  const before = await readSource();
  assert.equal((before.match(/\p{Script=Han}/gu) ?? []).length, (source.match(/\p{Script=Han}/gu) ?? []).length, 'complete article text survives image insertion');
  if (kind.startsWith('article-')) for (const chunk of articleChunks) assert.ok(before.includes(chunk), 'complete bilingual article chunk is retained');
  await page.locator('.visual-image img').dragTo(page.locator('.source-block').filter({ hasText: 'Tail END' }));
  assert.equal(await page.locator('.notebook-cell').count(), initialCells, 'dragging image pixels must never create another cell');
  assert.equal(await readSource(), before, 'native image dragging cannot detach an asset from its owning cell');
  const imageAt = before.indexOf('\\includegraphics'), groupStart = before.lastIndexOf('% ModuTeX cell begin', imageAt);
  assert.ok(imageAt < before.indexOf('% ModuTeX cell end', groupStart), 'image is saved inside the same explicit cell boundary');
  assert.equal(await page.locator('.cell-drag-handle').count(), initialCells, 'one handle per user cell');
  const ownerOrdinal = await page.locator('.notebook-cell').evaluateAll((nodes, owner) => nodes.findIndex(node => node.getAttribute('data-cell-index') === owner), owner);
  const handleNode = page.locator('.cell-drag-handle').nth(ownerOrdinal);
  await handleNode.scrollIntoViewIfNeeded();
  const handle = await handleNode.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + 80, handle.y + 30, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await readSource(), before, 'cancelled dragging leaves every byte intact');
  assert.equal(await page.locator('.notebook-cell').count(), initialCells);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.locator('.notebook-cell').last().scrollIntoViewIfNeeded();
  const tail = await page.locator('.notebook-cell').last().boundingBox();
  await page.mouse.move(tail.x + 40, tail.y + tail.height - 2, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.visual-image')?.getAttribute('data-cell-owner') === [...document.querySelectorAll('.notebook-cell')].at(-1)?.getAttribute('data-cell-index'));
  const moved = await readSource();
  assert.ok(moved.indexOf('Tail END') < moved.lastIndexOf('% ModuTeX cell begin', moved.indexOf('\\includegraphics')));
  assert.match(moved, /\\textcolor\[HTML\]\{B42318\}/);
  assert.match(moved, /\\textbf\{/); assert.match(moved, /\\underline\{/);
  assert.match(moved, /\\frac\{1\}\{2\}/);
  assert.equal(await page.locator('.notebook-cell').count(), initialCells);
  await page.locator('.ProseMirror').press('Control+z');
  await page.waitForFunction(() => [...document.querySelectorAll('.notebook-cell')].at(-1)?.textContent.includes('Tail END'));
  assert.equal(await readSource(), before, 'drag undo restores the complete mixed cell');
  await page.locator('.ProseMirror').press('Control+Shift+z');
  await page.waitForFunction(() => document.querySelector('.visual-image')?.getAttribute('data-cell-owner') === [...document.querySelectorAll('.notebook-cell')].at(-1)?.getAttribute('data-cell-index'));
  assert.equal(await readSource(), moved);
  await page.locator('.visual-image-content').click(); await page.keyboard.press('Escape');
  await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.dismiss()), page.keyboard.press('Delete')]);
  assert.equal(await readSource(), moved, 'cancel leaves the complete mixed cell intact');
  await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.accept()), page.keyboard.press('Delete')]);
  await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells - 1);
  assert.ok(!(await readSource()).includes('\\includegraphics'));
  assert.match(await readSource(), /Tail END/);
  await page.locator('.ProseMirror').press('Control+z');
  await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells);
  assert.equal(await readSource(), moved, 'deletion undo restores formatting, math and image together');
  for (const direction of ['上方', '下方']) {
   await page.locator('.visual-image-content').click();
   await page.getByTitle(`在${direction}插入`, { exact: true }).click();
   await page.locator('.cell-insert-wrap.open').getByRole('button', { name: '文字', exact: true }).click();
   await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells + 1);
   const inserted = await readSource();
   assert.match(inserted, /\\includegraphics/);
   assert.match(inserted, /Tail END/);
   await page.locator('.ProseMirror').press('Control+z');
   await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells);
   assert.equal(await readSource(), moved, 'insertion undo restores the complete document');
   await page.locator('.ProseMirror').press('Control+Shift+z');
   await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells + 1);
   assert.equal(await readSource(), inserted);
   const blankIndex = await page.locator('.notebook-cell.source-block').evaluateAll(nodes => nodes.find(node => !node.textContent.trim())?.getAttribute('data-cell-index'));
   assert.ok(blankIndex, 'new text cell has an editable empty body');
   await page.locator(`.notebook-cell[data-cell-index="${blankIndex}"]`).click();
   const newText = `新增 New ${direction}`;
   await page.keyboard.insertText(newText);
   await page.waitForFunction(text => [...document.querySelectorAll('.notebook-cell')].some(node => node.textContent === text), newText);
   assert.equal(await page.locator('.notebook-cell').count(), initialCells + 1);
   const typed = await readSource(); assert.ok(typed.includes(newText));
   await page.locator('.ProseMirror').press('Control+z');
   await page.waitForFunction(text => ![...document.querySelectorAll('.notebook-cell')].some(node => node.textContent === text), newText);
   assert.equal(await readSource(), inserted);
   await page.locator('.ProseMirror').press('Control+Shift+z');
   await page.waitForFunction(text => [...document.querySelectorAll('.notebook-cell')].some(node => node.textContent === text), newText);
   assert.equal(await readSource(), typed);
   await page.locator('.ProseMirror').press('Control+z');
   await page.waitForFunction(text => ![...document.querySelectorAll('.notebook-cell')].some(node => node.textContent === text), newText);
   await page.locator('.ProseMirror').press('Control+z');
   await page.waitForFunction(count => document.querySelectorAll('.notebook-cell').length === count, initialCells);
   assert.equal(await readSource(), moved);
  }
  await page.getByRole('button', { name: '原始碼', exact: true }).click();
  await page.getByRole('button', { name: '視覺化', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.visual-image img')?.naturalWidth === 120);
  assert.equal(await page.locator('.notebook-cell').count(), initialCells);
  assert.deepEqual(errors, []);
  } catch (error) { console.error(`${kind}/${format}: ${error.stack}`); console.error(await page.evaluate(() => ({ selection: window.getSelection()?.toString(), cells: [...document.querySelectorAll('.notebook-cell')].map(node => ({index:node.getAttribute('data-cell-index'),html:node.innerHTML.slice(0,1800)})), alerts: [...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent) }))); throw error; }
 })));
});
