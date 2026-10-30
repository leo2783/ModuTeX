// SPDX-License-Identifier: Apache-2.0
// Real native picker, persisted profiles, real Tectonic and unchanged active include.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve,basename,toNamespacedPath} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import { clickFileAction } from './helpers/app-file-actions.mjs';
import { createNativeCdpConfig } from './helpers/native-cdp-config.mjs';
import { waitNativeCdp } from './helpers/wait-native-cdp.mjs';
import { articleText, articleChunks } from '../../apps/frontend/tests/helpers/mixed-article.mjs';
const root=resolve(import.meta.dirname,'../..'),evidence=join(root,'.verification-artifacts/tauri');
const exe=resolve(process.env.MODUTEX_TEST_EXE??join(root,'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe'));
const coldCache = process.env.MODUTEX_TEST_COLD_CACHE === '1';
if (coldCache) {
 assert(process.env.MODUTEX_TEST_CACHE_DIR, 'cold acceptance requires an explicit isolated cache path');
 const exists = await access(process.env.MODUTEX_TEST_CACHE_DIR).then(() => true, error => {
  if (error.code !== 'ENOENT') throw error;
  return false;
 });
 assert.equal(exists, false, 'cold acceptance must start without a cache');
}
const scratch=await mkdtemp(join(tmpdir(),'modutex-compile-config-e2e-')),workspace=join(scratch,`project \u6e2c\u8a66 ${basename(scratch)}`);await mkdir(join(workspace,'out'),{recursive:true});
await writeFile(join(workspace,'standalone.tex'),'\\documentclass{article}\n\\author{}\\date{}\n\\begin{document}Unconfigured main test. 我你\n\\end{document}\n');
await writeFile(join(workspace,'warning.tex'),'\\documentclass{article}\n\\title{Warning 警告}\\date{}\n\\begin{document}\\maketitle\n中文 English\n\\end{document}\n');
await writeFile(join(workspace,'main.tex'),"\\documentclass{article}\n\\usepackage{amsmath}\n\\title{Cell safety}\n\\author{}\n\\date{}\n\\begin{document}\n\\maketitle\nMain document.\n\\[\\frac{\\partial^2 f}{\\partial x^2}\\]\n\\input{chapter}\n\\end{document}\n");
const chapter='Included chapter material.\n';await writeFile(join(workspace,'chapter.tex'),chapter);
assert.equal([...articleText].length,5000);
for(const layout of ['single','multiple']){
 const formatted='\\textcolor[HTML]{B42318}{\\textbf{\\underline{Article 文章}}}';
 const pieces=[`\\title{${formatted}}\\maketitle\n\\begin{abstract}摘要 Abstract ${articleText.slice(0,1000)}\\end{abstract}`,`\\section{${formatted}}\n${articleText.slice(1000,2000)} \\(x^2\\)`,`\\subsection{${formatted}}\n${articleText.slice(2000,3000)} English`,`\\subsubsection{${formatted}}\n${articleText.slice(3000,4000)} \\(\\frac{1}{2}\\)`,`${articleText.slice(4000)}\n\\par\n文章插圖 Body`];
 const fence=text=>`% ModuTeX cell begin\n${text}\n% ModuTeX cell end\n`;
 const content=layout==='single'?fence(pieces.join('\n\\par\n')):pieces.map((piece,index)=>fence((index?'\\par\n':'')+piece)).join('');
 await writeFile(join(workspace,`article-${layout}.tex`),'\\documentclass{article}\n\\usepackage{amsmath,xcolor}\n\\author{}\\date{}\n\\begin{document}\n'+content+'\\par\nTail END\n\\end{document}\n');
}
const nativeCdp=await createNativeCdpConfig(join(scratch,'webview'));
const app=spawn(exe,[],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,...nativeCdp.env}});
let browser,page,stderr='',stage='launch',launchError;app.stderr.on('data',s=>stderr=(stderr+s).slice(-8192));app.once('error',e=>launchError=e);
const receipt={createdAt:new Date().toISOString(),exe,sha256:createHash('sha256').update(await readFile(exe)).digest('hex'),scope:'actual native profile UI, unset main compile, trusted custom command, output publication and selected included source preservation',status:'running',checks:[],pageErrors:[],watchFailures:[]};
const watchdog=setTimeout(()=>{if(app.pid)execFile('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true},()=>process.exit(1))},540000);
const exec=(file,args)=>new Promise((ok,fail)=>execFile(file,args,{cwd:root,windowsHide:true,timeout:35000},(e,out,err)=>e?fail(Error(`${e}: stdout=${out} stderr=${err} killed=${e.killed} signal=${e.signal}`)):ok(out.trim())));
async function documentTab(){const tab=page.getByRole('tab',{name:/^(文件|Document)$/});if(await tab.count())await tab.click();await page.getByRole('button',{name:/^(原始碼|Source)$/}).click();}
async function settings(){await page.locator('header').getByRole('link',{name:/^(設定|Settings)$/}).click();await page.getByRole('button',{name:/^(編譯|Compilation)$/}).click();await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).waitFor({state:'visible'});await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(e=>/儲存工作區編譯設定|Save workspace compile settings/.test(e.textContent));return b&&!b.disabled});}
async function workbench(){await page.getByRole('link',{name:/^(工作區|Workbench|工作台)$/}).click();}
async function assertManagedEngine(){
 const expected=process.env.MODUTEX_TEST_EXPECT_ENGINE;if(!expected)return;
 assert(Number.isSafeInteger(app.pid)&&app.pid>0);
 let observed=[];
 for(const until=Date.now()+15000;Date.now()<until;){
  const output=await exec(process.env.MODUTEX_TEST_PWSH??'pwsh.exe',['-NoProfile','-Command',`@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.pid}" | Where-Object Name -eq 'tectonic.exe' | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress`]);
  observed=output?JSON.parse(output):[];if(typeof observed==='string')observed=[observed];
  if(observed.length)break;await delay(100);
 }
 assert(observed.length,'managed compilation must launch an observable native Tectonic child');
 assert(observed.some(p=>toNamespacedPath(p).toLowerCase()===toNamespacedPath(resolve(expected)).toLowerCase()),'managed compile must use the engine extracted from the installer: '+JSON.stringify(observed));
 receipt.checks.push({packagedManagedEngine:resolve(expected),observed});
}
async function compile(cold = false){const started=performance.now();await page.getByRole('button',{name:/^(編譯 PDF|Compile PDF)$/}).click();await page.getByRole('button',{name:/^(取消編譯|Cancel compilation)$/}).waitFor({timeout:15000});if(cold)await assertManagedEngine();await page.waitForFunction(()=>/編譯完成|Compilation completed|編譯失敗|Compilation failed/.test(document.querySelector('.compile-status')?.textContent??''),null,{timeout:330000});assert.match(await page.locator('.compile-status').innerText(),/編譯完成|Compilation completed/,'real native compile must publish successfully');await page.waitForFunction(()=>/PDF 已更新|PDF updated/.test(document.querySelector('.compile-status')?.textContent??'')&&document.querySelector('.pdf-scroll')?.getAttribute('aria-busy')==='false',null,{timeout:20000});receipt.checks.push({compileMs:Math.round(performance.now()-started),coldCache:cold});}
try{
 await waitNativeCdp({ app, port:nativeCdp.port, evidence, lane: 'compile-config', stderr: () => stderr, launchError: () => launchError });
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${nativeCdp.port}`,{timeout:10000});for(const until=Date.now()+10000;Date.now()<until;){page=browser.contexts().flatMap(c=>c.pages())[0];if(page)break;await delay(50)}assert(page);page.on('pageerror',e=>receipt.pageErrors.push(e.message));
 await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
 await page.exposeFunction('recordNativeWatchFailure', value => receipt.watchFailures.push(value));
 await page.evaluate(async()=>{const api=window.__TAURI_INTERNALS__;await api.invoke('plugin:event|listen',{event:'frontend://files/error',target:{kind:'Any'},handler:api.transformCallback(event=>window.recordNativeWatchFailure(event.payload))});});
 stage='owned native folder picker';const selected=exec(process.env.MODUTEX_TEST_PWSH??'pwsh.exe',['-NoProfile','-File',join(root,'tests/scripts/helpers/select-owned-folder.ps1'),'-OwnedProcessId',String(app.pid),'-ExpectedExecutablePath',exe,'-FolderPath',workspace]);void selected.catch(()=>{});await clickFileAction(page, /^(開啟資料夾|Open folder)$/);await selected;await page.locator('.tree-file[title="standalone.tex"]').click();
 stage='persist unset main';await settings();await page.getByLabel(/主 TeX 文件|Main TeX file/).selectOption('');await page.getByLabel(/編譯引擎設定檔|Engine profile/).selectOption('managed');await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).click();await workbench();
 stage='watch after compile settings navigation';await writeFile(join(workspace,'watch-before.txt'),'native watch before compile\n');await page.locator('.tree-file[title="watch-before.txt"]').waitFor({state:'visible',timeout:10000});receipt.checks.push('external file changes arrive after compile settings navigation');
 if(process.env.MODUTEX_TEST_PERIODIC_WATCH==='1'){stage='watch after the native periodic reconcile';await delay(65000);await writeFile(join(workspace,'watch-periodic.txt'),'native watch after periodic reconcile\n');await page.locator('.tree-file[title="watch-periodic.txt"]').waitFor({state:'visible',timeout:10000});assert.deepEqual(receipt.watchFailures,[]);receipt.checks.push('native watch survives the real 60-second periodic reconcile');}
 stage='real managed compile of active unset main';await compile(coldCache);receipt.checks.push('unset configured main compiles active saved TeX with real managed engine');
 await page.getByRole('tab',{name:/^(問題|Problems)/}).click();
 assert.equal(await page.locator('.diagnostic-row').count(),0,'ordinary CTEX initialization must not populate Problems');
 await page.getByRole('tab',{name:/^(輸出|Output)$/}).click();
 assert.match(await page.locator('.compile-output').innerText(),/LaTeX (?:Font )?Info:/,'initialization evidence remains in the real compiler log');
 receipt.checks.push('native Problems is empty for clean CTEX compilation while Output preserves initialization details');
 const siblingPdf=await readFile(join(workspace,'standalone.pdf'));assert.equal(siblingPdf.subarray(0,5).toString(),'%PDF-');receipt.checks.push('default managed compilation saves its PDF beside the TeX file without output settings');
 stage='real warning remains actionable without package information noise';
 await page.locator('.tree-file[title="warning.tex"]').click();await compile();
 await page.getByRole('tab',{name:/^(問題|Problems)/}).click();
 assert.equal(await page.locator('.diagnostic-row').count(),1);
 assert.equal(await page.locator('.diagnostic-severity').getAttribute('data-severity'),'warning');
 assert.match(await page.locator('.diagnostic-text').innerText(),/No \\author given/);
 receipt.checks.push('real missing-author warning remains visible while package Info is absent from Problems');
 await page.locator('.tree-file[title="standalone.tex"]').click();
 stage='native image insertion, cancellation and invalid input';
 await documentTab();
 const imageSourceEditor=page.locator('.cm-content[contenteditable="true"]').first();
 const beforeImages=(await imageSourceEditor.locator('.cm-line').allTextContents()).join('\n');
 await page.getByRole('button',{name:/^(視覺化|Visual)$/}).click();
 const imageInput=page.getByLabel(/^(選擇圖片|Choose image)$/);
 const imageVisualEditor=page.locator('.visual .ProseMirror[contenteditable="true"]');
 await imageInput.setInputFiles([]);
 assert.equal(await page.locator('.visual-image').count(),0);
 await imageInput.setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not a PNG image')});
 await page.locator('.tool-error').waitFor({state:'visible'});
 assert.equal((await imageSourceEditor.locator('.cm-line').allTextContents()).join('\n'),beforeImages,'invalid image must not mutate source');
 for(const [extension,type] of [['png','image/png'],['jpg','image/jpeg']]){
  const encoded=await page.evaluate(type=>{const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle=type==='image/png'?'#3d617b':'#bc4539';ctx.fillRect(0,0,120,80);return canvas.toDataURL(type).split(',')[1]},type);
  // End only reaches the current wrapped line; inserting there splits the locator's prose.
  await imageVisualEditor.focus();
  await page.keyboard.press('Control+End');
  await imageInput.setInputFiles({name:`original.${extension}`,mimeType:type,buffer:Buffer.from(encoded,'base64')});
  await page.waitForFunction(count=>document.querySelectorAll('.visual-image img').length===count&&[...document.querySelectorAll('.visual-image img')].every(img=>img.naturalWidth===120),extension==='png'?1:2);
 }
 stage='native image shared undo and redo';
 await imageVisualEditor.focus();
 await page.keyboard.press('Control+z');
 await page.waitForFunction(()=>document.querySelectorAll('.visual-image').length===1);
 await page.keyboard.press('Control+Shift+z');
 await page.waitForFunction(()=>document.querySelectorAll('.visual-image img').length===2);
 await page.keyboard.press('Control+s');
 await page.waitForFunction(()=>!document.querySelector('.source-view')?.textContent?.includes('儲存中'));
 let savedImages='';
 for(const until=Date.now()+10000;Date.now()<until;){try{savedImages=await readFile(join(workspace,'standalone.tex'),'utf8');if((savedImages.match(/\\includegraphics/g)||[]).length===2)break}catch(error){if(!['EBUSY','ENOENT'].includes(error.code))throw error}await delay(100)}
 assert.equal((savedImages.match(/\\includegraphics/g)||[]).length,2,'both image references must actually reach disk');
 assert.ok(savedImages.includes('Unconfigured main test. 我你'),'image insertion must preserve the complete original paragraph');
 const imagePaths=[...savedImages.matchAll(/\\includegraphics\[[^\]]*\]\{([^}]+)\}/g)].map(match=>match[1]);
 for(const imagePath of imagePaths)assert((await readFile(join(workspace,imagePath))).length>12,'image asset must exist beside saved TeX');
 stage='native image reopen and real PDF rendering';
 await page.locator('.tree-file[title="chapter.tex"]').click();
 await page.locator('.tree-file[title="standalone.tex"]').click();
 await page.getByRole('button',{name:/^(視覺化|Visual)$/}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.visual-image img').length===2&&[...document.querySelectorAll('.visual-image img')].every(img=>img.naturalWidth===120));
 await compile();
 await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].some(canvas=>{const ctx=canvas.getContext('2d');if(!ctx)return false;const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let blue=0,red=0;for(let i=0;i<data.length;i+=4){if(Math.abs(data[i]-61)<12&&Math.abs(data[i+1]-97)<12&&Math.abs(data[i+2]-123)<12)blue++;if(Math.abs(data[i]-188)<12&&Math.abs(data[i+1]-69)<12&&Math.abs(data[i+2]-57)<12)red++;}return blue>100&&red>100}));
 await page.screenshot({path:join(evidence,'compile-images-native-e2e.png')});
 receipt.checks.push('real native PNG/JPEG insertion rejects corrupt input, cancellation preserves source, shared undo/redo works, saves original assets, reopens them and paints image pixels in a real compiled PDF');
 for(const layout of ['single','multiple']){
  stage=`5000-character ${layout}-cell article native persistence and PDF`;
  const name=`article-${layout}.tex`,expectedCells=layout==='single'?2:6,originals=new Map();
  const originalSource=await readFile(join(workspace,name),'utf8');
  await page.locator(`.tree-file[title="${name}"]`).click();
  await page.getByRole('button',{name:/^(視覺化|Visual)$/}).click();
  await page.waitForFunction(count=>document.querySelectorAll('.notebook-cell').length===count,expectedCells);
  for(const [extension,type] of [['png','image/png'],['jpg','image/jpeg']]){
   const encoded=await page.evaluate(type=>{const c=document.createElement('canvas');c.width=120;c.height=80;const ctx=c.getContext('2d');ctx.fillStyle=type==='image/png'?'#3d617b':'#bc4539';ctx.fillRect(0,0,120,80);return c.toDataURL(type).split(',')[1]},type);
   const bytes=Buffer.from(encoded,'base64');originals.set(extension,bytes);
   await page.locator('.source-block').filter({hasText:'文章插圖 Body'}).click();await page.keyboard.press('End');
   await page.getByLabel(/^(選擇圖片|Choose image)$/).setInputFiles({name:`article.${extension}`,mimeType:type,buffer:bytes});
   await page.waitForFunction(count=>document.querySelectorAll('.visual-image img').length===count&&[...document.querySelectorAll('.visual-image img')].every(img=>img.naturalWidth===120),extension==='png'?1:2);
   assert.equal(await page.locator('.notebook-cell').count(),expectedCells,'inserting a picture must not add a user cell');
  }
  await page.keyboard.press('Control+s');
  let saved='';
  for(const until=Date.now()+10000;Date.now()<until;){try{saved=await readFile(join(workspace,name),'utf8');if((saved.match(/\\includegraphics/g)||[]).length===2)break}catch(error){if(!['EBUSY','ENOENT'].includes(error.code))throw error}await delay(100)}
  const paths=[...saved.matchAll(/\\includegraphics\[[^\]]*\]\{([^}]+)\}/g)].map(match=>match[1]);assert.equal(paths.length,2);
  assert.equal((saved.match(/\p{Script=Han}/gu)||[]).length,(originalSource.match(/\p{Script=Han}/gu)||[]).length,'saved article retains every Chinese character');
  for(const chunk of articleChunks)assert.ok(saved.includes(chunk),'saved bilingual article retains every numbered paragraph');
  for(const imagePath of paths)assert.deepEqual(await readFile(join(workspace,imagePath)),originals.get(imagePath.endsWith('.png')?'png':'jpg'),'native asset retains original image bytes');
  await page.locator('.tree-file[title="chapter.tex"]').click();await page.locator(`.tree-file[title="${name}"]`).click();
  await page.waitForFunction(count=>document.querySelectorAll('.notebook-cell').length===count&&document.querySelectorAll('.visual-image img').length===2&&[...document.querySelectorAll('.visual-image img')].every(img=>img.naturalWidth===120),expectedCells);
  await compile();
  await page.getByRole('tab',{name:/^(問題|Problems)/}).click();
  assert.ok(!(await page.locator('.diagnostic-text').allTextContents()).some(text=>/Missing character|There is no .*U\+/i.test(text)),'article glyphs including 我你葳 must not be missing');
  const number=page.locator('.pdf-controls input[type="number"]'),count=Number(await number.getAttribute('max'));assert.ok(count>1,'long article must exercise multiple PDF pages');
  let blue=0,red=0;
  for(let index=1;index<=count;index++){
   await number.fill(String(index));await number.press('Tab');
   await page.waitForFunction(index=>{const canvas=document.querySelector('.pdf-view canvas');return document.querySelector('.pdf-scroll')?.getAttribute('aria-busy')==='false'&&new RegExp(`(?:第 ${index} 頁|page ${index}$)`).test(canvas?.getAttribute('aria-label')??'')},index);
   const ink=await page.locator('.pdf-view canvas').evaluate(canvas=>{const d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let blue=0,red=0;for(let i=0;i<d.length;i+=4){if(Math.abs(d[i]-61)<12&&Math.abs(d[i+1]-97)<12&&Math.abs(d[i+2]-123)<12)blue++;if(Math.abs(d[i]-188)<12&&Math.abs(d[i+1]-69)<12&&Math.abs(d[i+2]-57)<12)red++;}return {blue,red}});
   blue+=ink.blue;red+=ink.red;
   if(ink.blue>100||ink.red>100)await page.screenshot({path:join(evidence,`article-${layout}-page-${index}-native-e2e.png`)});
  }
  assert.ok(blue>100&&red>100,`both original image formats must paint in ${layout} article PDF: blue=${blue},red=${red}`);
  receipt.checks.push({articleLayout:layout,bodyCharacters:5000,cells:expectedCells,pdfPages:count,pngPixels:blue,jpegPixels:red,originalAssetBytesVerified:true,reopenedFromDisk:true,missingGlyphs:false});
 }
 stage='watch after managed compilation';await writeFile(join(workspace,'watch-after.txt'),'native watch after compile\n');await page.locator('.tree-file[title="watch-after.txt"]').waitFor({state:'visible',timeout:10000});assert.deepEqual(receipt.watchFailures,[]);receipt.checks.push('native watch remains live after managed compilation');
 stage='save trusted UI custom profile';await settings();await page.getByLabel(/主 TeX 文件|Main TeX file/).selectOption('main.tex');await page.getByLabel(/編譯引擎設定檔|Engine profile/).selectOption('custom');
 const tectonic=join(root,'vendor/tectonic/windows-x64/tectonic.exe');await page.getByLabel(/受信任的命令範本|Trusted command template/).fill(`"${tectonic}" --outdir {out} --keep-logs {main}`);await page.getByLabel(/^輸出目錄|^Output directory/).fill('out');await page.getByLabel(/^PDF 路徑|^PDF path/).fill('out/result.pdf');await page.getByLabel(/^記錄|^Log path|^日誌/).fill('out/result.log');await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).click();
 await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(value=>/^(套用頁邊距|Apply margins)$/.test(value.textContent));return button&&!button.disabled});
 for(const [side,value] of Object.entries({top:'1.5',bottom:'2.5',left:'3',right:'4'}))await page.locator('#compile-margin-'+side).fill(value);
 await page.getByRole('button',{name:/^(套用頁邊距|Apply margins)$/}).click();
 for(const until=Date.now()+10000;Date.now()<until;){try{if((await readFile(join(workspace,'main.tex'),'utf8')).includes('left=3cm'))break}catch(error){if(!['EBUSY','ENOENT'].includes(error.code))throw error}await delay(50)}
 const configuredMain=await readFile(join(workspace,'main.tex'),'utf8');assert.match(configuredMain,/top=1\.5cm,bottom=2\.5cm,left=3cm,right=4cm/);receipt.checks.push('four margin controls update the configured main file without changing the active source');await workbench();
 stage='save main document identity before compiling from an include';
 await page.locator('.tree-file[title="main.tex"]').click();await documentTab();
 const mainEditor=page.locator('.cm-content[contenteditable="true"]').first();await mainEditor.waitFor({state:'visible'});
 await mainEditor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% saved main identity acceptance\n');await page.keyboard.press('Control+s');
 let mainSaved=false;
 for(const until=Date.now()+10000;Date.now()<until;){try{if((await readFile(join(workspace,'main.tex'),'utf8')).includes('% saved main identity acceptance')){mainSaved=true;break;}}catch(error){if(!['EBUSY','ENOENT'].includes(error.code))throw error}await delay(100);}
 assert(mainSaved,'main identity regression requires a real successful UI save');
 receipt.checks.push('main document has a persisted editor identity before child-triggered compilation');
 stage='compile configured main from active include';await page.locator('.tree-file[title="chapter.tex"]').click();await documentTab();const editor=page.locator('.cm-content[contenteditable="true"]').first();await editor.waitFor({state:'visible'});const before=await editor.textContent();assert(before.includes('Included chapter'));await editor.click();await page.keyboard.press('Control+End');await compile();
 assert.equal(await page.locator('.tree-file[aria-current="true"]').getAttribute('title'),'chapter.tex');await documentTab();assert.equal(await editor.textContent(),before);assert.equal(await readFile(join(workspace,'chapter.tex'),'utf8'),chapter);
 const pdf=await readFile(join(workspace,'out/result.pdf'));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert((await readFile(join(workspace,'out/result.log'))).length>0);receipt.checks.push('custom real-engine command publishes configured PDF/log without changing active include');
 await settings();assert.equal(await page.getByLabel(/編譯引擎設定檔|Engine profile/).inputValue(),'custom');receipt.checks.push('trusted UI custom profile remains persisted after compilation');assert.deepEqual(receipt.pageErrors,[]);receipt.status='passed';
}catch(e){receipt.status='failed';receipt.stage=stage;receipt.error=String(e);receipt.stderr=stderr;if(page){receipt.body=(await page.locator('body').innerText().catch(()=>'' )).slice(-7000);await page.screenshot({path:join(evidence,'compile-config-native-e2e.png')}).catch(()=>{})}process.exitCode=1}
finally{
 clearTimeout(watchdog);
 if(page && !page.isClosed()){
  try{
   const cancel=page.getByRole('button',{name:/^(取消編譯|Cancel compilation)$/});
   if(await cancel.isVisible().catch(()=>false)){await cancel.click();await cancel.waitFor({state:'detached',timeout:15000});}
   await page.evaluate(()=>{location.hash='#/';});
   const remove=page.getByRole('button',{name:`移除 ${basename(workspace)} 的紀錄`,exact:true});
   await remove.waitFor({state:'visible',timeout:5000});await remove.click();await remove.waitFor({state:'detached',timeout:5000});
   receipt.testRecentRemoved=true;
  }catch(error){receipt.testRecentRemoved=false;receipt.recentCleanupError=String(error);receipt.status='failed';process.exitCode=1;}
 }
 if(browser)await browser.close().catch(()=>{});
 if(app.pid)await exec('taskkill.exe',['/PID',String(app.pid),'/T','/F']).catch(()=>{});
 await writeFile(join(evidence,'compile-config-native-e2e.json'),JSON.stringify(receipt,null,2));
 await rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:150}).catch(()=>{});console.log(JSON.stringify(receipt));
}
