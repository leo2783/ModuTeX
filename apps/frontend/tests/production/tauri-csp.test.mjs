// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {tauriCspPlugin} from '../../scripts/tauri-csp.mjs';
const html=await readFile(new URL('../../index.html',import.meta.url),'utf8');
const browserConnect="connect-src 'self' ws://127.0.0.1:5174;";
const tauriConnect="connect-src 'self' ipc: http://ipc.localhost;";
const tauriDevConnect="connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:5174;";
const browserFrame="frame-src 'none'";
test('Tauri production build permits native binary IPC without HMR',()=>{
 const [plugin]=tauriCspPlugin('tauri','build');
 const output=plugin.transformIndexHtml(html);
 assert.equal(output.replace(tauriConnect,browserConnect),html);
 assert.ok(output.includes(browserFrame));
 assert.equal(output.includes('frame-src http://127.0.0.1:*'),false);
 assert.equal(output.includes(tauriDevConnect),false);
 const [legacyPlugin]=tauriCspPlugin('tauri');
 assert.equal(legacyPlugin.transformIndexHtml(html),output);
 assert.throws(()=>plugin.transformIndexHtml(html.replace('connect-src','changed-src')),/TAURI_CSP_TEMPLATE_CHANGED/);
 assert.throws(()=>plugin.transformIndexHtml(html.replace(browserFrame,'frame-src https:')),/TAURI_CSP_TEMPLATE_CHANGED/);
 assert.throws(()=>plugin.transformIndexHtml(html.replace(browserFrame,browserFrame+'; '+browserFrame)),/TAURI_CSP_TEMPLATE_CHANGED/);
});
test('Tauri serve permits native binary IPC and the exact HMR websocket',()=>{
 const [plugin]=tauriCspPlugin('tauri','serve');
 const output=plugin.transformIndexHtml(html);
 assert.equal(output.replace(tauriDevConnect,browserConnect),html);
 assert.ok(output.includes(browserFrame));
 assert.equal(output.includes('frame-src http://127.0.0.1:*'),false);
 assert.ok(output.includes(tauriDevConnect));
});
test('browser dev and build modes do not install a native IPC CSP transform',()=>{
 assert.deepEqual(tauriCspPlugin('development','serve'),[]);
 assert.deepEqual(tauriCspPlugin('production','build'),[]);
 assert.ok(html.includes(browserConnect));
});

test('Tauri build rejects JavaScript signatures inside the native MIME sniff window',()=>{
 const [plugin]=tauriCspPlugin('tauri');
 const bundle=(fileName,source,type='asset')=>({[fileName]:type==='chunk'?{type,code:source}:{type,source}});
 assert.throws(()=>plugin.generateBundle({},bundle('assets/validator.js','x'.repeat(1020)+'%PDF','chunk')),/TAURI_JS_PDF_MIME_HAZARD:assets\/validator\.js/);
 assert.throws(()=>plugin.generateBundle({},bundle('assets/worker.mjs',Buffer.from('%PDF in a module'))),/TAURI_JS_PDF_MIME_HAZARD/);
 assert.doesNotThrow(()=>plugin.generateBundle({},bundle('assets/safe.js','x'.repeat(1021)+'%PDF','chunk')));
 assert.doesNotThrow(()=>plugin.generateBundle({},bundle('assets/unicode.js','漢'.repeat(341)+'%PDF','chunk')));
 assert.doesNotThrow(()=>plugin.generateBundle({},bundle('document.pdf',Buffer.from('%PDF-1.7'))));
});
