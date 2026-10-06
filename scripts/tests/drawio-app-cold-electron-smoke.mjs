// Capture genuine first-request metadata without changing the production callback.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-drawio-cold-'));
const formal = !process.argv.includes('--protocol-only');
const candidateArg = process.argv.indexOf('--candidate-dir');
if (candidateArg !== -1 && !process.argv[candidateArg + 1]) throw new Error('Explicit candidate directory required');
const candidate = candidateArg === -1 ? root : path.resolve(process.argv[candidateArg + 1]);
const host = createServer((_req, res) => {
	res.setHeader('Content-Type', 'text/html');
	res.end('<!doctype html><title>Owned cold host</title>');
});
let child;
try {
	assert.equal(process.versions.node, '24.19.0');
	assert.equal(require('electron/package.json').version, '43.5.0');
	await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${host.address().port}`;
	await build({
		entryPoints: [path.join(root, 'electron/src/drawio-protocol.ts')],
		outfile: path.join(owned, 'core.cjs'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['electron']
	});
	await fs.writeFile(
		path.join(owned, 'main.cjs'),
		`
const {app,BrowserWindow,session}=require('electron');
const core=require('./core.cjs');
const url=${JSON.stringify(url)};
app.setPath('userData',${JSON.stringify(path.join(owned, 'profile'))});
${
	formal
		? `
app.whenReady().then(()=>{
 const native=session.defaultSession;
 const original=native.webRequest.onBeforeRequest.bind(native.webRequest);
 native.webRequest.onBeforeRequest=(filter,listener)=>original(filter,(details,callback)=>{
  if(details.resourceType==='mainFrame'){
   let detailURL=null,frameURL=null;try{detailURL=details.webContents?.getURL()??null;frameURL=details.frame?.url??null;}catch{}
   console.log(JSON.stringify({phase:'formal-first-request',keys:Object.keys(details).sort(),resourceType:details.resourceType,webContentsId:details.webContentsId??null,hasWebContents:!!details.webContents,hasFrame:!!details.frame,detailURL,frameURL,targetURL:details.url,expectedURL:url}));
  }
  listener(details,callback);
 });
});
let failed=false,finished=false;
function finish(code){if(finished)return;finished=true;app.once('will-quit',()=>app.exit(code));app.quit();}
app.on('browser-window-created',(_event,win)=>{
 win.webContents.once('did-fail-load',(_event,code)=>{failed=true;console.log(JSON.stringify({phase:'formal-cold-load',ok:false,code}));finish(1);});
 win.webContents.once('did-finish-load',()=>{if(failed)return;console.log(JSON.stringify({phase:'formal-cold-load',ok:true}));finish(0);});
});
require(${JSON.stringify(path.join(candidate, 'electron/dist/main.js'))});
if(app.getPath('userData')!==${JSON.stringify(path.join(owned, 'profile'))}||app.getPath('sessionData')!==${JSON.stringify(path.join(owned, 'profile'))})throw new Error('Formal candidate did not retain owned profile');
`
		: ''
}
${formal ? '/*' : ''}
app.whenReady().then(async()=>{
 let win; let first=true;
 const nativeSession=session.defaultSession;
 const originalBeforeRequest=nativeSession.webRequest.onBeforeRequest.bind(nativeSession.webRequest);
 nativeSession.webRequest.onBeforeRequest=(filter,listener)=>{
  originalBeforeRequest(filter,(details,callback)=>{
   if(first){first=false;
    let ownURL=null,detailURL=null,frameURL=null;
    try{ownURL=win?.webContents.getURL()??null;}catch{}
    try{detailURL=details.webContents?.getURL()??null;}catch{}
    try{frameURL=details.frame?.url??null;}catch{}
    console.log(JSON.stringify({phase:'first-request',keys:Object.keys(details).sort(),resourceType:details.resourceType,webContentsId:details.webContentsId??null,hasWebContents:!!details.webContents,hasFrame:!!details.frame,ownURL,detailURL,frameURL,exactTarget:details.url===url}));
   }
   listener(details,callback);
  });
 };
 core.installDrawioNetworkGuard(nativeSession,id=>win&&id===win.webContents.id?{mainURL:url}:undefined,id=>win&&id===win.webContents.id?win.webContents:undefined);
 nativeSession.webRequest.onBeforeRequest=originalBeforeRequest;
 win=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 core.installDrawioNavigationGuard(win.webContents,()=>({mainURL:url}));
 try{await win.loadURL(url);if(!core.matchesDiagramHostURL(win.webContents.getURL(),url))throw new Error('Unexpected host URL');console.log(JSON.stringify({phase:'cold-load',ok:true,canonicalExactURL:true}));app.exit(0);}
 catch(error){console.log(JSON.stringify({phase:'cold-load',ok:false,code:error.code??null,errno:error.errno??null}));app.exit(1);}
}).catch(()=>app.exit(1));
${formal ? '*/' : ''}
`
	);
	const electronEnv = { ...process.env };
	delete electronEnv.ELECTRON_RUN_AS_NODE;
	electronEnv.TEXPILE_USER_DATA = path.join(owned, 'profile');
	if (formal) electronEnv.ELECTRON_START_URL = url;
	child = spawn(require('electron'), [path.join(owned, 'main.cjs')], {
		cwd: root,
		env: electronEnv,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', (data) => process.stdout.write(data));
	child.stderr.on('data', (data) => process.stderr.write(data));
	const exit = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error('Cold-load deadline'));
		}, 30_000);
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
	assert.equal(exit, 0, 'Genuine cold load failed; first-request evidence retained above');
} finally {
	if (child && child.exitCode === null) child.kill();
	host.closeAllConnections();
	await new Promise((resolve) => host.close(resolve));
	const resolved = await fs.realpath(owned);
	assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
	assert.ok(path.basename(resolved).startsWith('modutex-drawio-cold-'));
	await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
