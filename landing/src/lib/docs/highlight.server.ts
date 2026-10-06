import { codeToHtml } from 'shiki';

/**
 * Build-time only: every docs route prerenders, so this runs once per build, never in the browser.
 * Shiki's own background/color come back inline on the `<pre>` tag; replaced with the caller's own
 * classes so the block matches the site's chrome (border, rounded corners, bg-surface-50) while
 * keeping Shiki's per-token `<span>` colors, which are what actually carry the highlighting.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
	const html = await codeToHtml(code, { lang, theme: 'github-light' });
	return html.replace(
		/<pre[^>]*>/,
		'<pre class="border-surface-200 bg-surface-50 overflow-x-auto rounded-lg border p-4 font-mono text-sm">'
	);
}
