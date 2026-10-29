import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const frontend = path.resolve(import.meta.dirname, '../..');
test('production PdfView paints embedded Chinese glyphs without remote resources', { timeout: 60000 }, async t => {
 const directory = await mkdtemp(path.join(frontend, '.pdf-chinese-'));
 let server, browser;
 t.after(async () => { await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); });
 const bytes = [...await readFile(path.join(frontend, 'tests/helpers/chinese.pdf'))];
 await writeFile(path.join(directory, 'Harness.svelte'), `<script>
 import PdfView from '../src/features/pdf/PdfView.svelte';
 const bytes = new Uint8Array(${JSON.stringify(bytes)});
 window.result = { renders: 0, errors: [] };
 </script><div style="width:595px;height:900px"><PdfView {bytes} onRendered={() => window.result.renders++} onError={e => window.result.errors.push(e)} onPageCount={() => {}} /></div>`);
 await writeFile(path.join(directory, 'main.js'), "import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness,{target:document.body});");
 await writeFile(path.join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
 server = await createServer({ root: directory, configFile: false, plugins: [svelte()], server: { host: '127.0.0.1', port: 0, fs: { allow: [path.resolve(frontend, '../..')] } }, logLevel: 'error' });
 await server.listen();
 browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
 const page = await browser.newPage();
 const warnings = [], failures = [], external = [];
 page.on('console', message => { if (['warning','error'].includes(message.type())) warnings.push(message.text()); });
 page.on('pageerror', error => failures.push(error.message));
 await page.route('**/*', route => { const url = new URL(route.request().url()); if (!['127.0.0.1','localhost'].includes(url.hostname) && url.protocol !== 'data:' && url.protocol !== 'blob:') { external.push(url.href); return route.abort(); } return route.continue(); });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
 await page.waitForFunction(() => window.result.renders > 0);
 if (process.env.MODUTEX_PDF_PROOF_DIR) {
  await page.screenshot({ path: path.join(process.env.MODUTEX_PDF_PROOF_DIR, 'preview.png') });
  console.log(warnings);
  console.log(await page.locator('canvas').evaluate(canvas => {
   const {width:w,height:h}=canvas, data=canvas.getContext('2d').getImageData(0,0,w,h).data, rows=[];
   for(let y=0;y<h;y++){let n=0;for(let x=0;x<w;x++){const i=(y*w+x)*4;if(data[i]<128&&data[i+3])n++;}if(n)rows.push([y,n]);}return {w,h,rows};
  }));
 }
 const ink = await page.locator('canvas').evaluate(canvas => {
  const ctx = canvas.getContext('2d'), { width: w, height: h } = canvas;
  const data = ctx.getImageData(Math.floor(w*.21), Math.floor(h*.15), Math.floor(w*.13), Math.floor(h*.035)).data;
  let dark = 0; for (let i=0;i<data.length;i+=4) if (data[i+3] && data[i]<128 && data[i+1]<128 && data[i+2]<128) dark++;
  return dark;
 });
 assert.ok(ink > 30, `Chinese-only first row must paint ink, got ${ink}`);
 assert.deepEqual(await page.evaluate(() => window.result.errors), []);
 assert.deepEqual(failures, []);
 assert.deepEqual(external, []);
 assert.ok(!warnings.some(text => /CMap|Unable to load font|Error during font/i.test(text)), warnings.join('\n'));
});
