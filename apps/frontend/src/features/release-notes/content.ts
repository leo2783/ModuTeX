export type ContentBlock = { readonly kind: 'heading'; readonly text: string } | { readonly kind: 'paragraph'; readonly text: string } | { readonly kind: 'list'; readonly items: readonly string[] } | { readonly kind: 'code'; readonly text: string; readonly language: string };
export interface ReleaseNote { readonly version: string; readonly status: string; readonly blocks: readonly ContentBlock[] }
export type InlinePart = { readonly kind: 'text' | 'code'; readonly text: string } | { readonly kind: 'link'; readonly text: string; readonly href: '#/release-notes/limitations' };
function lines(source: string): string[] {
	if (source.length > 128 * 1024) throw new Error('NOTES_TOO_LARGE');
	return source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
}
/** Deliberate Markdown subset; arbitrary HTML and unknown syntax remain literal text. */
export function contentBlocks(source: string): readonly ContentBlock[] {
	const blocks: ({ kind: 'heading' | 'paragraph'; text: string } | { kind: 'list'; items: string[] } | { kind: 'code'; text: string; language: string })[] = [];
	let code: string[] | null = null, language = '';
	for (const line of lines(source)) {
		const fence = /^```([\w+-]*)\s*$/.exec(line);
		if (code) {
			if (fence && !fence[1]) { blocks.push({ kind: 'code', text: code.join('\n'), language }); code = null; }
			else code.push(line);
			continue;
		}
		if (fence) { code = []; language = fence[1]!; continue; }
		if (!line.trim()) continue;
		const heading = /^#{1,6} (.+)$/.exec(line);
		if (heading) { blocks.push({ kind: 'heading', text: heading[1]! }); continue; }
		if (line.startsWith('- ')) {
			const last = blocks.at(-1);
			if (last?.kind === 'list') last.items.push(line.slice(2));
			else blocks.push({ kind: 'list', items: [line.slice(2)] });
		} else blocks.push({ kind: 'paragraph', text: line });
	}
	if (code) throw new Error('UNCLOSED_CODE_BLOCK');
	return Object.freeze(blocks.map((block) => Object.freeze(block.kind === 'list' ? { ...block, items: Object.freeze(block.items) } : block)));
}
export function releaseNotes(source: string): readonly ReleaseNote[] {
	const releases: ReleaseNote[] = []; let version = '', status = '', body: string[] = [];
	const finish = () => { if (version) releases.push(Object.freeze({ version, status, blocks: contentBlocks(body.join('\n')) })); };
	for (const line of lines(source)) {
		const heading = /^## \[([^\]\r\n]+)\](?:\s+[—-]\s+(.+))?$/.exec(line);
		if (heading) {
			finish(); version = heading[1]!; status = heading[2] ?? ''; body = [];
			if (releases.length >= 100 || releases.some((entry) => entry.version === version)) throw new Error('INVALID_RELEASE_INDEX');
		} else if (version) body.push(line);
	}
	finish(); return Object.freeze(releases);
}
export function inlineParts(text: string): readonly InlinePart[] {
	const parts: InlinePart[] = []; const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(docs\/user\/KNOWN_LIMITATIONS\.md\)/g; let from = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index! > from) parts.push({ kind: 'text', text: text.slice(from, match.index) });
		parts.push(match[1] !== undefined ? { kind: 'code', text: match[1] } : { kind: 'link', text: match[2]!, href: '#/release-notes/limitations' });
		from = match.index! + match[0].length;
	}
	if (from < text.length) parts.push({ kind: 'text', text: text.slice(from) });
	return parts;
}
