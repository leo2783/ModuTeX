import { projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan, type SyntaxNode } from '../document-core/core.ts';

export interface OutlineEntry { readonly label: string; readonly level: number; readonly span: SourceSpan }
const labelEscapes: Readonly<Record<string, string>> = { '\\\\': ' ', '\\%': '%', '\\&': '&', '\\$': '$', '\\#': '#', '\\_': '_', '\\{': '{', '\\}': '}',
	'\\textbackslash{}': '\\', '\\textasciicircum{}': '^', '\\textasciitilde{}': '~' };
/** Strip parser-recognized formatting without interpreting unknown commands or HTML. */
function headingLabel(source: SourceDocument, heading: SyntaxNode): string {
	const pending = [...heading.children].reverse();
	let label = '', truncated = false;
	while (pending.length) {
		const node = pending.pop()!;
		if (node.kind === 'format' && node.content) { pending.push(...[...node.children].reverse()); continue; }
		const remaining = 160 - label.length;
		let end = Math.min(node.span.to, node.span.from + remaining), value: string;
		try { value = source.read(node.span.from, end); }
		catch { value = source.read(node.span.from, --end); }
		label += labelEscapes[value] ?? value;
		if (end < node.span.to || label.length >= 160 && pending.length > 0) { truncated = true; break; }
	}
	return label.replace(/\s+/g, ' ').trim() + (truncated ? '…' : '');
}
/** Read existing parser spans, never parse/serialize the source on each keystroke. */
export function sourceOutline(source: SourceDocument, projection: SourceProjection): readonly OutlineEntry[] {
	if (!projectionIsCurrent(source, projection)) throw new Error('STALE_OUTLINE');
	const body = projection.nodes.find((node) => node.kind === 'environment' && node.name === 'document');
	const nodes = body?.children ?? projection.nodes;
	const names = new Set(nodes.filter(node => node.kind === 'heading').map(node => node.name.replace(/\*$/, '')));
	const sectionLevel = names.has('part') ? 2 : names.has('chapter') ? 1 : 0;
	const pending = [...(body?.children ?? projection.nodes)].reverse(), entries: OutlineEntry[] = [];
	while (pending.length) {
		const node = pending.pop()!;
		if (node.kind === 'heading' && node.content) {
			const label = headingLabel(source, node);
			entries.push(Object.freeze({ label: label || '未命名章節', span: node.span,
				level: ({ title: 0, part: 0, chapter: names.has('part') ? 1 : 0, section: sectionLevel, subsection: sectionLevel + 1, subsubsection: sectionLevel + 2 } as Record<string, number>)[node.name.replace(/\*$/, '')] ?? 0 }));
		} else pending.push(...[...node.children].reverse());
	}
	return Object.freeze(entries);
}
