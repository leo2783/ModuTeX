// SPDX-License-Identifier: Apache-2.0
// Real App, Tauri adapter, Rust WASM and PDF.js; native IPC is the fixture boundary.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { build, createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { realPdf } from '../helpers/pdf-fixture.mjs';

const repository = path.resolve(import.meta.dirname, '../../../..');
const frontend = path.resolve(repository, process.env.MODUTEX_TEST_FRONTEND_ROOT ?? 'apps/frontend');
const contracts = path.resolve(repository, process.env.MODUTEX_TEST_CONTRACTS_ENTRY ?? 'packages/frontend-contracts/dist/index.js');
const appPath = path.join(frontend, 'src/App.svelte').replaceAll('\\', '/');
const adapterPath = path.join(frontend, 'src/features/files/tauri-files.ts').replaceAll('\\', '/');
const tauriWindowFixture = '\0app-fixture-tauri-window';
const mapping = [
  'SyncTeX Version:1', 'Input:17:main.tex', 'Input:18:chapter.tex', 'Output:pdf',
  'Magnification:1000', 'Unit:65781.76', 'X Offset:0', 'Y Offset:0', 'Content:',
  '{1', '[17,1:360,440:200,20,0', 'h17,1,1:360,440:200,20,0', ']', '}1',
  '{2', '[18,1:360,440:200,20,0', 'h18,1,1:360,440:200,20,0', ']', '}2',
  'Postamble:', 'Count:2', '!17', 'Post scriptum:', '!24', ''
].join('\n');

test('App preserves SyncTeX, compile settings, Draft and update save flows', { timeout: 120_000 }, async t => {
  const fixture = await mkdtemp(path.join(repository, 'apps/frontend/.app-synctex-e2e-'));
  let server, browser;
  t.after(async () => {
    await browser?.close(); await server?.close();
    assert.equal(path.dirname(fixture), path.join(repository, 'apps/frontend'));
    assert.ok(path.basename(fixture).startsWith('.app-synctex-e2e-'));
    await rm(fixture, { recursive: true, force: true });
  });
const hostSource = `
const listeners = new Map(), calls = [];
const preferenceDefaults = {language:'zh-Hant',appearance:'system',sourceFontSize:14,showLineNumbers:true,wrapLines:false,compileShortcut:'mod-enter'};
let storedPreferences = JSON.parse(localStorage.getItem('fixture.native.preferences') || JSON.stringify(preferenceDefaults));
const preferenceSnapshot = () => ({preferences:{...storedPreferences},invalid:false,recoveredFields:[]});
function persistPreferences() {localStorage.setItem('fixture.native.preferences',JSON.stringify(storedPreferences));}
let watch = null, identity = null, configRevision = 1, outputDirectory = null, compileSequence = 0;
let failWrite = false, writeEdit = null;
const draftRequests = [];
const workspace = { id: 'workspace-1', label: 'SyncTeX fixture', entryPath: 'main.tex' };
const sources = { 'main.tex': 'Main source paragraph.\\n', 'chapter.tex': 'Included source paragraph.\\n' };
const pdf = new Uint8Array(${JSON.stringify(realPdf())});
const synctex = new TextEncoder().encode(${JSON.stringify(mapping)});
window.modutexFiles = {};
window.appHostTransport = {
 async listen(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
 async invoke(command, args = {}) {
  calls.push(command);
  switch (command) {
   case 'frontend_settings_import': {
    if(localStorage.getItem('fixture.native.hold-import')==='1') {
     localStorage.removeItem('fixture.native.hold-import');
     await new Promise(resolve=>window.appFixture.finishPreferenceImport=resolve);
    }
    if(!localStorage.getItem('fixture.native.preferences')) {
     for(const [key,raw] of Object.entries(args.request.legacyRecord)) {
      const name=key.slice('modutex.frontend.preferences.v1.'.length);
      if(Object.hasOwn(preferenceDefaults,name)) storedPreferences[name]=JSON.parse(raw);
     }
     persistPreferences();
    }
    return {...preferenceSnapshot(),imported:true,alreadyImported:false,legacyElectronFound:false,remainingElectronSettings:[]};
   }
   case 'frontend_settings_read': return preferenceSnapshot();
   case 'frontend_settings_set':
    if(window.appFixture.holdNextPreferenceSet) {
     window.appFixture.holdNextPreferenceSet=false;
     await new Promise(resolve=>window.appFixture.finishPreferenceSet=resolve);
    }
    if(window.appFixture.failNextPreferenceSet) {window.appFixture.failNextPreferenceSet=false;throw Error('SETTINGS_WRITE_FAILED');}
    storedPreferences[args.request.key]=args.request.value;persistPreferences();return preferenceSnapshot();
   case 'frontend_settings_reset':
    storedPreferences={...preferenceDefaults};persistPreferences();return preferenceSnapshot();
   case 'frontend_list_recent': return [];
   case 'frontend_open_workspace': return workspace;
   case 'frontend_list_files': return Object.keys(sources).map(path => ({ path, kind: 'file' }));
   case 'frontend_read_file': return { ...args.file, bytes: [...new TextEncoder().encode(sources[args.file.path])], revision: 'revision-1' };
   case 'frontend_write_file': {
    const request = args.request;
    if (writeEdit !== null) {
     const edit = writeEdit; writeEdit = null;
     const content = document.querySelector('.cm-content');
     if (!content) throw Error('EDITOR_UNAVAILABLE');
     content.focus();
     const event = new Event('paste', {bubbles:true,cancelable:true});
     Object.defineProperty(event, 'clipboardData', {value:{
      types:['text/plain'],files:[],getData:type=>type==='text/plain'?edit:''
     }});
     content.dispatchEvent(event);
    }
    if (failWrite) { failWrite = false; throw Error('FILE_CONFLICT'); }
    sources[request.path] = new TextDecoder().decode(new Uint8Array(request.bytes));
    return {workspaceId:request.workspaceId,path:request.path,revision:'revision-saved',documentId:request.documentId,documentVersion:request.documentVersion};
   }
   case 'plugin:updater|check': return {rid:70,currentVersion:'0.3.0',version:'0.4.0',rawJson:{}};
   case 'plugin:updater|download':
    args.onEvent.onmessage({event:'Started',data:{contentLength:100}});
    await new Promise(resolve => window.appFixture.finishDownload=resolve);
    return 71;
   case 'plugin:updater|install': return null;
   case 'plugin:resources|close': return null;
   case 'frontend_watch_start': watch = args; return null;
   case 'frontend_watch_stop': return null;
   case 'frontend_get_compile_config': return { workspaceId: workspace.id, revision: configRevision, mainFile: 'main.tex', profile: 'managed', engine: 'managed', outputDir: outputDirectory, pdf: null, log: null, customCommand: null, canSetCommand: false };
   case 'frontend_update_compile_config': {
    if(args.request.expectedRevision !== configRevision) throw Error('CONFIG_CONFLICT');
    outputDirectory=args.request.outputDir;configRevision++;
    return {workspaceId:workspace.id,revision:configRevision,mainFile:'main.tex',profile:'managed',engine:'managed',outputDir:outputDirectory,pdf:null,log:null,customCommand:null,canSetCommand:false};
   }
   case 'frontend_draft_compile':
   case 'frontend_draft_typeset_paragraph': {
    draftRequests.push(args.request);
    return {identity:{runId:'draft-app-'+draftRequests.length,...args.request},mode:command.endsWith('paragraph')?'paragraph':'full',status:'success',elapsedMs:1,pageCount:2,renderableRecordCount:0,passCount:1,bibliographyPassCount:0,geometry:{paperWidthPt:400,paperHeightPt:300,columnWidthPt:300,footSkipPt:0,marginLeftPt:30,marginRightPt:30,marginTopPt:30,marginBottomPt:30},pages:[],references:[],bibliography:[],images:[],unsupportedContentReasons:[],pdfFallback:true,diagnostics:[],log:'',failure:null,pdfToken:'draft-app-token'};
   }
   case 'frontend_take_file_pdf': return pdf.slice().buffer;
   case 'frontend_draft_stop': return {stopped:true};
   case 'frontend_git_availability': return {status:'unavailable',reason:'NOT_INSTALLED'};
   case 'frontend_start_compile': {
    const request = args.request;
    identity = { runId: 'run-'+(++compileSequence), workspaceId: request.workspaceId, entryPath: request.entryPath, documentId: request.documentId, documentVersion: request.documentVersion, savedRevision: request.savedRevision };
    return identity;
   }
   case 'frontend_compile_result':
    if(window.appFixture.holdCompile) await new Promise(resolve=>window.appFixture.finishCompile=resolve);
    return { status: 'success', identity, log: '', diagnostics: [], pdfToken: 'pdf-token-1' };
   case 'frontend_take_compile_pdf': return pdf.slice().buffer;
   case 'frontend_take_compile_synctex': return synctex.slice().buffer;
   case 'frontend_close_workspace': return null;
   case 'frontend_cancel_compile': return null;
   default: throw Error('Unexpected fixture IPC: ' + command);
  }
 }
};
window.appFixture = {
 calls() { return [...calls]; },
 savedSources() { return {...sources}; },
 draftRequests() { return structuredClone(draftRequests); },
 requestNativeClose() { return window.__appNativeWindowFixture.requestClose(); },
 nativeCloseCount() { return window.__appNativeWindowFixture.closeCount(); },
 closeListenerCount() { return window.__appNativeWindowFixture.listenerCount(); },
 recordNativeClose() { calls.push('native_window_close'); },
 failNextWrite() { failWrite = true; },
 injectEditDuringNextWrite(value) { writeEdit = value; },
 emitChanged(path) {
  if (!watch) throw Error('Watch not ready');
  sources[path] += 'Changed after compilation.\\n';
  listeners.get('frontend://files/event')?.({ subscriptionId: watch.subscriptionId, generation: watch.generation, event: { workspaceId: workspace.id, path, kind: 'changed' } });
 }
};
window.isTauri=true;
window.__TAURI_INTERNALS__={
 invoke:(command,args)=>window.appHostTransport.invoke(command,args),
 transformCallback:()=>1,
 unregisterCallback:()=>{}
};
`;
  await writeFile(path.join(fixture, 'host.js'), hostSource);
  await writeFile(path.join(fixture, 'main.js'), `import './host.js'; import { mount } from 'svelte'; import App from ${JSON.stringify(appPath)}; import ${JSON.stringify(path.join(frontend, 'src/styles/base.css').replaceAll('\\', '/'))}; mount(App, { target: document.getElementById('app') });`);
  await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
  const configuration = { root: fixture, configFile: false,
    resolve: { alias: { '@modutex/frontend-contracts': contracts } },
    plugins: [{ name: 'test-native-ipc-boundary', enforce: 'pre',
      resolveId(source, importer) {
        if (source === '@tauri-apps/api/window') return tauriWindowFixture;
        if (source.replaceAll('\\', '/').endsWith('/features/files/desktop.ts') &&
          importer?.replaceAll('\\', '/').split('?')[0] === appPath) return '\0app-fixture-desktop';
      },
      load(id) {
        if (id === tauriWindowFixture) return `const listeners = new Set();
let closeCount = 0;
function requestClose() {
 const event = { prevented: false, preventDefault() { this.prevented = true; } };
 for (const listener of [...listeners]) listener(event);
 if (!event.prevented) {
  closeCount++;
  window.appFixture?.recordNativeClose();
 }
 return { prevented: event.prevented };
}
window.__appNativeWindowFixture = {
 requestClose,
 closeCount: () => closeCount,
 listenerCount: () => listeners.size
};
export function getCurrentWindow() {
 return {
  onCloseRequested(listener) {
   listeners.add(listener);
   return Promise.resolve(() => listeners.delete(listener));
  },
  async close() { requestClose(); }
 };
}`;
        if (id === '\0app-fixture-desktop') return `import { createTauriFilesAdapter } from ${JSON.stringify(adapterPath)}; export const desktopFiles = signal => createTauriFilesAdapter(signal, window.appHostTransport);`;
      }
    }, svelte()], server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } }, logLevel: 'error' };
  await build({...configuration,worker:{format:'es'},build:{target:'esnext',outDir:path.join(fixture,'dist'),emptyOutDir:true}});
  server = await createServer({root:path.join(fixture,'dist'),configFile:false,server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/#/workbench`);
  await page.getByRole('button', { name: /^(開啟資料夾|Open folder)$/ }).first().click({timeout:10_000}).catch(async error => {
    throw new Error(JSON.stringify({failure:error.message, errors, body:(await page.locator('body').innerText()).slice(0,2000)}));
  });
  const compile = page.getByRole('button', { name: /^(編譯 PDF|Compile PDF)$/ });
  await compile.waitFor({ state: 'visible', timeout: 10_000 }).catch(async error => {
    throw new Error(JSON.stringify({ failure: error.message, calls: await page.evaluate(() => window.appFixture.calls()),
      alerts: await page.locator('[role="alert"]').allTextContents(), errors }));
  });
  await compile.click();
  await page.locator('canvas').waitFor({ state: 'visible' });
  const locate = page.getByRole('button', { name: /^(定位至 PDF|Locate in PDF)$/ });
  await locate.waitFor();
  await page.waitForFunction(() => window.appFixture.calls().includes('frontend_take_compile_synctex'));
  assert.equal(await locate.isEnabled(), true, 'current compile must enable source navigation');
  const before = await page.evaluate(() => window.appFixture.calls().filter(name => name === 'frontend_list_files').length);
  await page.evaluate(() => window.appFixture.emitChanged('chapter.tex'));
  await page.waitForFunction(count => window.appFixture.calls().filter(name => name === 'frontend_list_files').length > count, before);
  await page.waitForTimeout(100);
  assert.equal(await locate.isDisabled(), true, 'changed included source must invalidate the retained mapping');
  await page.getByRole('link',{name:/^(編譯設定|Compile settings)$/}).click();
  const output=page.getByLabel(/^(輸出目錄|Output directory)/);
  await output.fill('build');
  await page.getByRole('button',{name:/^(儲存工作區編譯設定|Save workspace compile settings)$/}).click();
  await page.waitForFunction(()=>window.appFixture.calls().includes('frontend_update_compile_config'));
  await page.screenshot({path:path.join(repository,'.verification-artifacts/tauri/app-compile-settings-review.png'),timeout:5_000});
  await page.getByRole('button',{name:/^(重新載入設定|Reload configuration)$/}).click();
  assert.equal(await output.inputValue(),'build');
  assert.equal((await page.evaluate(()=>window.appFixture.calls())).some(name=>name.includes('mcp')),false,'Default release settings must not require MCP commands');
  await page.getByRole('link',{name:/^(工作台|Workbench)$/}).click();
  await page.getByRole('button',{name:/^(開啟 Draft 排版工作區|Open Draft typesetting workspace)$/}).click();
  await page.screenshot({path:path.join(repository,'.verification-artifacts/tauri/app-draft-entry-review.png'),timeout:5_000});
  await page.getByRole('button',{name:/^(全篇 Draft 排版|Full Draft)$/}).click({timeout:10_000}).catch(async error=>{
    throw new Error(JSON.stringify({failure:error.message,errors,calls:await page.evaluate(()=>window.appFixture.calls()),body:(await page.locator('body').innerText()).slice(-4000)}));
  });
  await page.waitForFunction(()=>window.appFixture.draftRequests().length===1);
  await page.locator('#draft-typesetting-panel canvas').waitFor({state:'visible'});
  await page.getByRole('button',{name:/^(段落排版|Typeset Paragraph)$/}).click();
  await page.waitForFunction(()=>window.appFixture.draftRequests().length===2);
  const requests=await page.evaluate(()=>window.appFixture.draftRequests());
  assert.equal(requests[0].workspaceId,'workspace-1');
  assert.equal(requests[1].documentId,requests[0].documentId);
  assert.equal(requests[1].documentVersion,requests[0].documentVersion);
  assert.equal(requests[1].savedRevision,'revision-1');
  assert.ok(requests[1].range.endByte>requests[1].range.startByte);
  const stoppedBefore=await page.evaluate(()=>window.appFixture.calls().filter(name=>name==='frontend_draft_stop').length);
  await page.getByRole('button',{name:/^(返回 PDF 預覽|Back to PDF preview)$/}).click();
  await page.waitForFunction(count=>window.appFixture.calls().filter(name=>name==='frontend_draft_stop').length>count,stoppedBefore);
  const insert=page.getByRole('button',{name:/^(在此處插入區塊|Insert block here)$/}).first();
  await insert.hover();
  const insertBox=await insert.boundingBox();
  assert.ok(insertBox && Math.abs(insertBox.width-insertBox.height)<0.5,'Block insertion button must remain circular despite global control minimum heights');
  assert.equal(await insert.locator('svg').count(),1);
  await insert.screenshot({path:path.join(repository,'.verification-artifacts/tauri/block-insert-button-review.png')});
  await page.getByRole('link',{name:/^(設定|Settings)$/}).click();
  await page.getByRole('button',{name:/^(編輯器|Editor)$/}).click();
  await page.getByRole('heading',{name:/^(原始碼編輯器|Source editor)$/}).waitFor();
  assert.equal(await page.locator('.settings-content').getByLabel(/^(語言|Language)$/).count(),0,'Unselected categories must not remain mixed into the editor panel');
  const fontSize=page.getByLabel(/^(字型大小|Font size)$/);
  await fontSize.fill('18');await fontSize.press('Tab');
  await page.waitForFunction(()=>document.querySelector('.app').style.getPropertyValue('--source-font-size')==='18px');
  await page.screenshot({path:path.join(repository,'.verification-artifacts/tauri/editor-settings-desktop-review.png')});
  await page.getByRole('button',{name:/^(外觀|Appearance)$/}).click();
  await page.getByLabel(/^(色彩模式|Color mode)$/).selectOption('dark');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.getByRole('button',{name:/^(編輯器|Editor)$/}).click();
  await page.setViewportSize({width:800,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'Settings must fit the supported narrow desktop width');
  await page.screenshot({path:path.join(repository,'.verification-artifacts/tauri/editor-settings-narrow-dark-review.png')});
  await page.getByRole('link',{name:/^(編譯設定|Compile settings)$/}).click();
  await page.getByLabel(/^(輸出目錄|Output directory)/).waitFor();
  await page.screenshot({path:path.join(repository,'.verification-artifacts/tauri/compile-settings-narrow-dark-review.png')});
  await page.getByRole('link',{name:/^(說明|Help)$/}).click();
  assert.equal(await page.getByRole('link',{name:/^(安裝指南|Installation guide)$/}).count(),0);
  await page.evaluate(()=>{location.hash='#/help/installation';});
  await page.getByRole('heading',{name:/^(開始使用|Getting started)$/}).waitFor();
  await page.getByRole('link',{name:/^(工作台|Workbench)$/}).click();
  await page.getByRole('button',{name:'下載更新',exact:true}).click();
  await page.waitForFunction(()=>typeof window.appFixture.finishDownload==='function');
  await page.evaluate(()=>window.appFixture.holdCompile=true);
  await page.getByRole('button',{name:/^(編譯 PDF|Compile PDF)$/}).click();
  await page.waitForFunction(()=>typeof window.appFixture.finishCompile==='function');
  await page.evaluate(()=>window.appFixture.finishDownload());
  await page.getByText('正在等待編譯完成，完成後即可安裝更新。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'安裝更新',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.appFixture.holdCompile=false;window.appFixture.finishCompile();});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='安裝更新'&&!b.disabled));
  const documentTab=page.getByRole('tab',{name:/^(文件|Document)$/});
  if(await documentTab.count()) await documentTab.click();
  await page.getByRole('button',{name:/^(原始碼|Source)$/}).click();
  const content=page.locator('.cm-content').first();
  await content.click();await content.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nSaved by updater.\n');
  await page.getByRole('button',{name:'儲存並更新',exact:true}).click();
  await page.waitForFunction(()=>window.appFixture.calls().includes('plugin:updater|install'));
  const updateCalls=await page.evaluate(()=>window.appFixture.calls());
  assert(updateCalls.lastIndexOf('frontend_write_file')<updateCalls.indexOf('plugin:updater|install'));
  assert(Object.values(await page.evaluate(()=>window.appFixture.savedSources())).some(s=>s.includes('Saved by updater.')));
  await page.waitForFunction(() => window.appFixture.closeListenerCount() === 1);
  const cleanClose = await page.evaluate(() => window.appFixture.requestNativeClose());
  assert.equal(cleanClose.prevented, false, 'A clean native close must proceed without a prompt');
  assert.equal(await page.evaluate(() => window.appFixture.nativeCloseCount()), 1);
  const closeDialog = page.getByRole('dialog', {name:/^(儲存變更？|Save changes\?)$/});
  const closeSaveButton = () => closeDialog.locator('button').filter({hasText:/儲存|Save/}).first();
  const unsavedCloseText = page.locator('.cm-content').first();
  await unsavedCloseText.click();
  await unsavedCloseText.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nNATIVE_CLOSE_DRAFT.\n');
  await page.waitForFunction(() => /未儲存|Unsaved/.test(document.querySelector('.status-bar')?.textContent ?? ''));
  const firstClose = await page.evaluate(() => window.appFixture.requestNativeClose());
  assert.equal(firstClose.prevented, true, 'A dirty native close must be synchronously prevented');
  await closeDialog.waitFor({state:'visible'});
  const repeatedClose = await page.evaluate(() => window.appFixture.requestNativeClose());
  assert.equal(repeatedClose.prevented, true, 'Repeated close requests must remain guarded');
  assert.equal(await page.evaluate(() => window.appFixture.nativeCloseCount()), 1);
  await closeDialog.getByRole('button', {name:/^(取消|Cancel)$/}).click();
  await closeDialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(() => window.appFixture.nativeCloseCount()), 1, 'Cancelling close must keep the window open');

  const failedSaveClose = await page.evaluate(() => window.appFixture.requestNativeClose());
  assert.equal(failedSaveClose.prevented, true);
  await closeDialog.waitFor({state:'visible'});
  const writesBeforeFailure = await page.evaluate(() => window.appFixture.calls().filter(name => name === 'frontend_write_file').length);
  await page.evaluate(() => window.appFixture.failNextWrite());
  await closeSaveButton().click();
  await page.waitForFunction(before => window.appFixture.calls().filter(name => name === 'frontend_write_file').length > before, writesBeforeFailure);
  await page.locator('.error-strip[role="alert"]').waitFor({state:'visible'});
  assert.equal(await page.evaluate(() => window.appFixture.nativeCloseCount()), 1, 'A failed save must not close the window');
  await page.waitForFunction(() => /未儲存|Unsaved/.test(document.querySelector('.status-bar')?.textContent ?? ''));

  const writesBeforeStaleSave = await page.evaluate(() => window.appFixture.calls().filter(name => name === 'frontend_write_file').length);
  await page.evaluate(() => window.appFixture.injectEditDuringNextWrite('\nEDITED_DURING_CLOSE_SAVE\n'));
  await closeSaveButton().click();
  await page.waitForFunction(before => window.appFixture.calls().filter(name => name === 'frontend_write_file').length > before, writesBeforeStaleSave);
  await page.waitForFunction(() => {
    const status = document.querySelector('.status-bar')?.textContent ?? '';
    return !!document.querySelector('dialog[open]') &&
      /未儲存|Unsaved/.test(status) &&
      document.querySelector('.cm-content')?.textContent?.includes('EDITED_DURING_CLOSE_SAVE');
  });
  assert.equal(await page.evaluate(() => window.appFixture.nativeCloseCount()), 1, 'An edit arriving during save must keep the close dialog open');
  const writesBeforeFinalSave = await page.evaluate(() => window.appFixture.calls().filter(name => name === 'frontend_write_file').length);
  await closeSaveButton().click();
  await page.waitForFunction(before =>
    window.appFixture.calls().filter(name => name === 'frontend_write_file').length > before &&
    window.appFixture.nativeCloseCount() === 2, writesBeforeFinalSave);
  await closeDialog.waitFor({state:'hidden'});
  const closeCalls = await page.evaluate(() => window.appFixture.calls());
  assert(closeCalls.lastIndexOf('frontend_write_file') < closeCalls.lastIndexOf('native_window_close'));
  assert(Object.values(await page.evaluate(()=>window.appFixture.savedSources())).some(s=>s.includes('EDITED_DURING_CLOSE_SAVE')));
  await page.reload();
  await page.getByRole('link',{name:/^(設定|Settings)$/}).click();
  await page.getByRole('button',{name:/^(編輯器|Editor)$/}).click();
  assert.equal(await page.getByLabel(/^(字型大小|Font size)$/).inputValue(),'18','Editor preferences must persist after a real reload');
  await page.evaluate(()=>localStorage.setItem('fixture.native.hold-import','1'));
  await page.reload();
  await page.getByRole('link',{name:/^(設定|Settings)$/}).click();
  await page.getByRole('button',{name:/^(編輯器|Editor)$/}).click();
  await page.waitForFunction(()=>typeof window.appFixture.finishPreferenceImport==='function');
  const nativeFontSize=page.getByLabel(/^(字型大小|Font size)$/);
  await nativeFontSize.fill('20');await nativeFontSize.press('Tab');
  await page.evaluate(()=>window.appFixture.finishPreferenceImport());
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('fixture.native.preferences')).sourceFontSize===20);
  assert.equal(await nativeFontSize.inputValue(),'20','Late initialization must preserve the user edit');
  await page.evaluate(()=>window.appFixture.failNextPreferenceSet=true);
  await nativeFontSize.fill('21');await nativeFontSize.press('Tab');
  await page.getByText(/已套用，但無法保存設定|Applied, but settings could not be saved/).waitFor({state:'visible'});
  assert.equal(await nativeFontSize.inputValue(),'21','Failed persistence must preserve the visible user choice');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture.native.preferences')).sourceFontSize),20);
  await page.evaluate(()=>window.appFixture.holdNextPreferenceSet=true);
  await nativeFontSize.fill('22');await nativeFontSize.press('Tab');
  await page.waitForFunction(()=>typeof window.appFixture.finishPreferenceSet==='function');
  await nativeFontSize.fill('23');await nativeFontSize.press('Tab');
  await page.evaluate(()=>window.appFixture.finishPreferenceSet());
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('fixture.native.preferences')).sourceFontSize===23);
  assert.equal(await nativeFontSize.inputValue(),'23','An earlier write reply must not replace a later edit');
  assert.deepEqual(errors, []);
});
