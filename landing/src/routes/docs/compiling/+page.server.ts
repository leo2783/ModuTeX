import { highlightCode } from '$lib/docs/highlight.server';

export const prerender = true;

export async function load() {
	return { commandHtml: await highlightCode('latexmk -pdf {main}', 'bash') };
}
