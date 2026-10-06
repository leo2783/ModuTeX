// Genuine installed-Electron producer + structural PDF proof. No production IPC/publication claim.
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
const keepProof = process.argv.includes('--keep-proof');
const python = process.env.MODUTEX_PDF_PROOF_PYTHON;
const pdftoppm = process.env.MODUTEX_PDF_PROOF_PDFTOPPM;
assert.ok(python && pdftoppm, 'Set explicit installed Python/pypdf and Poppler paths; no implicit installation');
assert.equal(process.versions.node, '24.19.0');
assert.equal(require('electron/package.json').version, '43.5.0');
const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-vector-pdf-')));
let child,
	childDone,
	completed = false;
let networkHits = 0;
const sink = createServer((_request, response) => {
	networkHits++;
	response.end('owned sink');
});
sink.on('upgrade', (_request, socket) => {
	networkHits++;
	socket.destroy();
});
async function command(binary, args, label, timeout = 60_000) {
	const proc = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '',
		err = '';
	proc.stdout.on('data', (chunk) => {
		out += chunk;
	});
	proc.stderr.on('data', (chunk) => {
		err += chunk;
	});
	let timer;
	try {
		const code = await Promise.race([
			new Promise((resolve, reject) => {
				proc.once('error', reject);
				proc.once('exit', resolve);
			}),
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => {
					proc.kill();
					reject(new Error(`${label}: timeout`));
				}, timeout);
			})
		]);
		assert.equal(code, 0, `${label}: ${err}`);
		return out;
	} finally {
		clearTimeout(timer);
	}
}
try {
	await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
	const sinkURL = `http://127.0.0.1:${sink.address().port}`;
	const directory = path.dirname(require.resolve('electron/package.json'));
	const binaryRelative = (await fs.readFile(path.join(directory, 'path.txt'), 'utf8')).trim();
	assert.ok(!path.isAbsolute(binaryRelative) && !binaryRelative.includes('..'));
	const electron = path.join(directory, 'dist', binaryRelative);
	await fs.access(electron);
	assert.equal((await fs.readFile(path.join(directory, 'dist/version'), 'utf8')).trim(), '43.5.0');
	const producer = path.join(owned, 'producer.cjs');
	await build({
		entryPoints: [path.join(root, 'electron/src/diagram-cpu-worker.ts')],
		outfile: path.join(owned, 'diagram-cpu-worker.js'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24'
	});
	await build({
		entryPoints: [path.join(root, 'electron/src/diagram-pdf.ts')],
		outfile: producer,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24',
		external: ['electron']
	});
	const entry = path.join(owned, 'entry.cjs');
	await build({
		stdin: {
			contents: `const assert=require('node:assert/strict');const fs=require('node:fs').promises;const path=require('node:path');(${electronProof.toString()})(...${JSON.stringify([producer, owned, sinkURL])}).catch(error=>{console.error(error);require('electron').app.exit(1);});`,
			resolveDir: root
		},
		outfile: entry,
		platform: 'node',
		format: 'cjs'
	});
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	child = spawn(electron, [entry], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	childDone = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	let timer;
	const result = await Promise.race([
		childDone,
		new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Electron proof timed out')), 90_000);
		})
	]).finally(() => clearTimeout(timer));
	assert.equal(result.code, 0, `Electron exit ${result.code}/${result.signal}`);
	assert.equal(networkHits, 0, 'Owned sink must receive no HTTP/WS requests');
	const pdf = path.join(owned, 'vector.pdf');
	const proof = await command(python, ['-c', pdfStructureProof(), pdf], 'PDF structure');
	console.log(proof.trim());
	await command(pdftoppm, ['-f', '1', '-singlefile', '-scale-to', '1200', '-png', pdf, path.join(owned, 'vector')], 'PDF render');
	await fs.access(path.join(owned, 'vector.png'));
	completed = true;
	console.log(
		`diagram-pdf-electron-smoke: real vector/text/font/page-size proof; owned network ${networkHits}; ${keepProof ? `proof retained at ${owned}` : 'temporary proof removed'}`
	);
} finally {
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill();
		await childDone;
	}
	await new Promise((resolve) => sink.close(resolve));
	assert.ok(path.basename(owned).startsWith('modutex-vector-pdf-') && path.dirname(owned) === (await fs.realpath(os.tmpdir())));
	if (!keepProof || !completed) await fs.rm(owned, { recursive: true, force: true });
}

async function electronProof(producerPath, owned, sinkURL) {
	const { app, BrowserWindow } = require('electron');
	const { renderDiagramSvgToPdf } = require(producerPath);
	assert.equal(process.versions.electron, '43.5.0');
	await fs.mkdir(path.join(owned, 'profile'));
	app.setPath('userData', path.join(owned, 'profile'));
	app.setPath('sessionData', path.join(owned, 'profile'));
	await app.whenReady();
	app.on('window-all-closed', () => {});
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 320 160"><rect x="-10" y="-10" width="320" height="160" fill="#fff"/><path d="M 10 100 L 280 100 L 240 120" stroke="#2458a6" stroke-width="3" fill="none"/><text x="15" y="55" font-family="Arial" font-size="22" fill="#111">Vector labels 123</text></svg>';
	const windows = [],
		sessions = [],
		networkProbes = [];
	const onWindow = (_event, win) => {
		windows.push(win);
		sessions.push(win.webContents.session);
		const preferences = win.webContents.getLastWebPreferences();
		assert.equal(preferences.javascript, false);
		assert.equal(preferences.nodeIntegration, false);
		assert.equal(preferences.contextIsolation, true);
		assert.equal(preferences.sandbox, true);
		assert.equal(preferences.webviewTag, false);
		assert.ok(!preferences.preload);
		assert.equal(win.isVisible(), false);
		win.webContents.once('did-start-loading', () => {
			networkProbes.push(assert.rejects(win.webContents.session.fetch(`${sinkURL}/must-be-blocked`), /./));
		});
	};
	app.on('browser-window-created', onWindow);
	async function cleanupProof() {
		assert.equal(BrowserWindow.getAllWindows().length, 0);
		for (const win of windows) assert.equal(win.isDestroyed(), true);
		for (const ses of sessions) {
			assert.equal(ses.isPersistent(), false);
			assert.equal(await ses.protocol.isProtocolHandled('diagram-pdf'), false);
			assert.equal(ses.listenerCount('will-download'), 0);
		}
	}
	for (const body of [
		`<image href="${sinkURL}/pixel"/>`,
		`<foreignObject><div>label</div></foreignObject>`,
		`<script>fetch('${sinkURL}/script')</script>`,
		`<path d="M0 0L1 1" onload="fetch('${sinkURL}/event')"/>`,
		`<style>@import '${sinkURL}/css';</style>`
	]) {
		await assert.rejects(
			renderDiagramSvgToPdf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160">${body}</svg>`, new AbortController().signal),
			/INVALID_SVG/
		);
	}
	assert.equal(windows.length, 0, 'Malicious SVG rejected before any window/session');
	const controller = new AbortController();
	const result = await renderDiagramSvgToPdf(svg, controller.signal);
	assert.equal(result.widthPx, 320);
	assert.equal(result.heightPx, 160);
	assert.ok(result.pdf.byteLength > 0);
	await cleanupProof();
	await Promise.all(networkProbes);
	await fs.writeFile(path.join(owned, 'vector.pdf'), result.pdf);
	// Real producer cancellation during actual native loading; no PDF replacement or fake readiness.
	const abort = new AbortController();
	const abortOnLoad = (_event, win) => {
		win.webContents.once('did-start-loading', () => abort.abort());
	};
	app.on('browser-window-created', abortOnLoad);
	await assert.rejects(renderDiagramSvgToPdf(svg, abort.signal), /RENDER_ABORTED/);
	app.removeListener('browser-window-created', abortOnLoad);
	await cleanupProof();
	// Wait for the original queued probes, including the abort-on-load race. Also
	// prove retired sessions cannot issue fresh native requests after cleanup.
	await Promise.all(networkProbes);
	for (const ses of sessions) await assert.rejects(ses.fetch(`${sinkURL}/late-after-cleanup`), /./);
	const canceled = new AbortController();
	canceled.abort();
	await assert.rejects(renderDiagramSvgToPdf(svg, canceled.signal), /RENDER_ABORTED/);
	await cleanupProof();
	app.removeListener('browser-window-created', onWindow);
	assert.equal(sessions.length, 2);
	assert.notEqual(sessions[0], sessions[1], 'Each render owns a different memory session');
	console.log(
		'diagram-pdf producer: real print success, validation negatives, native-load abort; owned windows 0/protocol handlers 0/download listeners 0; retired static deny guards retained and late native requests rejected'
	);
	app.exit(0);
}

function pdfStructureProof() {
	return String.raw`
import json, sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
assert len(reader.pages) == 1, 'Expected one viewport-sized page'
page = reader.pages[0]
assert abs(float(page.mediabox.width) - 240) < 1, page.mediabox
assert abs(float(page.mediabox.height) - 120) < 1, page.mediabox
assert 'Vector labels 123' in page.extract_text(), 'Vector label content missing'
operators = [op for args, op in page.get_contents().operations]
assert any(op in (b'Tj', b'TJ') for op in operators), 'No vector text operators'
assert any(op in (b'l', b'c') for op in operators), 'No vector path operators'
assert any(op in (b'S', b's', b'f', b'f*') for op in operators), 'No path painting operators'
resources = page['/Resources'].get_object()
fonts = resources.get('/Font', {}).get_object()
assert fonts, 'No PDF font resources'
embedded = 0
for reference in fonts.values():
    font = reference.get_object()
    descendants = font.get('/DescendantFonts', [font])
    for child in descendants:
        child = child.get_object()
        descriptor = child.get('/FontDescriptor')
        if descriptor and any(key in descriptor.get_object() for key in ('/FontFile', '/FontFile2', '/FontFile3')):
            embedded += 1
assert embedded, 'No embedded vector font'
pending = [resources]
images = 0
while pending:
    resource = pending.pop().get_object()
    objects = resource.get('/XObject')
    for reference in (objects.get_object().values() if objects else []):
        obj = reference.get_object()
        images += obj.get('/Subtype') == '/Image'
        if obj.get('/Subtype') == '/Form':
            pending.append(obj.get('/Resources', {}))
assert images == 0, 'Raster image fallback found'
print(json.dumps({'pages': 1, 'widthPt': float(page.mediabox.width), 'heightPt': float(page.mediabox.height), 'embeddedFonts': embedded, 'vectorText': True, 'vectorPaths': True, 'rasterImages': images}))
`;
}
