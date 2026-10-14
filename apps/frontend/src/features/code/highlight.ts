import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';

// Bound synchronous parser and token DOM work; oversized blocks remain editable literal text.
export const MAX_HIGHLIGHT_UNITS = 100_000;

/** Same lazy parsers for the editable draft and rendered cells. Text never becomes HTML. */
export function highlightCode(host: HTMLElement, code: string, language: string): () => void {
	let cancelled = false;
	host.textContent = code;
	if (code.length > MAX_HIGHLIGHT_UNITS) return () => { cancelled = true; };
	const aliases: Record<string, string> = { cpp: 'C++', bash: 'Shell', wsl: 'Shell' };
	const description = languages.find(entry => entry.name.toLowerCase() === (aliases[language] ?? language).toLowerCase()
		|| entry.name.toLowerCase().replaceAll('+', 'plus').replaceAll('#', 'sharp').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === language);
	if (description) void description.load().then(support => {
		if (cancelled) return;
		const fragment = host.ownerDocument.createDocumentFragment(); let position = 0;
		highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, classes) => {
			if (from > position) fragment.append(code.slice(position, from));
			const token = host.ownerDocument.createElement('span'); token.className = classes; token.textContent = code.slice(from, to); fragment.append(token); position = to;
		});
		fragment.append(code.slice(position)); if (!cancelled) host.replaceChildren(fragment);
	}).catch(() => { /* Keep the literal text available if a language chunk cannot load. */ });
	return () => { cancelled = true; };
}
