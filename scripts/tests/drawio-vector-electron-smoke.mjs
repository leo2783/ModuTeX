// Real retained vendor -> fixed relay -> native IPC -> isolated PDF -> realFS publication.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const desktopRegressionOnly = process.argv.includes('--desktop-regression-only');
// Synthetic Start/End source authored in the genuine desktop, not personal data.
// Preserve its original 805 bytes/SHA; no absolute local fixture dependency.
const desktopSource = `<mxfile host="editor">
  <diagram id="page-1" name="Page-1">
    <mxGraphModel dx="687" dy="231" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="z8ubX2ULDgU7etW46pMF-1" parent="1" style="whiteSpace=wrap;html=1;" value="Start" vertex="1">
          <mxGeometry height="60" width="120" x="390" y="100" as="geometry" />
        </mxCell>
        <mxCell id="z8ubX2ULDgU7etW46pMF-2" parent="1" style="whiteSpace=wrap;html=1;" value="End" vertex="1">
          <mxGeometry height="60" width="120" x="560" y="190" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
assert.equal(Buffer.byteLength(desktopSource), 805);
assert.equal(
	require('node:crypto').createHash('sha256').update(desktopSource).digest('hex'),
	'4d338360db58dc4a1c837533d65795614724ef8d44a90ca6755db7ebd0c9ebb0'
);
const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-drawio-vector-')));
let child,
	done,
	success = false,
	hits = 0;
const sink = createServer((_req, res) => {
	hits++;
	res.end('owned sink');
});
sink.on('upgrade', (_req, socket) => {
	hits++;
	socket.destroy();
});
const host = createServer(async (req, res) => {
	if (req.url === '/index.html') {
		res.setHeader('Content-Type', 'text/html');
		res.end('<!doctype html><html><body><script src="/client.js"></script></body></html>');
	} else if (req.url === '/client.js') {
		res.setHeader('Content-Type', 'text/javascript');
		res.end(await fs.readFile(path.join(owned, 'client.js')));
	} else {
		res.statusCode = 404;
		res.end();
	}
});
try {
	assert.equal(process.versions.node, '24.19.0');
	assert.equal(require('electron/package.json').version, '43.5.0');
	await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
	await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
	const hostURL = `http://127.0.0.1:${host.address().port}/index.html`;
	const sinkURL = `http://127.0.0.1:${sink.address().port}`;
	await build({
		entryPoints: [path.join(root, 'electron/src/diagram-cpu-worker.ts')],
		outfile: path.join(owned, 'diagram-cpu-worker.js'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24'
	});
	await build({
		stdin: {
			contents:
				'export * from "./electron/src/diagram-ipc.ts";export * from "./electron/src/diagram-pdf.ts";export * from "./electron/src/diagram-svg.ts";export * from "./electron/src/drawio-protocol.ts";',
			resolveDir: root,
			loader: 'ts'
		},
		outfile: path.join(owned, 'core.cjs'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24',
		external: ['electron']
	});
	await build({
		entryPoints: [path.join(root, 'electron/src/preload.ts')],
		outfile: path.join(owned, 'preload.cjs'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['electron']
	});
	await build({
		stdin: {
			contents: 'import {startDrawioRelay} from "./electron/src/drawio-message-relay.ts";startDrawioRelay("__MODUTEX_HOST_ORIGINS__");',
			resolveDir: root,
			loader: 'ts'
		},
		outfile: path.join(owned, 'relay.js'),
		bundle: true,
		platform: 'browser',
		format: 'iife'
	});
	await build({
		stdin: {
			contents:
				'import {createDrawioSession} from "./apps/texpile-editor/src/lib/diagram/drawio-session.ts";window.createVectorSession=(desktop=false)=>{const iframe=document.createElement("iframe");iframe.style=desktop?"pointer-events:none;position:fixed;left:-200vw;top:0;height:768px;width:1024px;opacity:0":"width:1000px;height:700px";document.body.append(iframe);return createDrawioSession({iframe,hostOrigin:location.protocol+"//"+location.host,onMessage:()=>{}});};',
			resolveDir: root,
			loader: 'ts'
		},
		outfile: path.join(owned, 'client.js'),
		bundle: true,
		platform: 'browser',
		format: 'iife'
	});
	const entry = path.join(owned, 'entry.cjs');
	await build({
		stdin: {
			contents: `const assert=require('node:assert/strict');const fs=require('node:fs').promises;const path=require('node:path');(${nativeProof.toString()})(...${JSON.stringify([root, owned, hostURL, sinkURL, desktopSource, desktopRegressionOnly])}).catch(e=>{console.error(e);require('electron').app.exit(1);});`,
			resolveDir: root
		},
		outfile: entry,
		platform: 'node',
		format: 'cjs'
	});
	const electronDir = path.dirname(require.resolve('electron/package.json'));
	const binary = (await fs.readFile(path.join(electronDir, 'path.txt'), 'utf8')).trim();
	assert.ok(!path.isAbsolute(binary) && !binary.includes('..'));
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	child = spawn(path.join(electronDir, 'dist', binary), [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	done = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code) => resolve(code));
	});
	let timer;
	const code = await Promise.race([
		done,
		new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('true vendor deadline')), 90000);
		})
	]).finally(() => clearTimeout(timer));
	assert.equal(code, 0);
	assert.equal(hits, 0, 'Owned sink must receive zero HTTP/WS requests');
	assert.ok(
		process.env.MODUTEX_PDF_PROOF_PYTHON && process.env.MODUTEX_PDF_PROOF_PDFTOPPM,
		'Explicit installed PDF verification tools required'
	);
	await proofCommand(process.env.MODUTEX_PDF_PROOF_PYTHON, ['-c', pdfStructureProof(true), path.join(owned, 'desktop-vector.pdf')]);
	await proofCommand(process.env.MODUTEX_PDF_PROOF_PDFTOPPM, [
		'-f',
		'1',
		'-singlefile',
		'-scale-to',
		'1200',
		'-png',
		path.join(owned, 'desktop-vector.pdf'),
		path.join(owned, 'desktop-vector')
	]);
	if (desktopRegressionOnly) {
		// Diagnostic only: this mode does not claim the original PDF/glyph acceptance suite.
		success = true;
		console.log(`desktop regression diagnostic: sink0; retained at ${owned}`);
	} else {
		assert.ok(
			process.env.MODUTEX_PDF_PROOF_PYTHON && process.env.MODUTEX_PDF_PROOF_PDFTOPPM,
			'Explicit installed PDF verification tools required'
		);
		for (let i = 0; i < 2; i++) {
			const pdf = path.join(owned, `vector-${i}.pdf`);
			await proofCommand(process.env.MODUTEX_PDF_PROOF_PYTHON, ['-c', pdfStructureProof(), pdf]);
			await proofCommand(process.env.MODUTEX_PDF_PROOF_PDFTOPPM, [
				'-f',
				'1',
				'-singlefile',
				'-scale-to',
				'1200',
				'-png',
				pdf,
				path.join(owned, `vector-${i}`)
			]);
		}
		success = true;
		console.log(`drawio-vector native IPC proof: sink0; retained at ${owned}`);
	}
} finally {
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill();
		await done;
	}
	await new Promise((resolve) => host.close(resolve));
	await new Promise((resolve) => sink.close(resolve));
	assert.ok(path.basename(owned).startsWith('modutex-drawio-vector-') && path.dirname(owned) === (await fs.realpath(os.tmpdir())));
	if (!success) {
		try {
			await fs.access(path.join(owned, 'failure-vendor.svg'));
			console.log(`Synthetic failure proof retained for root inspection: ${owned}`);
		} catch {
			await fs.rm(owned, { recursive: true, force: true });
		}
	}
}
async function proofCommand(binary, args) {
	const process = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	process.stdout.on('data', (bytes) => {
		output += bytes;
	});
	process.stderr.on('data', (bytes) => {
		output += bytes;
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			process.kill();
			reject(new Error('PDF verification deadline'));
		}, 15000);
		process.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		process.once('exit', (code) => {
			clearTimeout(timer);
			code === 0 ? resolve() : reject(new Error(`PDF verification failed ${code}: ${output}`));
		});
	});
	console.log(output.trim());
}
function pdfStructureProof(desktop = false) {
	return String.raw`
import json,sys,unicodedata
from pypdf import PdfReader
from pypdf.generic import ContentStream, DecodedStreamObject
reader=PdfReader(sys.argv[1]); assert len(reader.pages)==1
page=reader.pages[0]
assert abs(float(page.mediabox.width)-${desktop ? 219 : 331.5})<1
assert abs(float(page.mediabox.height)-${desktop ? 114 : 76.5})<1
text=page.extract_text()
def assert_labels(actual,expected):
    normalized=unicodedata.normalize('NFKC',actual)
    for label in expected: assert unicodedata.normalize('NFKC',label) in normalized, label
assert_labels(text,${desktop ? "['Start','End']" : "['中文','Vector bold','Second','Edge label']"})
assert_labels('\u4e2d\u2f42',['中文'])
for wrong in ['中','中犬','中口']:
    try: assert_labels(wrong,['中文'])
    except AssertionError: pass
    else: raise AssertionError('Missing/non-compatible wrong glyph accepted')
ops=[op for _,op in page.get_contents().operations]
assert any(op in (b'Tj',b'TJ') for op in ops)
assert any(op in (b'S',b's',b'f',b'f*') for op in ops)
pending=[page['/Resources']]; visited=set(); streams=set(); embedded=0; images=0; type3=0
def resolved(value): return value.get_object() if hasattr(value,'get_object') else value
def assert_vector_stream(stream):
    stream=resolved(stream)
    operators=[op for _,op in ContentStream(stream,reader).operations]
    assert b'INLINE IMAGE' not in operators, 'Inline raster image found'
    return operators
# Exercise the real stream parser's inline-image rejection, not a PDF producer substitute.
inline=DecodedStreamObject(); inline.set_data(b'q BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI Q')
try: assert_vector_stream(inline)
except AssertionError: pass
else: raise AssertionError('Inline raster guard did not reject')
assert_vector_stream(page.get_contents())
while pending:
    resources=resolved(pending.pop())
    if id(resources) in visited: continue
    visited.add(id(resources))
    for ref in resolved(resources.get('/Font',{})).values():
        font=ref.get_object()
        if font.get('/Subtype')=='/Type3':
            glyphs=resolved(font.get('/CharProcs',{})); assert glyphs
            for glyph in glyphs.values():
                glyph=resolved(glyph)
                if id(glyph) in streams: continue
                streams.add(id(glyph)); glyphops=assert_vector_stream(glyph)
                assert any(op in (b'm',b'l',b'c') for op in glyphops), 'Type3 glyph lacks vector geometry'
                assert any(op in (b'f',b'f*',b'S',b's') for op in glyphops), 'Type3 glyph lacks vector paint'
                type3+=1
            if font.get('/Resources') is not None: pending.append(font['/Resources'])
        for child in font.get('/DescendantFonts',[font]):
            descriptor=child.get_object().get('/FontDescriptor')
            if descriptor and any(key in descriptor.get_object() for key in ('/FontFile','/FontFile2','/FontFile3')): embedded+=1
    for ref in resolved(resources.get('/XObject',{})).values():
        obj=ref.get_object()
        if obj.get('/Subtype')=='/Image': images+=1
        if obj.get('/Subtype')=='/Form':
            assert_vector_stream(obj)
            pending.append(obj.get('/Resources',resources))
assert embedded>0; ${desktop ? '' : 'assert type3>0;'} assert images==0
print(json.dumps({'pages':1,'widthPt':float(page.mediabox.width),'heightPt':float(page.mediabox.height),'embeddedFonts':embedded,'type3VectorGlyphs':type3,'rawText':text,'rawCodepoints':['U+%04X'%ord(c) for c in text],'nfkcLabels':True,'negativeGlyphCases':3,'inlineRasterNegative':True,'vectorPaths':True,'rasterImages':images},ensure_ascii=True))
`;
}
async function nativeProof(root, owned, hostURL, sinkURL, desktopSource, desktopRegressionOnly) {
	const { app, BrowserWindow, protocol, session, ipcMain } = require('electron');
	const core = require(path.join(owned, 'core.cjs'));
	app.setPath('userData', path.join(owned, 'profile'));
	app.setPath('sessionData', path.join(owned, 'profile'));
	protocol.registerSchemesAsPrivileged([{ scheme: 'drawio', privileges: core.DRAWIO_PRIVILEGES }]);
	await app.whenReady();
	app.on('window-all-closed', () => {});
	const workspace = path.join(owned, 'workspace');
	await fs.mkdir(workspace);
	let win,
		generation = 1,
		served = 0;
	let cleanupGate;
	const handler = core.createDrawioHandler(
		core.drawioVendorRoot(false, process.resourcesPath, path.join(root, 'electron/dist')),
		path.join(owned, 'relay.js'),
		() => [new URL(hostURL).origin]
	);
	protocol.handle('drawio', async (request) => {
		const response = await handler(request);
		if (response.status === 200) served++;
		return response;
	});
	core.installDrawioNetworkGuard(
		session.defaultSession,
		(id) => (win && id === win.webContents.id ? { mainURL: hostURL } : undefined),
		(id) => (win && id === win.webContents.id ? win.webContents : undefined)
	);
	const native = core.registerDiagramNativeIpc({
		registrar: ipcMain,
		render: core.renderDiagramSvgToPdf,
		async publicationUnlink(file) {
			// Pause a real unlink after all new targets/receipt have committed. The
			// adapter always performs the original FS operation after releasing.
			if (cleanupGate && file.endsWith('.publication.json')) {
				const gate = cleanupGate;
				cleanupGate = undefined;
				gate.entered();
				await gate.wait;
			}
			await fs.unlink(file);
		},
		authorize(event) {
			if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== hostURL)
				throw new Error('UNTRUSTED_SENDER');
			const captured = generation;
			return {
				root: workspace,
				generation,
				assertCurrent() {
					if (win.isDestroyed() || generation !== captured) throw new Error('STALE_WORKSPACE');
				}
			};
		}
	});
	win = new BrowserWindow({
		show: false,
		webPreferences: { preload: path.join(owned, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
	});
	core.installDrawioNavigationGuard(win.webContents, () => ({ mainURL: hostURL }));
	await win.loadURL(hostURL);
	async function desktopCase() {
		const relative = 'assets/diagrams/desktop-348dc897-126b-48e7-a051-3baaf93f496f.drawio';
		const captured = await win.webContents.executeJavaScript(`(async()=>{
			const prepared=await texpileNative.diagramPrepareDrawioVector({xml:${JSON.stringify(desktopSource)}});
			window.desktopVectorSession=createVectorSession(true);
			await desktopVectorSession.load(prepared.xml);
			const exported=await desktopVectorSession.exportSvg();
			const saved=await texpileNative.diagramWrite({relativePath:${JSON.stringify(relative)},content:${JSON.stringify(desktopSource)}});
			const result=await texpileNative.diagramRenderPdf({requestId:crypto.randomUUID(),sourceRelPath:${JSON.stringify(relative)},expectedSourceSha256:saved.sha256,svg:exported.data});
			return {svg:exported.data,result,read:await texpileNative.diagramRead({relativePath:${JSON.stringify(relative)}})};
		})()`);
		const file = path.join(owned, 'failure-vendor.svg');
		await fs.writeFile(file, captured.svg);
		let validator = null;
		try {
			core.sanitizeValidatedSVG(captured.svg);
		} catch (error) {
			validator = String(error.stack);
		}
		const sha256 = require('node:crypto').createHash('sha256').update(captured.svg).digest('hex');
		await fs.writeFile(path.join(owned, 'desktop-result.json'), JSON.stringify({ result: captured.result, sha256, validator }, null, 2));
		console.log('actual desktop-source native diagnostic', {
			file,
			sha256,
			result: captured.result,
			validator: validator?.split('\n').slice(0, 6).join('\n') ?? null
		});
		// Keep the real export session alive until its actual SVG and callback have been captured.
		await win.webContents.executeJavaScript('desktopVectorSession.dispose();void 0;');
		assert.equal(captured.read.content, desktopSource, 'Authored desktop XML must remain unchanged');
		assert.equal(captured.result.ok, true, 'Actual desktop-source SVG must pass fixed-light native validation');
		const canonical = core.sanitizeDrawioLightSVG(captured.svg);
		assert.ok(!/<style|var\(|light-dark\(/.test(canonical.svg));
		assert.ok(canonical.svg.includes('Start') && canonical.svg.includes('End'));
		assert.ok(canonical.svg.includes('x="170" y="90" width="120" height="60"'));
		assert.equal(await fs.readFile(path.join(workspace, captured.result.svgRelPath), 'utf8'), canonical.svg);
		await fs.writeFile(path.join(owned, 'desktop-vector.svg'), canonical.svg);
		await fs.copyFile(path.join(workspace, captured.result.outputRelPath), path.join(owned, 'desktop-vector.pdf'));
	}
	if (desktopRegressionOnly) {
		await desktopCase();
		assert.ok(served >= 20, 'Must load real retained vendor assets');
		await assert.rejects(win.webContents.session.fetch(`${sinkURL}/must-deny`));
		native.invalidate(win.webContents.id);
		generation++;
		win.destroy();
		protocol.unhandle('drawio');
		assert.equal(BrowserWindow.getAllWindows().length, 0);
		app.exit(0);
		return;
	}
	const model =
		'<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="中文&lt;br&gt;&lt;b&gt;Vector bold&lt;/b&gt;" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#2458a6;fontColor=#111111;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="220" height="100" as="geometry"/></mxCell><mxCell id="b" value="Second" style="html=1;fillColor=#ffffff;strokeColor=#2458a6;fontColor=#111111;" vertex="1" parent="1"><mxGeometry x="320" y="20" width="140" height="100" as="geometry"/></mxCell><mxCell id="edge" value="Edge label" style="html=1;endArrow=classic;strokeColor=#2458a6;fontColor=#111111;" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>';
	const original = `<mxfile><diagram id="one" name="Original">${model}</diagram></mxfile>`;
	let compressed, retainedSvg, retainedSource;
	for (let iteration = 0; iteration < 2; iteration++) {
		const sourceXML = iteration ? `<mxfile><diagram id="compressed" name="Compressed">${compressed}</diagram></mxfile>` : original;
		const relative = `assets/diagrams/vector-${iteration ? '223e4567' : '123e4567'}-e89b-42d3-a456-426614174000.drawio`;
		await win.webContents.executeJavaScript(
			`(async()=>{const prepared=await texpileNative.diagramPrepareDrawioVector({xml:${JSON.stringify(sourceXML)}});window.vectorSession=createVectorSession();await vectorSession.load(prepared.xml);})()`
		);
		if (!iteration) {
			const frames = [];
			const visit = (frame) => {
				frames.push(frame);
				for (const child of frame.frames) visit(child);
			};
			visit(win.webContents.mainFrame);
			const editor = frames.find((frame) => frame.url.startsWith('drawio://editor/index.html'));
			assert.ok(editor);
			compressed = await editor.executeJavaScript(`Graph.compress(${JSON.stringify(model)})`);
			assert.ok(typeof compressed === 'string' && compressed.length > 0);
		}
		const result = await win.webContents.executeJavaScript(
			`(async()=>{const exported=await vectorSession.exportSvg();vectorSession.dispose();const saved=await texpileNative.diagramWrite({relativePath:${JSON.stringify(relative)},content:${JSON.stringify(sourceXML)}});const result=await texpileNative.diagramRenderPdf({requestId:crypto.randomUUID(),sourceRelPath:${JSON.stringify(relative)},expectedSourceSha256:saved.sha256,svg:exported.data});return{result,svg:exported.data,saved,status:await texpileNative.diagramStatus({relativePath:${JSON.stringify(relative)}}),read:await texpileNative.diagramRead({relativePath:${JSON.stringify(relative)}})};})()`
		);
		console.log('true retained vendor result', iteration, result.result);
		if (!result.result.ok) {
			const file = path.join(owned, 'failure-vendor.svg');
			await fs.writeFile(file, result.svg);
			const hash = require('node:crypto').createHash('sha256').update(result.svg).digest('hex');
			let diagnostic = '';
			try {
				core.sanitizeValidatedSVG(result.svg);
			} catch (error) {
				diagnostic = String(error.stack);
			}
			await fs.writeFile(path.join(owned, 'failure-validator.txt'), diagnostic);
			console.log('Synthetic failure SVG proof', { file, sha256: hash, validator: diagnostic.split('\n').slice(0, 4).join('\n') });
		}
		assert.equal(result.result.ok, true);
		assert.equal(result.read.content, sourceXML);
		assert.equal(result.read.sha256, result.saved.sha256);
		assert.equal(result.status.state, 'ready');
		assert.ok(!result.svg.includes('foreignObject'));
		assert.ok(result.svg.includes('Vector bold') && result.svg.includes('Edge label') && result.svg.includes('中文'));
		await fs.copyFile(path.join(workspace, result.result.outputRelPath), path.join(owned, `vector-${iteration}.pdf`));
		retainedSvg = result.svg;
		retainedSource = relative;
	}
	for (const scenario of ['cancel-after-commit', 'generation-after-commit']) {
		let entered, release;
		const enteredPromise = new Promise((resolve) => {
			entered = resolve;
		});
		const wait = new Promise((resolve) => {
			release = resolve;
		});
		cleanupGate = { entered, wait };
		const saved = await win.webContents.executeJavaScript(`texpileNative.diagramRead({relativePath:${JSON.stringify(retainedSource)}})`);
		await win.webContents.executeJavaScript(
			`window.boundaryRequestId=crypto.randomUUID();window.boundaryResult=texpileNative.diagramRenderPdf({requestId:boundaryRequestId,sourceRelPath:${JSON.stringify(retainedSource)},expectedSourceSha256:${JSON.stringify(saved.sha256)},svg:${JSON.stringify(retainedSvg)}});void 0;`
		);
		let gateTimer;
		try {
			await Promise.race([
				enteredPromise,
				new Promise((_resolve, reject) => {
					gateTimer = setTimeout(() => reject(new Error('Commit cleanup gate deadline')), 10000);
				})
			]);
		} finally {
			clearTimeout(gateTimer);
		}
		const directory = path.dirname(path.join(workspace, retainedSource));
		const stem = path.basename(retainedSource, '.drawio');
		assert.equal(JSON.parse(await fs.readFile(path.join(directory, `.${stem}.publication.json`), 'utf8')).phase, 'committed');
		const committedReceipt = JSON.parse(await fs.readFile(path.join(directory, `.${stem}.receipt.json`), 'utf8'));
		try {
			if (scenario === 'cancel-after-commit') {
				const cancelled = await win.webContents.executeJavaScript('texpileNative.diagramCancelPdf({requestId:boundaryRequestId})');
				assert.deepEqual(cancelled, { cancelled: false });
			} else {
				generation++;
				native.invalidate(win.webContents.id);
			}
		} finally {
			release();
		}
		const outcome = await win.webContents.executeJavaScript('boundaryResult');
		if (scenario === 'cancel-after-commit') assert.equal(outcome.ok, true);
		else assert.deepEqual(outcome, { ok: false, errorCode: 'STALE_WORKSPACE' });
		const afterReceipt = JSON.parse(await fs.readFile(path.join(directory, `.${stem}.receipt.json`), 'utf8'));
		assert.deepEqual(afterReceipt, committedReceipt);
		const hash = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
		assert.equal(hash(await fs.readFile(path.join(directory, `${stem}.svg`))), committedReceipt.svgSha256);
		assert.equal(hash(await fs.readFile(path.join(directory, `${stem}.pdf`))), committedReceipt.pdfSha256);
		const status = await win.webContents.executeJavaScript(`texpileNative.diagramStatus({relativePath:${JSON.stringify(retainedSource)}})`);
		assert.equal(status.state, 'ready');
		assert.equal(status.source.sha256, committedReceipt.sourceSha256);
		await assert.rejects(fs.access(path.join(directory, `.${stem}.publication.json`)));
		console.log('real native committed cleanup boundary', scenario, outcome, 'receipt retained; status ready');
	}
	await desktopCase();
	assert.ok(served >= 20, 'Must load real retained vendor assets');
	await assert.rejects(win.webContents.session.fetch(`${sinkURL}/must-deny`));
	native.invalidate(win.webContents.id);
	generation++;
	win.destroy();
	protocol.unhandle('drawio');
	assert.equal(BrowserWindow.getAllWindows().length, 0);
	console.log(
		'real vendor uncompressed + vendor Graph.compress -> temporary vector source -> original relay -> native real PDF/pair publication/hash receipt passed; original saved XML retained'
	);
	app.exit(0);
}
