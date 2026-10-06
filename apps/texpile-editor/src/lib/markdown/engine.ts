// The one markdown-it instance config for the editor importer (worker-safe: no DOM at module
// load). The default preset already includes GFM tables and ~~strikethrough~~.
import markdownit from 'markdown-it';
import type { MarkdownIt } from 'markdown-it';
import { mathPlugin } from './math';

export function createMarkdownEngine(): MarkdownIt {
	const md = markdownit({ html: true, linkify: false, typographer: false });
	md.use(mathPlugin);
	return md;
}
