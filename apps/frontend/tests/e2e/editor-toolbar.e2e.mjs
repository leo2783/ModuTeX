// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const frontend = path.join(repository, 'apps/frontend');
const modulePath = value => value.replaceAll('\\', '/');
const sourceText = '\ufeff\\documentclass{article}\r\n\\begin{document}\r\n\\section{Heading}\r\nBefore plain after.\r\n\\section{Math}\r\nInline $x^2$ after.\r\n\r\n\\[y^2\\]\r\nTail.\r\n\\par\\textbf{\\textit{\\underline{你知道嗎}}}\r\n\\end{document}\r\n';

test('real toolbar toggles, math Backspace, byte-exact undo and responsive close dialog', { timeout: 90_000 }, async () => {
 const fixture = await mkdtemp(path.join(repository, '.verification-artifacts', 'editor-toolbar-'));
 let server, browser;
 const errors = [];
 try {
  await writeFile(path.join(fixture, 'Harness.svelte'), `<script>
import SourceView from ${JSON.stringify(modulePath(path.join(frontend, 'src/features/source-editor/SourceView.svelte')))};
import CloseDialog from ${JSON.stringify(modulePath(path.join(frontend, 'src/components/CloseDialog.svelte')))};
import { SourceDocument } from ${JSON.stringify(modulePath(path.join(frontend, 'src/features/document-core/core.ts')))};
import ${JSON.stringify(modulePath(path.join(frontend, 'src/styles/base.css')))};
let source = $state.raw(SourceDocument.open(new TextEncoder().encode(${JSON.stringify(sourceText)})));
let showClose = $state(false), language = $state('en');
export function snapshot() { return { text: source.read(), bytes: Array.from(source.toBytes()) }; }
export function closeDialog(lang) { language = lang; showClose = true; }
</script>
<div style="height:650px"><SourceView document={source} label="main.tex" saving={false} savedVersion={null} onChange={next => source = next} onRejected={() => { throw new Error('Rejected source edit'); }} onVisualRejected={() => { throw new Error('Rejected visual edit'); }} onProjection={() => {}} onParserFailure={() => { throw new Error('Parser failed'); }} /></div>
{#if showClose}<CloseDialog t={(zh, en) => language === 'zh' ? zh : en} name="main.tex" saving={false} error="" save={() => showClose = false} discard={() => showClose = false} cancel={() => showClose = false} />{/if}`);
  await writeFile(path.join(fixture, 'entry.js'), `import { mount } from 'svelte'; import Harness from './Harness.svelte'; window.testHost = mount(Harness, { target: document.getElementById('app') });`);
  await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><body><main id="app"></main><script type="module" src="./entry.js"></script></body></html>');
  server = await createServer({ root: frontend, configFile: false, plugins: [svelte()], worker: { format: 'es' }, cacheDir: path.join(repository, 'node_modules/.vite/editor-toolbar'), server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${modulePath(path.join(fixture, 'index.html'))}`);
  const paragraph = page.locator('.source-block').filter({ hasText: 'Before' });
  await paragraph.waitFor();
  const original = await page.evaluate(() => window.testHost.snapshot());
  const checkpoints = [original];
  const initialHeight = await paragraph.evaluate(el => el.getBoundingClientRect().height);
  await paragraph.evaluate(el => {
   el.closest('.ProseMirror').focus();
   const text = [...el.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes('Before'));
   const range = document.createRange(); const from = text.textContent.indexOf('Before');
   range.setStart(text, from); range.setEnd(text, from + 6);
   const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  for (const label of ['粗體', '斜體', '底線']) {
   for (const active of [true, false, true, false]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const command = { 粗體: 'textbf', 斜體: 'textit', 底線: 'underline' }[label];
    await page.waitForFunction(({command, active}) => window.testHost.snapshot().text.includes('\\' + command + '{Before}') === active, {command, active});
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true' && window.getSelection().toString() === 'Before');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Before');
    assert.equal(await paragraph.evaluate(el => el.getBoundingClientRect().height), initialHeight);
    checkpoints.push(await page.evaluate(() => window.testHost.snapshot()));
   }
   assert.deepEqual((await page.evaluate(() => window.testHost.snapshot())).bytes, original.bytes);
  }
  // Keep the same focused editor through multiple parser-driven history updates.
  for (const index of [11, 10, 9]) {
   await page.keyboard.press('Control+z');
   await page.waitForFunction(expected => window.testHost.snapshot().text === expected, checkpoints[index].text);
   await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
   assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true, 'undo must retain editor focus');
  }
  for (const index of [10, 11, 12]) {
   await page.keyboard.press('Control+Shift+z');
   await page.waitForFunction(expected => window.testHost.snapshot().text === expected, checkpoints[index].text);
   await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
   assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true, 'redo must retain editor focus');
  }
  const inline = page.locator('.visual-math-inline');
  await inline.evaluate(el => {
   el.closest('.ProseMirror').focus();
   const range = document.createRange(); range.setStartAfter(el); range.collapse(true);
   const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !window.testHost.snapshot().text.includes('$x^2$'));
  assert.equal((await page.evaluate(() => window.testHost.snapshot())).text, original.text.replace('$x^2$', ''));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.testHost.snapshot().text.includes('$x^2$'));
  await page.locator('.ProseMirror[contenteditable="true"] .visual-math-inline').waitFor();
  assert.deepEqual((await page.evaluate(() => window.testHost.snapshot())).bytes, original.bytes);
  await page.locator('figure.visual-math').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !window.testHost.snapshot().text.includes('\\[y^2\\]'));
  assert.equal((await page.evaluate(() => window.testHost.snapshot())).text, original.text.replace('\\[y^2\\]', ''));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.testHost.snapshot().text.includes('\\[y^2\\]'));
  assert.deepEqual((await page.evaluate(() => window.testHost.snapshot())).bytes, original.bytes);
  await page.locator('.ProseMirror[contenteditable="true"] .visual-math-inline').waitFor();
  await page.locator('.visual-math-inline button').click();
  const mathInput = page.locator('.inline-equation-input math-field'); await mathInput.waitFor();
  await mathInput.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
  assert.equal(await mathInput.evaluate(el => el.value), '');
  await page.getByRole('button', {name:'展開數學選單',exact:true}).click();
  await page.locator('.catalog-search').fill('偏導數');
  await page.getByRole('button', {name:'偏導數',exact:true}).click();
  await page.keyboard.type('2');
  assert.match(await mathInput.evaluate(el => el.value), /\\partial\s*x/);
  await page.getByRole('button', {name:'取消公式',exact:true}).click();
  const markedParagraph = page.locator('.source-block').filter({hasText:'你知道嗎'});
  await markedParagraph.evaluate(el => {
   el.closest('.ProseMirror').focus();
   const text = el.querySelector('u').firstChild;
   const range = document.createRange(); range.setStart(text, text.textContent.length); range.collapse(true);
   const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.ProseMirror') && document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true, 'Enter must keep editor focus');
  await page.keyboard.insertText('接續下一行');
  await page.waitForFunction(() => window.testHost.snapshot().text.includes('接續下一行'));
  assert.match((await page.evaluate(() => window.testHost.snapshot())).text, /接續下一行/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.ProseMirror') && document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
  await page.keyboard.insertText('第三行');
  await page.waitForFunction(() => window.testHost.snapshot().text.includes('第三行'));
  assert.equal(await markedParagraph.evaluate(el => el.textContent.trim()), '你知道嗎\n接續下一行\n第三行');
  assert.equal(await markedParagraph.locator('strong em u').count(), 3);
  const enteredSource = (await page.evaluate(() => window.testHost.snapshot())).text;
  assert(enteredSource.includes('}}}\\\\\\textbf{\\textit{\\underline{接續下一行}}}\\\\\\textbf{\\textit{\\underline{第三行}}}'));
  await mkdir(path.join(repository, '.verification-artifacts/enter-compile'), {recursive:true});
  await writeFile(path.join(repository, '.verification-artifacts/enter-compile/keyboard.tex'), enteredSource.replace('\\documentclass{article}', '\\documentclass{article}\n\\usepackage[fontset=none]{ctex}\n\\setCJKmainfont[AutoFakeBold=2,AutoFakeSlant=0.2]{SimSun}'));
  for (let index = 0; index < 8; index++) {
   await page.keyboard.press('Enter');
   await page.waitForFunction(() => document.activeElement === document.querySelector('.ProseMirror') && document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
  }
  for (let index = 0; index < 3; index++) {
   const before = await page.locator('.ProseMirror > .notebook-cell').count();
   const boundaries = page.locator('.ProseMirror > .visual-cell-boundary');
   const boundary = index === 1 ? boundaries.nth((await boundaries.count()) - 2) : boundaries.last();
   await boundary.locator('.boundary-trigger').click();
   await boundary.getByRole('button',{name:/^(插入文字段落|Insert text paragraph)$/}).click();
   await page.waitForFunction(count => document.querySelectorAll('.ProseMirror > .notebook-cell').length > count, before);
   assert.equal(await page.locator('.ProseMirror > .notebook-cell').count(), before + 1, 'one add action creates exactly one cell');
   const empty = page.locator('.ProseMirror > .source-block').last();
   const size = await empty.evaluate(el => ({text:el.textContent,height:el.getBoundingClientRect().height,lineHeight:Number.parseFloat(getComputedStyle(el).lineHeight)}));
   assert.equal(size.text, '');
   assert(size.height <= size.lineHeight + 12, 'new cells must start at a single line');
   if (index === 2) {
    await page.keyboard.insertText('新儲存格');
    await page.waitForFunction(() => window.testHost.snapshot().text.includes('新儲存格'));
    const filled = await empty.evaluate(el => ({text:el.textContent,height:el.getBoundingClientRect().height,lineHeight:Number.parseFloat(getComputedStyle(el).lineHeight)}));
    assert.equal(filled.text,'新儲存格');
    assert(filled.height <= filled.lineHeight + 12,'typing into a new cell must not reveal source-only blank rows');
   }
  }
  for (const [language, width] of [['en', 1280], ['en', 360], ['zh', 1280], ['zh', 360]]) {
   await page.setViewportSize({ width, height: 800 });
   await page.evaluate(lang => window.testHost.closeDialog(lang), language);
   const dialog = page.getByRole('dialog'); await dialog.waitFor();
   const layout = await dialog.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { overflow: el.scrollWidth > el.clientWidth, left: rect.left, right: rect.right, buttons: [...el.querySelectorAll('button')].map(button => ({height:button.getBoundingClientRect().height, top:button.getBoundingClientRect().top})) };
   });
   assert.equal(layout.overflow, false); assert(layout.left >= 0 && layout.right <= width);
   assert(layout.buttons.every(button => button.height >= 40));
   if (width > 420) assert.equal(new Set(layout.buttons.map(button => button.top)).size, 1);
   await page.screenshot({ path: path.join(repository, `.verification-artifacts/close-dialog-${language}-${width}.png`) });
   await page.getByRole('button', {name:language === 'zh' ? '取消' : 'Cancel', exact:true}).click();
  }
  assert.deepEqual(errors, []);
 } finally {
  await browser?.close(); await server?.close();
  const owned = path.relative(path.join(repository, '.verification-artifacts'), fixture);
  assert(owned.startsWith('editor-toolbar-') && !owned.includes(path.sep) && !owned.includes('..'));
  await rm(fixture, {recursive:true, force:true});
 }
});
