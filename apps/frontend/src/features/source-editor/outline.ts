import { projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan } from '@modutex/document-core';

export interface OutlineEntry { readonly label: string; readonly level: number; readonly span: SourceSpan }
/** Read existing parser spans, never parse/serialize the source on each keystroke. */
export function sourceOutline(source: SourceDocument, projection: SourceProjection): readonly OutlineEntry[] {
	if (!projectionIsCurrent(source, projection)) throw new Error('STALE_OUTLINE');
	const body = projection.nodes.find((node) => node.kind === 'environment' && node.name === 'document');
	const pending = [...(body?.children ?? projection.nodes)].reverse(), entries: OutlineEntry[] = [];
	while (pending.length) {
		const node = pending.pop()!;
		if (node.kind === 'heading' && node.content) {
			let end = Math.min(node.content.to, node.content.from + 160), label: string;
			try { label = source.read(node.content.from, end); }
			catch { end--; label = source.read(node.content.from, end); } // Avoid cutting a UTF-16 surrogate pair at the preview boundary.
			label = label.replace(/\s+/g, ' ').trim();
			if (end < node.content.to) label += '…';
			entries.push(Object.freeze({ label: label || '未命名章節', span: node.span,
				level: ({ title: 0, section: 0, subsection: 1, subsubsection: 2 } as Record<string, number>)[node.name.replace(/\*$/, '')] ?? 0 }));
		} else pending.push(...[...node.children].reverse());
	}
	return Object.freeze(entries);
}
