import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSurface } from './tauri-surface.mjs';

test('AST inventory ignores commented/string code and accepts multiline registrations',()=>{
 const rows=collectSurface(`// ipcMain.handle('fake', fn)
 const label="ipcRenderer.send('fake')";
 ipcMain.handle(
 'actual:operation', fn);
 handleFs('fs:read', fn);`,'main.ts');
 assert.deepEqual(rows.map(r=>r.channel),['actual:operation','fs:read']);
 assert.equal(rows[0].line,3);
 assert.equal(rows[1].direction,'host');
});
test('dynamic routing stays explicit and Draw.io is the only excluded feature',()=>{
 const rows=collectSurface("ipcMain.handle(channel, fn); invokeFs('draft:compile', body); ipcRenderer.invoke('diagram:read', body);",'preload.ts');
 assert.equal(rows[0].disposition,'dynamic-followup');
 assert.equal(rows[0].expression,'channel');
 assert.equal(rows[1].disposition,'in-scope');
 assert.equal(rows[2].disposition,'excluded-drawio');
});
test('malformed source cannot silently produce a partial inventory',()=>{
 assert.throws(()=>collectSurface('ipcMain.handle(', 'broken.ts'),/SOURCE_PARSE_FAILED/);
});
test('MCP tools, asset protocols and DesktopPort are distinct parity surfaces',()=>{
 const rows=collectSurface(`server.registerTool('get_unsaved', schema, handler);
 protocol.handle('texfile', handler); protocol.handle('drawio', handler);
 interface DesktopPort { readFile(file: FileRef): Promise<ReadReceipt>; }
 interface Unrelated { method(): void; }`,'surface.ts');
 assert.deepEqual(rows.map(r=>[r.kind,r.channel,r.disposition]),[
  ['mcp-tool','get_unsaved','in-scope'],['protocol','texfile','in-scope'],
  ['protocol','drawio','excluded-drawio'],['port-method','readFile','in-scope']
 ]);
});
