// Bounded, real installed-Electron smoke. No personal profile or altered vendor.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);

async function deadline(promise, label, milliseconds = 60000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label}: timeout`)), milliseconds);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

if (!process.versions.electron) {
	assert.equal(process.versions.node, '24.19.0');
	assert.equal(require('electron/package.json').version, '43.5.0');
	const electronDirectory = path.dirname(require.resolve('electron/package.json'));
	const binaryRelative = (await fs.readFile(path.join(electronDirectory, 'path.txt'), 'utf8')).trim();
	assert.ok(!binaryRelative.includes('..') && !path.isAbsolute(binaryRelative));
	const electronBinary = path.join(electronDirectory, 'dist', binaryRelative);
	await fs.access(electronBinary); // Never invoke electron/index.js's implicit installer.
	assert.equal((await fs.readFile(path.join(electronDirectory, 'dist/version'), 'utf8')).trim(), '43.5.0');
	const { build } = await import('esbuild');
	const { spawn } = await import('node:child_process');
	const { createServer } = await import('vite');
	const http = await import('node:http');
	const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-drawio-electron-')));
	let vite, child, childExit;
	let leakCount = 0;
	const leak = http.createServer((request, response) => {
		leakCount++;
		response.end('owned sink');
	});
	leak.on('upgrade', (_request, socket) => {
		leakCount++;
		socket.destroy();
	});
	try {
		await new Promise((resolve) => leak.listen(0, '127.0.0.1', resolve));
		const sink = `http://127.0.0.1:${leak.address().port}`;
		const bundle = path.join(owned, 'protocol.cjs');
		await build({
			entryPoints: [path.join(root, 'electron/src/drawio-protocol.ts')],
			outfile: bundle,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'node24',
			external: ['electron']
		});
		await build({
			stdin: {
				contents: 'import {startDrawioRelay} from "./electron/src/drawio-message-relay.ts"; startDrawioRelay("__MODUTEX_HOST_ORIGINS__");',
				resolveDir: root,
				loader: 'ts'
			},
			outfile: path.join(owned, 'relay.js'),
			bundle: true,
			platform: 'browser',
			format: 'iife',
			minify: false
		});
		// Original Vite config/default loader. The owned cache does not change source or gates.
		const editor = path.join(root, 'apps/texpile-editor');
		const priorCwd = process.cwd();
		try {
			process.chdir(editor);
			vite = await deadline(
				createServer({
					root: editor,
					configFile: path.join(editor, 'vite.config.ts'),
					cacheDir: path.join(owned, 'vite-cache'),
					server: { host: '127.0.0.1', port: 0, strictPort: true }
				}),
				'Vite create'
			);
			await deadline(vite.listen(), 'Vite listen');
		} finally {
			process.chdir(priorCwd);
		}
		const mainURL = `http://127.0.0.1:${vite.httpServer.address().port}/`;
		await fs.mkdir(path.join(owned, 'profile'));
		const childEnvironment = { ...process.env };
		delete childEnvironment.ELECTRON_RUN_AS_NODE;
		// Electron's bundled default loader has a separate ESM boot path. Use a
		// generated owned CJS entry, just like the application's production bundle.
		const entry = path.join(owned, 'smoke.cjs');
		await build({
			stdin: {
				contents: `const assert = require('node:assert/strict'); const fs = require('node:fs').promises; const path = require('node:path'); const root = ${JSON.stringify(root)}; ${deadline.toString()}; ${electronSmokeChild.toString()}; electronSmokeChild(...${JSON.stringify([bundle, owned, mainURL, sink])}).catch(error => { console.error(error.message); require('electron').app.exit(1); });`,
				resolveDir: root
			},
			outfile: entry,
			platform: 'node',
			format: 'cjs'
		});
		child = spawn(electronBinary, [entry], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment });
		child.stdout.pipe(process.stdout);
		child.stderr.pipe(process.stderr);
		childExit = new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal }));
		});
		const result = await deadline(childExit, 'Electron smoke', 90000);
		assert.equal(result.code, 0, `Electron exited ${result.code}/${result.signal}`);
		assert.equal(leakCount, 0, 'Draw.io reached the owned loopback sink');
		console.log(
			'drawio-electron-smoke: retained vendor, real Vite worker, loopback/remote/popup negatives passed; Typst live consumer UNVERIFIED (tinymist unavailable)'
		);
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill();
			await deadline(childExit, 'owned Electron shutdown', 10000);
		}
		await vite?.close();
		await new Promise((resolve) => leak.close(resolve));
		assert.ok(path.basename(owned).startsWith('modutex-drawio-electron-'));
		await fs.rm(owned, { recursive: true, force: true });
	}
} else {
	throw new Error('Launch this smoke with the pinned Node runtime, not Electron directly');
}

async function electronSmokeChild(bundle, owned, mainURL, sink) {
	let stage = 'startup';
	console.log('drawio-electron-smoke: installed Electron child entered');
	const { app, BrowserWindow, protocol, session } = require('electron');
	const core = require(bundle);
	assert.equal(process.versions.electron, '43.5.0');
	app.setPath('userData', path.join(owned, 'profile'));
	app.setPath('sessionData', path.join(owned, 'profile'));
	protocol.registerSchemesAsPrivileged([{ scheme: 'drawio', privileges: core.DRAWIO_PRIVILEGES }]);
	let win;
	try {
		await app.whenReady();
		const vendorRoot = core.drawioVendorRoot(false, process.resourcesPath, path.join(root, 'electron/dist'));
		assert.equal((await fs.readFile(path.join(root, 'vendor/drawio/VERSION'), 'utf8')).trim(), '31.1.8');
		let served = 0;
		const handler = core.createDrawioHandler(vendorRoot, path.join(owned, 'relay.js'), () => [new URL(mainURL).origin]);
		protocol.handle('drawio', async (request) => {
			const response = await handler(request);
			if (response.status === 200) served++;
			return response;
		});
		win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
		let popupAttempts = 0,
			deniedNavigations = 0;
		let cspNavigationDenied = false;
		const failedNavigation = (_event, code, description, url, isMainFrame) => {
			if (url === `${sink}/navigate`)
				console.log('owned navigation failure classification', { code, blockedByCSP: description === 'ERR_BLOCKED_BY_CSP', isMainFrame });
			if (!isMainFrame && url === `${sink}/navigate` && code === -30 && description === 'ERR_BLOCKED_BY_CSP') cspNavigationDenied = true;
		};
		win.webContents.on('did-fail-load', failedNavigation);
		win.webContents.on('did-fail-provisional-load', failedNavigation);
		const context = { mainURL };
		core.installDrawioNetworkGuard(
			session.defaultSession,
			(id) => (id === win.webContents.id ? context : undefined),
			(id) => (id === win.webContents.id ? win.webContents : undefined)
		);
		core.installDrawioNavigationGuard(win.webContents, () => context);
		win.webContents.on('will-frame-navigate', (event) => {
			if (event.defaultPrevented) deniedNavigations++;
		});
		win.webContents.on('did-create-window', () => popupAttempts++);
		await deadline(win.loadURL(mainURL), 'real host load');
		stage = 'host worker';
		// Genuine production client/worker transformed by the unchanged Vite configuration.
		const labels = await deadline(
			win.webContents.executeJavaScript(`(async () => {
			const { extractDocRefsAsync } = await import('/src/lib/latex-parser/labelsClient.ts');
			return await extractDocRefsAsync('\\\\label{owned-smoke}', 15000);
		})()`),
			'real host worker',
			25000
		);
		assert.deepEqual(labels?.labels, ['owned-smoke'], 'production labels worker failed');
		stage = 'relay load';
		await win.webContents.executeJavaScript(`(async () => {
			const {createDrawioSession} = await import('/src/lib/diagram/drawio-session.ts');
			const iframe = document.createElement('iframe'); iframe.id = 'owned-drawio-smoke';
			iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:10000';
			document.body.append(iframe);
			window.ownedMessages = [];
			window.ownedDrawioSession = createDrawioSession({iframe,hostOrigin:location.origin,onMessage:m=>window.ownedMessages.push({action:m.action,modified:m.modified})});
			await window.ownedDrawioSession.load('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>');
			window.ownedEmptyXml = (await window.ownedDrawioSession.exportXml()).xml;
		})()`);
		let drawio;
		await deadline(
			(async () => {
				for (;;) {
					drawio = win.webContents.mainFrame.frames
						.flatMap((frame) => frame.frames)
						.find((frame) => frame.url.startsWith('drawio://editor'));
					if (
						drawio &&
						(await drawio.executeJavaScript(`typeof EditorUi === 'function' && !!document.querySelector('.geDiagramContainer')`))
					)
						return;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			})(),
			'actual unchanged Draw.io initialized',
			60000
		);
		assert.ok(served >= 3, 'index and required assets were not served');
		assert.equal(await drawio.executeJavaScript('location.origin'), 'drawio://editor');
		const isolation = await drawio.executeJavaScript(`(() => { try { parent.document.body; return false; } catch { return true; } })()`);
		assert.equal(isolation, true, 'vendor can access nonce-holding wrapper');
		stage = 'actual vendor edit';
		await drawio.executeJavaScript(`(() => {
			// Test-only capture: actual message handler passes [this] to its existing debug hook.
			// Neither nonce nor a producer capability is added to production or the host/main.
			const original = EditorUi.debug; let captured;
			EditorUi.debug = function(...args) { if (!captured && args[0]==='EditorUi.installMessageHandler' && args[1]?.[0] instanceof EditorUi) {captured=args[1][0];EditorUi.debug=original;} return original.apply(this,args); };
			window.ownedVendorModelProbe = (operation) => {
				if(!captured)throw new Error('actual UI not captured'); const graph=captured.editor.graph;
				if(operation==='edit') {if(!graph.isEnabled())throw new Error('actual graph disabled');graph.insertVertex(graph.getDefaultParent(),null,'owned producer',20,20,100,40);}
				if(operation==='save')captured.actions.get('save').funct();
				return {enabled:graph.isEnabled(),rootChildren:graph.model.getChildCount(graph.model.getRoot()),vertices:graph.getChildVertices(graph.getDefaultParent()).length};
			};
		})()`);
		await win.webContents.executeJavaScript('window.ownedDrawioSession.exportXml().then(()=>true)');
		console.log('owned actual model before', await drawio.executeJavaScript("window.ownedVendorModelProbe('inspect')"));
		const wrapper = drawio.parent;
		await wrapper.executeJavaScript(
			`(() => { window.ownedVendorCounts = {}; window.addEventListener('message', e => { if(e.origin!=='drawio://editor'||e.source!==document.querySelector('iframe')?.contentWindow)return; try { const r=JSON.parse(e.data); if(['init','load','save','autosave','export','exit'].includes(r.event))window.ownedVendorCounts[r.event]=(window.ownedVendorCounts[r.event]||0)+1; } catch {} }); })()`
		);
		console.log('owned actual model after', await drawio.executeJavaScript("window.ownedVendorModelProbe('edit')"));
		await deadline(
			(async () => {
				for (;;) {
					if (await win.webContents.executeJavaScript("window.ownedMessages.some(m=>m.action==='save'&&m.modified===true)")) return;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			})(),
			'actual edit autosave',
			10000
		).catch(async (error) => {
			console.log('owned vendor event counters', await wrapper.executeJavaScript('window.ownedVendorCounts'));
			console.log(
				'owned edit changed XML',
				await win.webContents.executeJavaScript('(async()=> (await window.ownedDrawioSession.exportXml()).xml !== window.ownedEmptyXml)()')
			);
			throw error;
		});
		await drawio.executeJavaScript("window.ownedVendorModelProbe('save')");
		const result = await win.webContents.executeJavaScript(`(async () => {
			const xml = await window.ownedDrawioSession.exportXml();
			const svg = await window.ownedDrawioSession.exportSvg();
			if (xml.xml === window.ownedEmptyXml || !svg.data.includes('<svg') || !window.ownedMessages.some(m=>m.action==='save'&&m.modified===true)) throw new Error('actual export missing edit');
			await window.ownedDrawioSession.load(xml.xml);
			const reopened = await window.ownedDrawioSession.exportXml();
			return {edited:reopened.xml !== window.ownedEmptyXml,autosave:window.ownedMessages.some(m=>m.action==='save'&&m.modified===true),save:window.ownedMessages.some(m=>m.action==='save'&&m.modified!==true),svg:svg.format==='svg'};
		})()`);
		assert.deepEqual(result, { edited: true, autosave: true, save: true, svg: true });
		console.log('actual producer interoperability', result, 'API-driven only; native input/modal UNVERIFIED');
		stage = 'network and navigation negatives';
		const negatives = await drawio.executeJavaScript(`(async () => {
			const targets = [${JSON.stringify(sink + '/leak')}, 'https://example.invalid/owned-smoke'];
			const results = await Promise.all(targets.map(async (target) => { try { await fetch(target); return false; } catch { return true; } }));
			const popup = window.open(${JSON.stringify(sink + '/popup')}, '_blank');
			return { results, popupDenied: popup === null };
		})()`);
		assert.deepEqual(negatives.results, [true, true]);
		assert.equal(negatives.popupDenied, true);
		const socketsDenied = await drawio.executeJavaScript(`(async () => {
			return await Promise.all([${JSON.stringify(sink.replace('http:', 'ws:') + '/socket')}, 'wss://example.invalid/owned-smoke'].map((target) => new Promise((resolve) => {
				let socket; const timer = setTimeout(() => { socket?.close(); resolve(false); }, 2000);
				try { socket = new WebSocket(target); socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); }; socket.onerror = () => { clearTimeout(timer); resolve(true); }; }
				catch { clearTimeout(timer); resolve(true); }
			})));
		})()`);
		assert.deepEqual(socketsDenied, [true, true]);
		await drawio.executeJavaScript(
			`(() => { const frame = document.createElement('iframe'); frame.src = 'about:blank'; document.body.append(frame); })()`
		);
		const opaque = drawio.frames.find((frame) => frame.url === 'about:blank');
		assert.ok(opaque, 'actual opaque Draw.io descendant was not created');
		assert.equal(core.hasDrawioAncestor(opaque), true);
		const opaqueDenied = await opaque.executeJavaScript(
			`(async () => { try { await fetch(${JSON.stringify(sink + '/opaque')}); return false; } catch { return true; } })()`
		);
		assert.equal(opaqueDenied, true);
		// Exact inner-origin navigation passes wrapper CSP but must hit the production frame guard.
		await drawio.executeJavaScript("location.href = 'drawio://editor/index.html?owned-navigation-negative=1'");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.ok(deniedNavigations > 0, 'actual Draw.io navigation was not denied');
		assert.equal(drawio.url, core.DRAWIO_INDEX);
		stage = 'remote CSP navigation negative';
		await drawio.executeJavaScript(`location.href = ${JSON.stringify(sink + '/navigate')}`);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.ok(cspNavigationDenied || deniedNavigations > 1, 'remote navigation was not blocked by CSP or production guard');
		stage = 'retained frame after denied navigation';
		assert.equal(popupAttempts, 0);
		const innerRetained = await wrapper.executeJavaScript("document.querySelector('iframe') !== null");
		if (innerRetained) assert.equal(drawio.url, core.DRAWIO_INDEX, 'navigated inner frame was retained');
		else assert.equal(wrapper.frames.length, 0, 'stale inner descendants survived fail-closed disposal');
		console.log('owned CSP navigation disposition', { innerRetained, disposed: !innerRetained });
		console.log(
			JSON.stringify({
				electron: process.versions.electron,
				servedAssets: served,
				realHostWorker: true,
				actualVendorInitialized: true,
				actualProducerInteroperability: true,
				nativeInputAndModal: 'UNVERIFIED',
				cspNavigationDenied,
				cspNavigationDisposed: !innerRetained,
				opaqueDescendantDenied: true,
				wsWssDenied: true,
				deniedNavigations,
				createdPopups: popupAttempts
			})
		);
		win.destroy();
		app.exit(0);
	} catch (error) {
		console.error(`Electron smoke failed at ${stage}`);
		win?.destroy();
		app.exit(1);
	}
}
