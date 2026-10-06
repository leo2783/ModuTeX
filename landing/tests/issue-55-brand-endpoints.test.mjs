import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const landingRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildRoot = join(landingRoot, 'build');
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

const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const expectedOrigin = process.env.PUBLIC_MODUTEX_SITE_ORIGIN ? new URL(process.env.PUBLIC_MODUTEX_SITE_ORIGIN).origin : undefined;
const locales = ['en', 'zh-Hans', 'zh-Hant', 'de'];
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

function startPreview() {
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
			windowsHide: true
		}
	);
}

function findHtmlFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) return findHtmlFiles(entryPath);
		return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
	});
}

async function waitForPreview(preview) {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (preview.exitCode !== null) throw new Error(`landing preview exited with code ${preview.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/`);
			if (response.ok) return;
		} catch {
			// Vite preview is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('landing preview did not start');
}

const preview = startPreview();

let browser;
test.before(async () => {
	browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
});

test.after(async () => {
	await browser?.close();
	if (preview.exitCode === null && preview.signalCode === null) {
		preview.kill();
		await new Promise((resolve) => preview.once('exit', resolve));
	}
});

await waitForPreview(preview);

async function createLocalOnlyPage(viewport = { width: 390, height: 844 }) {
	const context = await browser.newContext({ viewport });
	await context.route('**/*', async (route) => {
		if (new URL(route.request().url()).origin === baseUrl) {
			await route.continue();
		} else {
			await route.abort();
		}
	});
	return { context, page: await context.newPage() };
}

function localizedPath(path, locale) {
	const prefix = locale === 'en' ? '' : `/${locale}`;
	return path === '/' ? `${prefix}/` : `${prefix}${path}`;
}

async function assertUrlMetadata(page, { path, locale, includeAlternates = false, localeIndependent = false }) {
	const canonical = page.locator('link[rel="canonical"]');
	const ogUrl = page.locator('meta[property="og:url"]');
	const twitterUrl = page.locator('meta[property="twitter:url"]');
	const alternates = page.locator('link[rel="alternate"][hreflang]');

	if (!expectedOrigin) {
		assert.equal(await canonical.count(), 0, 'unset site origin must omit canonical URL metadata');
		assert.equal(await ogUrl.count(), 0, 'unset site origin must omit Open Graph URL metadata');
		assert.equal(await twitterUrl.count(), 0, 'unset site origin must omit Twitter URL metadata');
		assert.equal(await alternates.count(), 0, 'unset site origin must omit hreflang URL metadata');
		return;
	}

	const expectedPath = localeIndependent ? path : localizedPath(path, locale);
	const expectedUrl = new URL(expectedPath, `${expectedOrigin}/`).href;
	assert.equal(await canonical.getAttribute('href'), expectedUrl);
	assert.equal(await ogUrl.getAttribute('content'), expectedUrl);
	assert.equal(await twitterUrl.getAttribute('content'), expectedUrl);

	if (includeAlternates) {
		const actualAlternates = await alternates.evaluateAll((items) =>
			items.map((item) => ({ language: item.getAttribute('hreflang'), url: item.getAttribute('href') }))
		);
		assert.deepEqual(actualAlternates, [
			...locales.map((alternateLocale) => ({
				language: alternateLocale,
				url: new URL(localizedPath(path, alternateLocale), `${expectedOrigin}/`).href
			})),
			{ language: 'x-default', url: new URL(path, `${expectedOrigin}/`).href }
		]);
	} else {
		assert.equal(await alternates.count(), 0);
	}
}

test('build artifacts omit or consistently use the configured site origin', async () => {
	const robotsPath = join(buildRoot, 'robots.txt');
	const sitemapPath = join(buildRoot, 'sitemap.xml');
	assert.ok(existsSync(robotsPath), 'robots.txt is generated from its server route');
	const robots = readFileSync(robotsPath, 'utf8');
	const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
	const sitemapResponse = await fetch(`${baseUrl}/sitemap.xml`);
	assert.equal(robotsResponse.status, 200, 'production robots endpoint is served');
	assert.equal(await robotsResponse.text(), robots, 'served robots endpoint matches the generated artifact');
	const htmlFiles = findHtmlFiles(buildRoot);
	assert.ok(htmlFiles.length > 0, 'production build must contain prerendered HTML routes');
	for (const htmlFile of htmlFiles) {
		const html = readFileSync(htmlFile, 'utf8');
		assert.doesNotMatch(html, /discord\.com\/invite|support@texpile\.com/i, htmlFile);
		const urlMetadata = html.match(/<(?:link|meta)\b[^>]*>/gi) ?? [];
		for (const tag of urlMetadata) {
			if (/rel="(?:canonical|alternate)"|property="(?:og:url|twitter:url)"/i.test(tag)) {
				assert.doesNotMatch(tag, /https:\/\/(?:texpile\.com|github\.com\/texpile)/i, htmlFile);
			}
		}
	}

	if (!expectedOrigin) {
		assert.equal(existsSync(sitemapPath), false, 'unset origin must not emit a static sitemap');
		assert.doesNotMatch(robots, /^Sitemap:/im);
		assert.equal(sitemapResponse.status, 404, 'unset origin must leave no production sitemap endpoint');
		return;
	}

	assert.ok(existsSync(sitemapPath), 'configured origin must produce sitemap.xml');
	assert.match(robots, new RegExp(`^Sitemap: ${expectedOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sitemap\\.xml$`, 'm'));
	const sitemap = readFileSync(sitemapPath, 'utf8');
	assert.equal(sitemapResponse.status, 200, 'configured sitemap endpoint is served');
	assert.match(sitemapResponse.headers.get('content-type') ?? '', /^(?:application|text)\/xml\b/i);
	assert.equal(await sitemapResponse.text(), sitemap, 'served sitemap endpoint matches the generated artifact');
	assert.match(sitemap, /<urlset\b/);
	assert.match(sitemap, new RegExp(`<loc>${expectedOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/zh-Hans/</loc>`));
	assert.match(sitemap, new RegExp(`<loc>${expectedOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/zh-Hant/download</loc>`));
	assert.match(sitemap, new RegExp(`<loc>${expectedOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/docs</loc>`));
	assert.doesNotMatch(sitemap, /\/de\/docs(?:<|\/)/, 'English-only docs keep their single canonical sitemap URL');
	assert.doesNotMatch(sitemap, /texpile\.com|discord\.com/i);
});

test('production routes preserve all locales and site metadata contract', async () => {
	const { context, page } = await createLocalOnlyPage();
	try {
		for (const locale of locales) {
			const homeResponse = await page.goto(`${baseUrl}${localizedPath('/', locale)}`, { waitUntil: 'networkidle' });
			assert.equal(homeResponse?.status(), 200, `home route: ${locale}`);
			await assertUrlMetadata(page, { path: '/', locale, includeAlternates: true });

			const jsonLd = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? '{}');
			assert.equal(jsonLd.name, 'ModuTeX');
			assert.equal(jsonLd.creator.name, 'ModuTeX');
			if (expectedOrigin) {
				assert.equal(jsonLd.url, new URL('/', `${expectedOrigin}/`).href);
			} else {
				assert.equal('url' in jsonLd, false);
			}

			const downloadResponse = await page.goto(`${baseUrl}${localizedPath('/download', locale)}`, {
				waitUntil: 'networkidle'
			});
			assert.equal(downloadResponse?.status(), 200, `download route: ${locale}`);
			await assertUrlMetadata(page, { path: '/download', locale, includeAlternates: true });

			assert.ok(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
				`route has horizontal overflow at 390px: ${locale}`
			);
		}

		for (const locale of locales) {
			const docsResponse = await page.goto(`${baseUrl}${localizedPath('/docs', locale)}`, { waitUntil: 'networkidle' });
			assert.equal(docsResponse?.status(), 200, `docs route: ${locale}`);
			await assertUrlMetadata(page, { path: '/docs', locale, localeIndependent: true });
			assert.equal(await page.title(), 'Documentation - ModuTeX docs');
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
		}
	} finally {
		await context.close();
	}
});

test('landing identity, report links, keyboard menu, and 390px viewport stay local and usable', async () => {
	const { context, page } = await createLocalOnlyPage({ width: 390, height: 844 });
	try {
		const homeResponse = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
		assert.equal(homeResponse?.status(), 200);
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

		const headerExternalLinks = await page
			.locator('header a[href^="https://"]')
			.evaluateAll((items) => items.map((item) => item.getAttribute('href')));
		assert.deepEqual(headerExternalLinks.sort(), ['https://github.com/leo2783/latex', 'https://github.com/leo2783/latex/issues']);
		assert.ok((await page.locator('a[href="https://github.com/leo2783/latex"]').count()) >= 2);

		const languageTrigger = page.locator('header button').first();
		assert.ok(await languageTrigger.isVisible());
		await languageTrigger.focus();
		await languageTrigger.press('Enter');
		const languageOptions = page.getByRole('menuitem');
		await languageOptions.first().waitFor({ state: 'visible' });
		const germanOption = page.getByRole('menuitem').filter({ hasText: 'Deutsch' });
		for (let step = 0; step < locales.length - 1; step += 1) await page.keyboard.press('ArrowDown');
		assert.match(
			await page.evaluate(() => document.activeElement?.textContent ?? ''),
			/Deutsch/,
			'ArrowDown keyboard navigation focuses the German locale item'
		);
		await germanOption.press('Enter');
		await page.waitForURL(`${baseUrl}/de`);
		assert.equal(await languageOptions.first().isVisible(), false, 'keyboard selection closes the locale menu');

		const reportLink = page.locator('a[href*="/issues/new?title="]');
		assert.equal(await reportLink.count(), 1);
		const reportUrl = new URL((await reportLink.getAttribute('href')) ?? '');
		assert.equal(`${reportUrl.origin}${reportUrl.pathname}`, 'https://github.com/leo2783/latex/issues/new');
		assert.match(reportUrl.searchParams.get('title') ?? '', /^Translation issue: /);
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

		const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
		assert.match(readme, /https:\/\/github\.com\/leo2783\/latex\/issues/);
		assert.doesNotMatch(readme, /discord\.com\/invite|support@texpile\.com/i);
	} finally {
		await context.close();
	}
});
