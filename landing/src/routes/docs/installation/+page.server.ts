import { highlightCode } from '$lib/docs/highlight.server';

export const prerender = true;

export async function load() {
	return { verify: await highlightCode('latexmk --version', 'bash') };
}
