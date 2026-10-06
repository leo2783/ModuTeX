import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, Agent } from 'node:http';
import { mkdtemp, readFile, rm, readdir, lstat, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

if (process.argv.includes('--payload')) {
	await evaluatePayload(process.argv[process.argv.indexOf('--payload') + 1]);
	process.exit(0);
}

async function evaluatePayload(input) {
	assert.ok(input, 'Explicit owned directory payload path required');
	const payload = resolve(input);
	const resources = join(payload, 'resources');
	const { verifyPackagedVendorResources } = await import('../verify-packaged-vendor.mjs');
	const vendor = await verifyPackagedVendorResources(resources);
	const asar = await import('@electron/asar');
	const archive = join(resources, 'app.asar');
	const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
	assert.equal(manifest.main, 'electron/dist/main.js');
	assert.ok(asar.extractFile(archive, manifest.main.split('/').join(sep)).length > 0);
	assert.ok(asar.extractFile(archive, join('electron', 'dist', 'preload.js')).length > 0);
	assert.ok((await readFile(join(resources, 'app-dist/index.html'))).length > 0);
	const archivedPaths = asar.listPackage(archive).map((path) => path.replaceAll('\\', '/'));
	assert.equal(
		archivedPaths.some((path) => /\/node_modules\/node-pty\/lib\/[^/]+\.test\.js$/.test(path)),
		false
	);
	const ptyRoot = join(resources, 'app.asar.unpacked/node_modules/node-pty');
	assert.equal(
		(await readdir(join(ptyRoot, 'lib'))).some((path) => path.endsWith('.test.js')),
		false
	);
	for (const file of [
		'lib/index.js',
		'lib/windowsTerminal.js',
		'lib/windowsPtyAgent.js',
		'prebuilds/win32-x64/conpty.node',
		'prebuilds/win32-x64/conpty_console_list.node',
		'prebuilds/win32-x64/conpty/conpty.dll',
		'prebuilds/win32-x64/conpty/OpenConsole.exe'
	]) {
		assert.ok((await readFile(join(ptyRoot, file))).length > 0, `Required runtime: ${file}`);
	}
	const inventory = [];
	async function walk(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = join(directory, entry.name);
			const info = await lstat(file);
			assert.equal(info.isSymbolicLink(), false, 'Payload inventory must not follow junctions/symlinks');
			if (entry.isDirectory()) await walk(file);
			else {
				const bytes = await readFile(file);
				inventory.push({
					path: file.slice(payload.length + 1).replaceAll('\\', '/'),
					bytes: bytes.length,
					sha256: createHash('sha256').update(bytes).digest('hex')
				});
			}
		}
	}
	await walk(payload);
	inventory.sort((a, b) => a.path.localeCompare(b.path));
	const proof = await realpath(await mkdtemp(join(tmpdir(), 'modutex-alpha-native-')));
	await mkdir(join(proof, 'profile'));
	const profile = await realpath(join(proof, 'profile'));
	const inventorySha256 = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
	await writeFile(join(proof, 'payload-hashes.json'), JSON.stringify(inventory, null, 2));
	console.log(JSON.stringify({ phase: 'pre-launch', payload, proof, files: inventory.length, inventorySha256 }));
	const probe = join(proof, 'native.cjs');
	await writeFile(
		probe,
		`
const {app}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const save=value=>fs.writeFileSync(${JSON.stringify(join(proof, 'pty-result.json'))},JSON.stringify(value,null,2));
app.setPath('userData', ${JSON.stringify(profile)});
app.disableHardwareAcceleration();
app.whenReady().then(()=>{
 assert.equal(process.versions.electron,'43.5.0');
 assert.equal(app.getPath('userData'),process.env.TEXPILE_USER_DATA);
 const pty=require(${JSON.stringify(ptyRoot)});
 // Windows node-pty's documented string form preserves cmd.exe's command tail;
 // an argv array quotes the space-containing echo command as one argument.
 const child=pty.spawn(${JSON.stringify(resolve('C:/Windows/System32/cmd.exe'))},'/d /c echo MODUTEX_ALPHA_NATIVE',{cols:80,rows:24,cwd:${JSON.stringify(proof)},env:process.env});
 let text=''; child.onData(value=>{text=Buffer.from(text+value).subarray(0,4096).toString('utf8')});
 const deadline=setTimeout(()=>{child.kill(); app.exit(1)},5000);
 child.onExit(({exitCode})=>{clearTimeout(deadline);save({exitCode,text});try{assert.equal(exitCode,0);assert.ok(text.includes('MODUTEX_ALPHA_NATIVE'));console.log(JSON.stringify({electron:process.versions.electron,modules:process.versions.modules,nodePty:'PASS'}));app.exit(0)}catch(e){console.error(e.message);app.exit(1)}});
}).catch(e=>{save({error:e.message});console.error(e.message);app.exit(1)});
`,
		'utf8'
	);
	// ABI/resource proof only: the fixed official runtime executes this owned probe,
	// not the packaged app's GUI entry point.
	const exe = resolve(import.meta.dirname, '../../node_modules/electron/dist/electron.exe');
	assert.equal(
		createHash('sha256')
			.update(await readFile(exe))
			.digest('hex'),
		'5456b3c5615efb53c6059e82cc775197aa8f9e2c825f1d646b37388e74bed2ad'
	);
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_START_URL;
	env.TEXPILE_USER_DATA = profile;
	let stdout = '',
		stderr = '';
	let native;
	try {
		native = await new Promise((yes, no) => {
			const child = spawn(exe, [probe], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let timedOut = false;
			let cleanupDeadline;
			const deadline = setTimeout(() => {
				timedOut = true;
				child.kill();
				cleanupDeadline = setTimeout(() => no(new Error('Owned native probe exceeded 15s; child cleanup did not complete')), 3000);
			}, 15000);
			child.stdout.on('data', (bytes) => (stdout += bytes));
			child.stderr.on('data', (bytes) => (stderr += bytes));
			child.on('error', (error) => {
				clearTimeout(deadline);
				no(error);
			});
			child.on('close', (code) => {
				clearTimeout(deadline);
				clearTimeout(cleanupDeadline);
				if (timedOut) no(new Error('Owned native probe exceeded 15s'));
				else code === 0 ? yes({ code, stdout, stderr }) : no(new Error(`Native probe exit ${code}: ${stderr}`));
			});
		});
	} catch (error) {
		await writeFile(join(proof, 'probe-process.json'), JSON.stringify({ error: error.message, stdout, stderr }, null, 2));
		throw error;
	}
	await writeFile(join(proof, 'probe-process.json'), JSON.stringify(native, null, 2));
	console.log(
		JSON.stringify(
			{
				payload,
				proof,
				files: inventory.length,
				inventorySha256,
				vendor,
				native,
				acceptance: 'ABI/resource only; packaged GUI/npx unverified'
			},
			null,
			2
		)
	);
}

if (process.argv.includes('--alpha')) {
	await evaluateAlpha();
	process.exit(0);
}

async function evaluateAlpha() {
	const root = resolve(import.meta.dirname, '../..');
	const require = createRequire(join(root, 'package.json'));
	const internalEntry = require.resolve('app-builder-lib/internal');
	const consumerEntry = join(internalEntry, '../util/electronGet.js');
	// Diagnostic-only file inspection/import of the genuine installed consumer.
	// Production uses the package's official CLI; no module is patched or replaced.
	const builder = await import(pathToFileURL(consumerEntry).href);
	const checksumModule = require('sumchecker');
	const internal = await import('app-builder-lib/internal');
	const manifest = JSON.parse(await readFile(resolve(internalEntry, '../..', 'package.json'), 'utf8'));
	assert.equal(manifest.version, '27.0.0-alpha.9');
	const source = await readFile(consumerEntry, 'utf8');
	assert.match(source, /signal: AbortSignal\.timeout\(10 \* 60 \* 1000\)/);
	const directory = await mkdtemp(join(tmpdir(), 'modutex-alpha-get-'));
	const body = Buffer.from('ModuTeX synthetic alpha downloader artifact\n');
	const checksum = createHash('sha256').update(body).digest('hex');
	const hits = new Map();
	const sockets = new Set();
	let tunnels = 0;
	const origin = createServer((request, response) => {
		hits.set(request.url, (hits.get(request.url) ?? 0) + 1);
		if (request.url === '/retry.bin' && hits.get(request.url) === 1) {
			response.writeHead(503).end('Synthetic transient failure');
			return;
		}
		const send = () => response.writeHead(200, { 'content-length': body.length }).end(body);
		if (request.url === '/slow.bin') setTimeout(send, 300);
		else send();
	});
	const proxy = createServer((_request, response) => response.writeHead(405).end());
	const listen = (server) =>
		new Promise((yes, no) => {
			server.once('error', no);
			server.listen(0, '127.0.0.1', yes);
		});
	await listen(origin);
	await listen(proxy);
	const originPort = origin.address().port;
	proxy.on('connect', (request, socket, head) => {
		assert.equal(request.url, `127.0.0.1:${originPort}`, 'Proxy cannot tunnel to any external target');
		tunnels += 1;
		const target = connect(originPort, '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) target.write(head);
			socket.pipe(target).pipe(socket);
		});
		for (const stream of [socket, target]) {
			sockets.add(stream);
			stream.on('error', () => {
				socket.destroy();
				target.destroy();
			});
			stream.on('close', () => sockets.delete(stream));
		}
	});
	const envKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
	const old = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	const options = (name, extra = {}) => ({
		version: '9.9.9',
		platformName: process.platform,
		arch: process.arch,
		artifactName: name,
		cacheDir: join(directory, 'cache'),
		options: {
			isGeneric: true,
			checksums: { [name]: checksum },
			mirrorOptions: { resolveAssetURL: async () => `http://127.0.0.1:${originPort}/${name}` },
			downloadOptions: { quiet: true, signal: AbortSignal.timeout(5000) },
			...extra
		}
	});
	const report = { builder: manifest.version, checksum, cases: {} };
	try {
		for (const key of envKeys) delete process.env[key];
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
		process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
		process.env.NO_PROXY = '';
		internal.reinitializeProxy();
		const first = await builder.downloadElectronArtifactZip(options('valid.bin'));
		assert.deepEqual(await readFile(first), body);
		const second = await builder.downloadElectronArtifactZip(options('valid.bin'));
		assert.equal(second, first);
		assert.equal(hits.get('/valid.bin'), 1);
		assert.ok(tunnels > 0, 'Real official proxy dispatcher must be used');
		report.cases.downloadChecksumCacheProxy = { passed: true, tunnels };
		await assert.rejects(builder.downloadElectronArtifactZip(options('bad.bin', { checksums: { 'bad.bin': '0'.repeat(64) } })), (error) => {
			assert.ok(error instanceof checksumModule.ChecksumMismatchError);
			assert.equal(error.filename, 'bad.bin');
			assert.equal(error.message, 'Generated checksum for "bad.bin" did not match expected checksum.');
			return true;
		});
		assert.equal(hits.get('/bad.bin'), 1, 'Checksum negative must reach the genuine endpoint exactly once');
		report.cases.badChecksum = 'PASS';
		const start = performance.now();
		await assert.rejects(
			builder.downloadElectronArtifactZip(
				options('slow.bin', {
					downloadOptions: { quiet: true, signal: AbortSignal.timeout(40) }
				})
			),
			(error) => error.name === 'TimeoutError'
		);
		report.cases.boundedSignal = { passed: true, elapsedMs: Math.round(performance.now() - start) };
		const retryFile = await builder.downloadElectronArtifactZip(options('retry.bin'));
		assert.deepEqual(await readFile(retryFile), body);
		assert.equal(hits.get('/retry.bin'), 2);
		report.cases.genuine503Retry = 'PASS';
		console.log(JSON.stringify(report, null, 2));
	} finally {
		for (const key of envKeys) old[key] === undefined ? delete process.env[key] : (process.env[key] = old[key]);
		internal.reinitializeProxy();
		for (const socket of sockets) socket.destroy();
		for (const server of [origin, proxy]) {
			server.closeAllConnections();
			await new Promise((yes, no) => server.close((error) => (error ? no(error) : yes())));
		}
		await rm(directory, { recursive: true, force: true });
	}
}

// Genuine localhost transport, checksum and cache. No substituted downloader,
// fetch patch, fake error or production dependency edits are used by this test.
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'package.json'));
const builderEntry = require.resolve('app-builder-lib/out/util/electronGet.js');
const builderRequire = createRequire(builderEntry);
const getEntry = builderRequire.resolve('@electron/get');
const get = builderRequire('@electron/get');
const builder = require(builderEntry);
const builderSource = await readFile(builderEntry, 'utf8');
assert.match(getEntry.replaceAll('\\', '/'), /node_modules\/@electron\/get\/dist\/index\.js$/);
const version = JSON.parse(await readFile(resolve(getEntry, '../../package.json'), 'utf8')).version;
assert.equal(version, '5.1.0');
assert.match(builderSource, /timeout: \{ request: 10 \* 60 \* 1000 \}/);
assert.match(builderSource, /buildGotProxyAgent/);
assert.match(builderSource, /e\.response\.statusCode >= 500/);
const directory = await mkdtemp(join(tmpdir(), 'modutex-get-compat-'));
const payload = Buffer.from('ModuTeX synthetic downloader compatibility artifact\n', 'utf8');
const hash = createHash('sha256').update(payload).digest('hex');
const hits = new Map();
let agentRequests = 0;
class DenyAgent extends Agent {
	addRequest(request) {
		agentRequests += 1;
		request.destroy(new Error('Synthetic proxy policy denies direct download'));
	}
}
const agent = new DenyAgent();
const server = createServer((request, response) => {
	const name = request.url;
	hits.set(name, (hits.get(name) ?? 0) + 1);
	if (name === '/server-error.bin') {
		response.writeHead(503).end('Synthetic service unavailable');
		return;
	}
	const send = () => {
		response.writeHead(200, { 'content-length': payload.length }).end(payload);
	};
	if (name === '/slow.bin') setTimeout(send, 300);
	else send();
});
await new Promise((resolveListen, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolveListen);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { version, getEntry, directory, hash, cases: {}, compatible: false };
const config = (name, extra = {}) => ({
	version: '9.9.9',
	isGeneric: true,
	artifactName: name,
	checksums: { [name]: hash },
	cacheRoot: join(directory, 'cache'),
	tempDirectory: directory,
	mirrorOptions: { resolveAssetURL: async () => `${origin}/${name}` },
	downloadOptions: { quiet: true },
	...extra
});
const throughBuilder = (name, extra = {}) =>
	builder.downloadElectronArtifactZip({
		version: '9.9.9',
		platformName: process.platform,
		arch: process.arch,
		artifactName: name,
		cacheDir: join(directory, 'builder-cache'),
		electronDownload: config(name, extra)
	});
try {
	const first = await get.downloadArtifact(config('valid.bin'));
	assert.deepEqual(await readFile(first), payload);
	const second = await get.downloadArtifact(config('valid.bin'));
	assert.equal(second, first);
	assert.equal(hits.get('/valid.bin'), 1);
	report.cases.downloadChecksumCache = 'PASS';
	await assert.rejects(get.downloadArtifact(config('bad.bin', { checksums: { 'bad.bin': '0'.repeat(64) } })));
	report.cases.invalidChecksum = 'PASS';
	const started = performance.now();
	let timeoutRejected = false;
	try {
		await throughBuilder('slow.bin', {
			downloadOptions: { quiet: true, timeout: { request: 40 }, signal: AbortSignal.timeout(2000) }
		});
	} catch {
		timeoutRejected = true;
	}
	report.cases.builderTimeout = { timeoutRejected, elapsedMs: Math.round(performance.now() - started) };
	let proxyRejected = false;
	try {
		await throughBuilder('proxy.bin', {
			downloadOptions: { quiet: true, agent: { http: agent, https: agent }, signal: AbortSignal.timeout(2000) }
		});
	} catch {
		proxyRejected = true;
	}
	report.cases.builderAgent = { proxyRejected, agentRequests, directRequests: hits.get('/proxy.bin') ?? 0 };
	let failure;
	try {
		await throughBuilder('server-error.bin');
	} catch (error) {
		failure = error;
	}
	assert.equal(failure?.response?.status, 503);
	report.cases.builder5xx = {
		status: failure.response.status,
		statusCodePresent: typeof failure.response.statusCode === 'number',
		builderStatusCodeRetry: typeof failure.response.statusCode === 'number' && failure.response.statusCode >= 500
	};
	assert.equal(hits.get('/server-error.bin'), 1, 'Observe actual builder retry count, not an inferred predicate alone');
	report.compatible = timeoutRejected && proxyRejected && agentRequests > 0 && report.cases.builder5xx.builderStatusCodeRetry;
	console.log(JSON.stringify(report, null, 2));
	assert.equal(report.compatible, true, 'Restricted override is incompatible; stop rather than patch builder or weaken gates');
} finally {
	agent.destroy();
	server.closeAllConnections();
	await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
	await rm(directory, { recursive: true, force: true });
}
