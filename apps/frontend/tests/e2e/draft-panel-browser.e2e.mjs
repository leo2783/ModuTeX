// SPDX-License-Identifier: Apache-2.0
// Real DraftPanel, SourceDocument WASM and PDF.js; only native IPC is substituted.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createServer} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {chromium} from 'playwright';
import {realPdf} from '../helpers/pdf-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../../../..');
const frontend=path.resolve(repository,process.env.MODUTEX_TEST_FRONTEND_ROOT??'apps/frontend');
const contracts=path.resolve(repository,process.env.MODUTEX_TEST_CONTRACTS_ENTRY??'packages/frontend-contracts/dist/index.js');
const source=path.join(frontend,'src').replaceAll('\\','/');

async function mountDraft(t){
 const fixture=await mkdtemp(path.join(repository,'apps/frontend/.draft-panel-e2e-'));
 let server,browser;
 t.after(async()=>{await browser?.close();await server?.close();assert.equal(path.dirname(fixture),path.join(repository,'apps/frontend'));assert.ok(path.basename(fixture).startsWith('.draft-panel-e2e-'));await rm(fixture,{recursive:true,force:true});});
 await writeFile(path.join(fixture,'host.js'),`
const calls=[];let pending=null,sequence=0;
const pdf=new Uint8Array(${JSON.stringify(realPdf())});
window.draftHost={calls,results:[],errors:[],
 invoke(command,args={}){calls.push({command,args});
  if(command==='frontend_draft_compile'||command==='frontend_draft_typeset_paragraph')return new Promise(resolve=>{pending={resolve,request:args.request,runId:'draft-run-'+(++sequence),mode:command.endsWith('paragraph')?'paragraph':'full'};});
  if(command==='frontend_take_file_pdf')return Promise.resolve(pdf.slice().buffer);
  if(command==='frontend_draft_stop'){if(pending)this.complete('cancelled');return Promise.resolve({stopped:true});}
  if(command==='frontend_draft_takeover')return Promise.resolve({preempted:true});
  throw Error('Unexpected Draft IPC '+command);
 },
 complete(status='success'){
  if(!pending)throw Error('No pending Draft request');
  const current=pending;pending=null;
  current.resolve({identity:{runId:current.runId,...current.request},mode:current.mode,status,elapsedMs:1,pageCount:2,renderableRecordCount:0,passCount:1,bibliographyPassCount:0,geometry:{paperWidthPt:400,paperHeightPt:300,columnWidthPt:300,footSkipPt:0,marginLeftPt:30,marginRightPt:30,marginTopPt:30,marginBottomPt:30},pages:[],references:[],bibliography:[],images:[],unsupportedContentReasons:[],pdfFallback:true,diagnostics:[],log:'',failure:status==='failure'?'Intentional failed build':null,...(status==='success'?{pdfToken:'draft-pdf-'+sequence}:{})});
 }
};`);
 await writeFile(path.join(fixture,'Harness.svelte'),`<script>
import DraftPanel from ${JSON.stringify(source+'/features/draft/DraftPanel.svelte')};
import {SourceDocument} from ${JSON.stringify(source+'/features/document-core/core.ts')};
let document=$state.raw(SourceDocument.open(new TextEncoder().encode('Alpha source paragraph.')));
let revision=$state('revision-1'),active=$state(true);
window.draftHost.edit=()=>{document=document.apply({expectedVersion:document.version,patches:[{from:0,to:5,insert:'Zebra'}]}).document;revision='revision-2';};
window.draftHost.deactivate=()=>{active=false;};
</script><DraftPanel {document} {active} {revision} workspaceId="workspace-1" entryPath="main.tex" dirty={false} onResult={(result)=>window.draftHost.results.push(result.identity.documentVersion)} onError={(error)=>window.draftHost.errors.push(error.message)}/>`);
 await writeFile(path.join(fixture,'main.js'),`import './host.js';import {mount} from 'svelte';import Harness from './Harness.svelte';mount(Harness,{target:document.getElementById('app')});`);
 await writeFile(path.join(fixture,'index.html'),'<!doctype html><html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
 server=await createServer({root:fixture,configFile:false,resolve:{alias:{'@modutex/frontend-contracts':contracts}},plugins:[{name:'test-draft-native-boundary',enforce:'pre',resolveId(id,importer){if(id==='@tauri-apps/api/core'&&importer?.replaceAll('\\','/').endsWith('/features/draft/transport.ts'))return '\0draft-native-boundary';},load(id){if(id==='\0draft-native-boundary')return 'export const invoke=(command,args)=>window.draftHost.invoke(command,args);';}},svelte()],server:{host:'127.0.0.1',port:0,fs:{allow:[repository]}},logLevel:'error'});
 await server.listen();
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
 const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
 await page.getByRole('button',{name:/^(全篇 Draft 排版|Full Draft)$/}).waitFor();
 return {page,errors,compile:page.getByRole('button',{name:/^(全篇 Draft 排版|Full Draft)$/})};
}

test('Draft allows stopping an in-flight native compile',{timeout:90_000},async t=>{
 const {page,compile,errors}=await mountDraft(t);
 await compile.click();
 await page.waitForFunction(()=>window.draftHost.calls.some(call=>call.command==='frontend_draft_compile'));
 const stop=page.getByRole('button',{name:/^(停止程序|Stop Daemon)$/});
 assert.equal(await stop.isEnabled(),true,'Stop must remain available while the compiler is busy');
 await stop.click();
 await page.waitForFunction(()=>window.draftHost.calls.some(call=>call.command==='frontend_draft_stop'));
 assert.deepEqual(errors,[]);
});

test('Draft rejects edited-document results and stops the idle warm daemon on route deactivation',{timeout:90_000},async t=>{
 const {page,compile,errors}=await mountDraft(t);
 await compile.click();
 await page.waitForFunction(()=>window.draftHost.calls.some(call=>call.command==='frontend_draft_compile'));
 await page.evaluate(()=>{window.draftHost.edit();});
 await page.evaluate(()=>window.draftHost.complete());
 await page.waitForFunction(()=>document.querySelector('.draft-busy-indicator')===null);
 assert.deepEqual(await page.evaluate(()=>window.draftHost.results),[],'An older document result must not be published');
 await page.evaluate(()=>window.draftHost.deactivate());
 await page.waitForFunction(()=>window.draftHost.calls.some(call=>call.command==='frontend_draft_stop'));
 assert.deepEqual(errors,[]);
});

test('Draft retains the previous rendered PDF after a failed compile',{timeout:90_000},async t=>{
 const {page,compile,errors}=await mountDraft(t);
 await compile.click();
 await page.waitForFunction(()=>window.draftHost.calls.filter(call=>call.command==='frontend_draft_compile').length===1);
 await page.evaluate(()=>window.draftHost.complete());
 await page.locator('canvas').waitFor({state:'visible'});
 await compile.click();
 await page.waitForFunction(()=>window.draftHost.calls.filter(call=>call.command==='frontend_draft_compile').length===2);
 await page.evaluate(()=>window.draftHost.complete('failure'));
 await page.waitForFunction(()=>document.querySelector('.draft-busy-indicator')===null);
 assert.equal(await page.locator('canvas').isVisible(),true,'Failure must retain the last good PDF');
 assert.deepEqual(errors,[]);
});

test('Draft refuses paragraph compilation when editor selection is unavailable',{timeout:90_000},async t=>{
 const {page,errors}=await mountDraft(t);
 await page.getByRole('button',{name:/^(段落排版|Typeset Paragraph)$/}).click();
 await page.getByRole('alert').waitFor();
 assert.equal(await page.evaluate(()=>window.draftHost.calls.some(call=>call.command==='frontend_draft_typeset_paragraph')),false,'A missing selection must never compile the first paragraph implicitly');
 assert.deepEqual(errors,[]);
});

test('Draft marks edited-document previews stale while retaining the rendered PDF',{timeout:90_000},async t=>{
 const {page,compile,errors}=await mountDraft(t);
 await compile.click();
 await page.waitForFunction(()=>window.draftHost.calls.some(call=>call.command==='frontend_draft_compile'));
 await page.evaluate(()=>window.draftHost.complete());
 await page.locator('canvas').waitFor({state:'visible'});
 assert.equal(await page.locator('.draft-stale-indicator').count(),0);
 await page.evaluate(()=>window.draftHost.edit());
 await page.locator('.draft-stale-indicator').waitFor({state:'visible'});
 assert.equal(await page.locator('canvas').isVisible(),true,'Editing must preserve the last good PDF with a visible stale status');
 assert.deepEqual(errors,[]);
});
