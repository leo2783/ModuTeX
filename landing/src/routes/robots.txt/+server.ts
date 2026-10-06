import type { RequestHandler } from './$types';
import { getSiteUrl } from '$lib/site-origin';

export const prerender = true;

export const GET: RequestHandler = () => {
	const lines = ['User-agent: *', 'Allow: /', 'Allow: /download', 'Allow: /docs', 'Allow: /_app/'];
	const sitemapUrl = getSiteUrl('/sitemap.xml');

	if (sitemapUrl) lines.push(`Sitemap: ${sitemapUrl}`);
	lines.push('Crawl-delay: 1');

	return new Response(`${lines.join('\n')}\n`, {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
};
