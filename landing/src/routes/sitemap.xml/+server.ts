import type { RequestHandler } from './$types';
import { getSiteLanguageAlternates, getSiteUrl, SITE_ORIGIN } from '$lib/site-origin';

const DOC_PATHS = [
	'/docs',
	'/docs/installation',
	'/docs/installation/windows',
	'/docs/getting-started',
	'/docs/live-preview',
	'/docs/visual-editing',
	'/docs/visual-editing/math',
	'/docs/visual-editing/images',
	'/docs/visual-editing/tables',
	'/docs/visual-editing/citations',
	'/docs/visual-editing/smart-selection',
	'/docs/source-editing',
	'/docs/spell-check',
	'/docs/intellisense',
	'/docs/compiling',
	'/docs/projects',
	'/docs/version-control',
	'/docs/collaboration',
	'/docs/mcp'
];

export const prerender = true;

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function createSitemapXml(): string {
	const urls: string[] = [];
	for (const path of ['/', '/download']) {
		const alternates = getSiteLanguageAlternates(path);
		const alternateMarkup = alternates
			.map(({ hreflang, href }) => `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}" />`)
			.join('\n');

		for (const { hreflang, href } of alternates) {
			if (hreflang === 'x-default') continue;
			urls.push(`  <url>\n    <loc>${escapeXml(href)}</loc>\n${alternateMarkup}\n  </url>`);
		}
	}

	for (const path of DOC_PATHS) {
		const url = getSiteUrl(path);
		if (url) urls.push(`  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`);
	}

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
		...urls,
		'</urlset>',
		''
	].join('\n');
}

export const GET: RequestHandler = () => {
	if (!SITE_ORIGIN) return new Response(null, { status: 204 });

	return new Response(createSitemapXml(), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
