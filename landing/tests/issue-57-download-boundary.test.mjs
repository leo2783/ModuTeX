import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parse } from 'svelte/compiler';

const landingRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = join(landingRoot, 'src');
const messageRoot = join(landingRoot, 'messages');
const buildRoot = join(landingRoot, 'build');
const sourcePath = join(sourceRoot, 'routes', 'download', '+page.svelte');
const locales = ['en', 'zh-Hans', 'zh-Hant', 'de'];
const forbiddenArtifactUrl = /(?:dl\.texpile\.com|updates\.texpile\.com|github\.com\/texpile\/texpile\/(?:releases|download))/i;
const chromiumRoot = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
const installedChromiumExecutable = chromium.executablePath();
const chromiumExecutable = existsSync(installedChromiumExecutable)
	? installedChromiumExecutable
	: process.platform === 'win32' && existsSync(chromiumRoot)
		? readdirSync(chromiumRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
				.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
				.map((entry) => join(chromiumRoot, entry.name, 'chrome-win64', 'chrome.exe'))
				.find((candidate) => existsSync(candidate))
		: undefined;

assert.ok(chromiumExecutable, 'a Chromium executable is required for the real landing UI test');
assert.ok(existsSync(join(buildRoot, 'index.html')), 'build the landing site before running this test');

async function findAvailablePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

function collectNodes(root) {
	const nodes = [];
	const pending = [root];
	const seen = new Set();
	while (pending.length > 0) {
		const value = pending.pop();
		if (Array.isArray(value)) {
			pending.push(...value);
		} else if (value && typeof value === 'object' && !seen.has(value)) {
			seen.add(value);
			nodes.push(value);
			pending.push(...Object.values(value));
		}
	}
	return nodes;
}

function textFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) return textFiles(entryPath);
		return entry.isFile() && /\.(?:html|js|css|json|xml|txt)$/i.test(entry.name) ? [entryPath] : [];
	});
}

function localizedPath(path, locale) {
	const prefix = locale === 'en' ? '' : `/${locale}`;
	return path === '/' ? `${prefix}/` : `${prefix}${path}`;
}

const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const preview = spawn(
	process.execPath,
	[
		join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
		'preview',
		'--host',
		'127.0.0.1',
		'--port',
		String(port),
		'--strictPort'
	],
	{ cwd: landingRoot, stdio: 'ignore', windowsHide: true, shell: false }
);

let previewSpawnError;
preview.on('error', (error) => {
	previewSpawnError = error;
});

function hasExited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

function assertPreviewCanServe(child, getSpawnError) {
	const spawnError = getSpawnError();
	if (spawnError) throw new Error('landing preview failed to start', { cause: spawnError });
	if (child.exitCode !== null) throw new Error(`landing preview exited with code ${child.exitCode}`);
	if (child.signalCode !== null) throw new Error(`landing preview exited with signal ${child.signalCode}`);
}

async function waitForPreview(child, getSpawnError) {
	const startupSignal = AbortSignal.timeout(10_000);
	for (let attempt = 0; attempt < 40; attempt += 1) {
		assertPreviewCanServe(child, getSpawnError);
		let response;
		try {
			response = await fetch(`${baseUrl}/`, { signal: startupSignal });
		} catch {
			// Vite preview is still starting.
		}
		assertPreviewCanServe(child, getSpawnError);
		if (response?.ok) return;
		if (startupSignal.aborted) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assertPreviewCanServe(child, getSpawnError);
	throw new Error('landing preview did not start');
}

let browser;
test.before(async () => {
	browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
});

test.after(async () => {
	let browserCloseError;
	let previewCleanupError;
	try {
		await browser?.close();
	} catch (error) {
		browserCloseError = error;
	} finally {
		try {
			await stopPreview(preview);
		} catch (error) {
			previewCleanupError = error;
		}
	}

	if (browserCloseError && previewCleanupError) {
		throw new AggregateError([browserCloseError, previewCleanupError], 'browser and landing preview cleanup failed', {
			cause: browserCloseError
		});
	}
	if (browserCloseError) throw browserCloseError;
	if (previewCleanupError) throw previewCleanupError;
});

function waitForPreviewExit(child, timeoutMs) {
	if (hasExited(child)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let processError;
		const cleanup = () => {
			clearTimeout(timer);
			child.removeListener('exit', onExit);
			child.removeListener('error', onError);
		};
		const onExit = () => {
			cleanup();
			if (processError && processError.code !== 'ESRCH') {
				reject(new Error('landing preview failed while stopping', { cause: processError }));
			} else {
				resolve();
			}
		};
		const onError = (error) => {
			processError = error;
		};
		const timer = setTimeout(() => {
			cleanup();
			const timeoutError = new Error(`landing preview did not exit within ${timeoutMs}ms`);
			reject(processError ? new AggregateError([processError, timeoutError], 'landing preview cleanup failed') : timeoutError);
		}, timeoutMs);
		child.once('exit', onExit);
		child.on('error', onError);
		if (hasExited(child)) onExit();
	});
}

async function stopPreview(child) {
	if (hasExited(child)) return;
	if (!child.pid) {
		if (previewSpawnError) return;
		throw new Error('landing preview has no process ID and has not exited');
	}
	const exit = waitForPreviewExit(child, 5_000);
	child.kill();
	await exit;
}

await waitForPreview(preview, () => previewSpawnError);

test('Svelte source and production artifacts contain no public artifact flow', () => {
	const source = readFileSync(sourcePath, 'utf8');
	const ast = parse(source, { modern: true });
	const templateNodes = collectNodes(ast.fragment);
	const scriptNodes = collectNodes(ast.instance?.content);
	const hasDownloadAttribute = templateNodes.some(
		(node) =>
			node.type === 'RegularElement' && Array.isArray(node.attributes) && node.attributes.some((attribute) => attribute.name === 'download')
	);
	const hasEventHandler = templateNodes.some(
		(node) =>
			Array.isArray(node.attributes) &&
			node.attributes.some((attribute) => typeof attribute.name === 'string' && attribute.name.startsWith('on'))
	);
	const hasManifestFetch = scriptNodes.some(
		(node) => node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'fetch'
	);
	assert.equal(hasDownloadAttribute, false, 'the compiled Svelte template has no download attribute');
	assert.equal(hasEventHandler, false, 'the route has no click, fallback, or modal event handler');
	assert.equal(hasManifestFetch, false, 'the route does not fetch a release manifest');
	assert.doesNotMatch(source, forbiddenArtifactUrl, 'the route source has no unverified artifact URL');

	const productionFiles = [...textFiles(sourceRoot), ...textFiles(messageRoot), ...textFiles(buildRoot)];
	assert.ok(productionFiles.length > 0);
	for (const file of productionFiles) {
		assert.doesNotMatch(readFileSync(file, 'utf8'), forbiddenArtifactUrl, file);
	}
});

test('four production routes retain Windows x64 requirements and no artifact actions at 390px', async () => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const externalRequests = [];
	await context.route('**/*', async (route) => {
		if (new URL(route.request().url()).origin === baseUrl) {
			await route.continue();
		} else {
			externalRequests.push(route.request().url());
			await route.abort();
		}
	});
	const page = await context.newPage();
	try {
		let expectedLocaleKeys;
		for (const locale of locales) {
			const messages = JSON.parse(readFileSync(join(messageRoot, `${locale}.json`), 'utf8'));
			const keys = Object.keys(messages).sort();
			if (expectedLocaleKeys) assert.deepEqual(keys, expectedLocaleKeys, `${locale} message-key parity`);
			else expectedLocaleKeys = keys;

			const response = await page.goto(`${baseUrl}${localizedPath('/download', locale)}`, { waitUntil: 'networkidle' });
			assert.equal(response?.status(), 200, `download route: ${locale}`);
			assert.equal(await page.locator('h1').innerText(), messages.dl_heading, `localized heading: ${locale}`);
			const bodyText = await page.locator('body').innerText();
			assert.ok(bodyText.includes(messages.dl_subheading), `localized requirements are visible: ${locale}`);
			assert.match(bodyText, /Windows\s+x64/i, `Windows x64 is explicit: ${locale}`);
			assert.match(bodyText, /TeX Live|MiKTeX/i, `PDF compilation dependency is explicit: ${locale}`);
			assert.equal(await page.locator('a[download]').count(), 0, `no download attribute: ${locale}`);
			assert.equal(await page.locator('[role="dialog"], [role="presentation"]').count(), 0, `no download modal: ${locale}`);
			assert.equal(await page.getByRole('button', { name: /download|installer/i }).count(), 0, `no download CTA: ${locale}`);

			const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
			for (const href of hrefs) assert.doesNotMatch(href, forbiddenArtifactUrl, `no artifact href: ${locale}`);
			assert.ok((await page.locator('footer a[href="/download"]').count()) >= 1, `internal download navigation remains: ${locale}`);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `390px layout: ${locale}`);

			const keyboardFocus = [];
			for (let step = 0; step < 40; step += 1) {
				await page.keyboard.press('Tab');
				keyboardFocus.push(
					await page.evaluate(() => ({
						href: document.activeElement?.getAttribute('href') ?? null,
						hasDownload: document.activeElement?.hasAttribute('download') ?? false
					}))
				);
			}
			assert.ok(keyboardFocus.length > 0);
			assert.equal(
				keyboardFocus.some((focus) => focus.hasDownload),
				false,
				`no hidden download target receives focus: ${locale}`
			);
		}

		const homeResponse = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
		assert.equal(homeResponse?.status(), 200);
		const homeDownloadLink = page.locator('a[href="/download"]').filter({ visible: true }).first();
		await homeDownloadLink.focus();
		await page.keyboard.press('Enter');
		await page.waitForURL(`${baseUrl}/download`);
		assert.equal(await page.locator('h1').innerText(), JSON.parse(readFileSync(join(messageRoot, 'en.json'), 'utf8')).dl_heading);
		assert.deepEqual(externalRequests, [], 'production routes must not request public artifacts or upstream services');
	} finally {
		await context.close();
	}
});
