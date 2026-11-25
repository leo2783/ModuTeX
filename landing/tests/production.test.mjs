import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parse } from 'svelte/compiler';
import { preview } from 'vite';

const landingRoot = fileURLToPath(new URL('../', import.meta.url));
const buildRoot = join(landingRoot, 'build');
const sourceRoot = join(landingRoot, 'src');
const messageRoot = join(landingRoot, 'messages');
const sourcePath = join(sourceRoot, 'routes', 'download', '+page.svelte');
const locales = ['en', 'zh-Hans', 'zh-Hant', 'de'];
const forbiddenArtifactUrl = /(?:dl\.texpile\.com|updates\.texpile\.com|github\.com\/texpile\/texpile\/(?:releases|download))/i;
const expectedOrigin = process.env.PUBLIC_MODUTEX_SITE_ORIGIN ? new URL(process.env.PUBLIC_MODUTEX_SITE_ORIGIN).origin : undefined;

let server;
let browser;
let baseUrl;
test.before(async () => {
	assert.ok(existsSync(join(buildRoot, 'index.html')), 'Build the landing site before running its tests');
	server = await preview({ root: landingRoot, preview: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
	const address = server.httpServer.address();
	assert.ok(address && typeof address === 'object');
	baseUrl = `http://127.0.0.1:${address.port}`;
	browser = await chromium.launch({ headless: true });
});

test.after(async () => {
	try {
		await browser?.close();
	} finally {
		await server?.close();
	}
});

function findHtmlFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) return findHtmlFiles(entryPath);
		return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
	});
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

async function createLocalOnlyPage(viewport = { width: 390, height: 844 }) {
	const context = await browser.newContext({ viewport });
	const externalRequests = [];
	await context.route('**/*', async (route) => {
		if (new URL(route.request().url()).origin === baseUrl) {
			await route.continue();
		} else {
			externalRequests.push(route.request().url());
			await route.abort();
		}
	});
	return { context, page: await context.newPage(), externalRequests };
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
		assert.deepEqual(headerExternalLinks.sort(), ['https://github.com/leo2783/ModuTeX', 'https://github.com/leo2783/ModuTeX/issues']);
		assert.ok((await page.locator('a[href="https://github.com/leo2783/ModuTeX"]').count()) >= 2);

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
		assert.equal(`${reportUrl.origin}${reportUrl.pathname}`, 'https://github.com/leo2783/ModuTeX/issues/new');
		assert.match(reportUrl.searchParams.get('title') ?? '', /^Translation issue: /);
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

	} finally {
		await context.close();
	}
});

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

test('all locales retain Windows x64 download requirements and no artifact actions at 390px', async () => {
	const { context, page, externalRequests } = await createLocalOnlyPage();
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

test('localized home and installation routes keep only Windows x64 links', async () => {
	const { context, page } = await createLocalOnlyPage();
	try {
		const guide = 'https://github.com/leo2783/ModuTeX/blob/main/docs/user/INSTALLATION.md';
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
			assert.equal(await page.getByRole('link', { name: 'Repository installation guide' }).getAttribute('href'), guide);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
		}
		const windows = await page.goto(`${baseUrl}/docs/installation/windows`);
		assert.equal(windows?.status(), 200);
		assert.equal(await page.getByRole('link', { name: 'Repository installation guide' }).getAttribute('href'), guide);
	} finally {
		await context.close();
	}
});

test('removed installation deep links are not generated', async () => {
	const { context, page } = await createLocalOnlyPage();
	try {
		for (const path of ['/docs/installation/macos', '/docs/installation/linux']) {
			const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
			assert.equal(response?.status(), 404, path);
		}
	} finally {
		await context.close();
	}
});
