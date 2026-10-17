// Deterministic source inventory; no application code is imported or executed.
import ts from 'typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hostCalls = new Set(['handleFrontendFiles','handleFs','handleFsE']);
const clientCalls = new Set(['call','invokeFs','bufferedChannel']);
const directCalls = new Set(['ipcMain.handle','ipcMain.on','ipcRenderer.invoke','ipcRenderer.send','ipcRenderer.on']);
const otherCalls = new Map([['server.registerTool','mcp-tool'],['protocol.handle','protocol']]);

export function collectSurface(text, path) {
 const source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
 if(source.parseDiagnostics.length) throw new Error('SOURCE_PARSE_FAILED: '+path);
 const rows=[];
 function visit(node) {
  if(ts.isCallExpression(node)) {
   const callee=node.expression.getText(source);
   if(directCalls.has(callee)||hostCalls.has(callee)||clientCalls.has(callee)||otherCalls.has(callee)) {
    const arg=node.arguments[0];
    const channel=arg&&(ts.isStringLiteral(arg)||ts.isNoSubstitutionTemplateLiteral(arg))?arg.text:null;
    const line=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
    rows.push({path,line,callee,kind:otherCalls.get(callee)??'ipc',channel,expression:channel?null:arg?.getText(source)??null,
     direction:callee.startsWith('ipcMain.')||hostCalls.has(callee)||otherCalls.has(callee)?'host':'client',
     disposition:channel&&/^(diagram:|drawio:|drawio$)/.test(channel)?'excluded-drawio':channel?'in-scope':'dynamic-followup'});
   }
  }
  if(ts.isMethodSignature(node)&&ts.isInterfaceDeclaration(node.parent)&&node.parent.name.text==='DesktopPort') {
   rows.push({path,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,
    callee:'DesktopPort',kind:'port-method',channel:node.name.getText(source),expression:null,
    direction:'contract',disposition:'in-scope'});
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
 return rows;
}

async function main() {
 const root=resolve(import.meta.dirname,'../..');
 const paths=['electron/src/main.ts','electron/src/preload.ts','electron/src/window-chrome.ts',
  'electron/src/mcp/server.ts','packages/frontend-contracts/src/types.ts'];
 const rows=[],hashes={};
 for(const path of paths) {
  const raw=await readFile(resolve(root,path));
  hashes[path]=createHash('sha256').update(raw).digest('hex');
  rows.push(...collectSurface(raw.toString('utf8'),path));
 }
 const names = kind => [...new Set(rows.filter(r=>r.kind===kind&&r.disposition==='in-scope').map(r=>r.channel))].sort();
 const channels=names('ipc');
 const dir=resolve(root,'.verification-artifacts/tauri');
 await mkdir(dir,{recursive:true});
 const artifact=resolve(dir,'host-surface.json');
 const inventory={schemaVersion:1,hashes,channels,mcpTools:names('mcp-tool'),protocols:names('protocol'),portMethods:names('port-method'),rows};
 const encoded=JSON.stringify(inventory,null,2)+'\n';
 await writeFile(artifact,encoded);
 const baseline=resolve(root,'docs/architecture/tauri/host-surface.json');
 if(process.argv.includes('--write-baseline')) {await mkdir(resolve(baseline,'..'),{recursive:true});await writeFile(baseline,encoded);}
 if(process.argv.includes('--check')) {
  if(await readFile(baseline,'utf8')!==encoded) throw new Error('SURFACE_BASELINE_CHANGED: review capability coverage before updating');
 }
 console.log(JSON.stringify({artifact,channels:channels.length,mcpTools:inventory.mcpTools.length,
  portMethods:inventory.portMethods.length,protocols:inventory.protocols,callSites:rows.length,
  dynamic:rows.filter(r=>r.channel===null).length,excluded:rows.filter(r=>r.disposition==='excluded-drawio').length}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
