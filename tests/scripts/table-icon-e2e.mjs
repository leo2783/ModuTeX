// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {assertNoUiEmoji} from './helpers/assert-no-ui-emoji.mjs';
const root=fileURLToPath(new URL('../../apps/frontend',import.meta.url));
const evidence=fileURLToPath(new URL('../../.verification-artifacts/tauri',import.meta.url));
test('table resize uses real SVG and retains keyboard and pointer interaction', {timeout:60000},async()=>{
 await mkdir(evidence,{recursive:true});
 const server=await createServer({root,cacheDir:evidence+'vite-ui',server:{host:'127.0.0.1',port:0}});let browser;
 try{await server.listen();browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});const page=await browser.newPage({viewport:{width:1280,height:850},colorScheme:'dark'});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.getByRole('button',{name:'新文件',exact:true}).waitFor({state:'visible'});
  await assertNoUiEmoji(page);
  await page.getByRole('button',{name:'新文件',exact:true}).click();
  await page.locator('.insert-bar').getByRole('button',{name:'表格',exact:true}).click();
  const handle=page.locator('.column-boundary').first();await handle.waitFor({state:'visible'});
  await assertNoUiEmoji(page);
  assert.equal(await handle.locator('svg path').count(),1);
  assert(['none','normal','""'].includes(await handle.locator('span').evaluate(e=>getComputedStyle(e,'::before').content)));
  const left=()=>handle.evaluate(e=>parseFloat(e.style.left));const before=await left();await handle.focus();await page.keyboard.press('ArrowRight');assert((await left())>before);await page.keyboard.press('ArrowLeft');assert(Math.abs((await left())-before)<0.001);
  const box=await handle.boundingBox();assert(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+18,box.y+box.height/2,{steps:4});await page.mouse.up();assert((await left())>before);
  await page.screenshot({path:evidence+'table-svg-resize-dark.png'});await page.emulateMedia({colorScheme:'light'});assert.equal(await handle.locator('svg').count(),1);await page.screenshot({path:evidence+'table-svg-resize-light.png'});
 }finally{if(browser)await browser.close();await server.close()}
});
