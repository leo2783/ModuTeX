import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const landingRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;
const chromiumRoot = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
const chromiumExecutable = [
	chromium.executablePath(),
	...readdirSync(chromiumRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
		.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
		.map((entry) => join(chromiumRoot, entry.name, 'chrome-win64', 'chrome.exe'))
].find((candidate) => existsSync(candidate));
assert.ok(chromiumExecutable, 'a Chromium executable is required for the real landing UI test');

function startPreview() {
	assert.ok(existsSync(join(landingRoot, 'build', 'index.html')), 'build the landing site before running the UI test');
	return spawn(
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
		{
			cwd: landingRoot,
			stdio: 'ignore',
			windowsHide: true,
			shell: false
		}
	);
}

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

const preview = startPreview();
let previewSpawnError;
preview.on('error', (error) => {
	previewSpawnError = error;
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

test.after(() => {
	return stopPreview(preview);
});

await waitForPreview(preview, () => previewSpawnError);

test('download route has no public artifact action and retains Windows x64 requirements', async () => {
	const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	try {
		const homeResponse = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
		assert.equal(homeResponse?.status(), 200);
		const internalDownloadLink = page.locator('a[href="/download"]').filter({ visible: true }).first();
		assert.ok((await internalDownloadLink.count()) >= 1, 'home keeps its internal download-route link');
		await internalDownloadLink.focus();
		assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), '/download');
		await page.keyboard.press('Enter');
		await page.waitForURL(`${baseUrl}/download`);

		const routeText = await page.locator('body').innerText();
		assert.match(routeText, /Windows\s+x64/i);
		assert.match(routeText, /TeX Live|MiKTeX/i);
		assert.equal(await page.locator('a[download]').count(), 0, 'no public artifact link remains');
		assert.equal(await page.locator('[role="presentation"]').count(), 0, 'no download overlay/modal remains');
		const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
		for (const href of hrefs)
			assert.doesNotMatch(href, /dl\.texpile\.com|updates\.texpile\.com|github\.com\/texpile\/texpile\/(?:releases|download)/i);
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
	} finally {
		await browser.close();
	}
});

test('localized home and installation routes keep only Windows x64 links', async () => {
	const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	try {
		for (const locale of ['', 'zh-Hans/', 'zh-Hant/', 'de/']) {
			const home = await page.goto(`${baseUrl}/${locale}`, { waitUntil: 'networkidle' });
			assert.equal(home?.status(), 200);
			assert.ok((await page.locator('a[href="/download"]').count()) >= 1);
			assert.doesNotMatch(await page.locator('body').innerText(), /for Windows, macOS, and Linux/i);

			const installation = await page.goto(`${baseUrl}/${locale}docs/installation`, { waitUntil: 'networkidle' });
			assert.equal(installation?.status(), 200);
			const installationText = await page.locator('body').innerText();
			assert.doesNotMatch(installationText, /macOS|Linux|AppImage|\.dmg|\.deb/i);
			assert.ok((await page.locator('a[href="/docs/installation/windows"]').count()) >= 1);
			assert.equal(await page.locator('a[href*="/docs/installation/macos"]').count(), 0);
			assert.equal(await page.locator('a[href*="/docs/installation/linux"]').count(), 0);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
		}
	} finally {
		await browser.close();
	}
});

test('removed installation deep links are not generated', async () => {
	const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
	const page = await browser.newPage();
	try {
		for (const path of ['/docs/installation/macos', '/docs/installation/linux']) {
			const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
			assert.equal(response?.status(), 404, path);
		}
	} finally {
		await browser.close();
	}
});
