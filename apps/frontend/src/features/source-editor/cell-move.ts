import type { EditorState } from '@codemirror/state';
import { parseSource, type SourceSpan } from '../document-core/core.ts';
import { projectVisual } from '../visual-editor/schema.ts';
import { CELL_END } from '../visual-editor/cell-boundaries.ts';
import { sourceState, sourcePatchTransaction } from './state.ts';

/** Rotate cell contents, retaining the exact separators and one shared undo entry. */
export function cellMoveTransaction(state: EditorState, cells: readonly SourceSpan[], index: number, boundary: number) {
	const source = state.field(sourceState).projection.document;
	if (!Number.isInteger(index) || !Number.isInteger(boundary) || index < 0 || index >= cells.length || boundary < 0 || boundary > cells.length) throw new Error('CELL_MOVE_RANGE');
	const document = parseSource(source).nodes.find(node => node.kind === 'environment' && node.name === 'document');
	const sorted = [...cells].sort((left, right) => left.from - right.from || left.to - right.to);
	for (let i = 0; i < sorted.length; i++) {
		const span = sorted[i]!;
		if (span.documentId !== source.documentId || span.version !== source.version || span.from < 0 || span.to < span.from || span.to > source.length || i > 0 && sorted[i - 1]!.to > span.from) throw new Error('STALE_CELL_MOVE');
	}
	const bodyIndexes = document?.content
		? cells.flatMap((span, visualIndex) => span.from >= document.content!.from && span.to <= document.content!.to ? [visualIndex] : [])
		: cells.map((_span, visualIndex) => visualIndex);
	const bodyCells = bodyIndexes.map(visualIndex => cells[visualIndex]!);
	if (bodyCells.some((span, i) => i > 0 && bodyCells[i - 1]!.to > span.from)) throw new Error('CELL_MOVE_BODY_ORDER');
	const bodyIndex = bodyIndexes.indexOf(index);
	if (bodyIndex < 0) throw new Error('CELL_MOVE_METADATA');
	const bodyBoundary = bodyIndexes.filter(visualIndex => visualIndex < boundary).length;
	if (bodyBoundary === bodyIndex || bodyBoundary === bodyIndex + 1) return null;
	const destination = bodyBoundary > bodyIndex ? bodyBoundary - 1 : bodyBoundary;
	const first = Math.min(bodyIndex, destination), last = Math.max(bodyIndex, destination);
	const projection = projectVisual(source, parseSource(source)), projected = projection.document;
	const paragraphs = new Map<string, { start: boolean; end: boolean }>();
	const paragraph = (index: number) => { const node = projected.child(index); return node.type.name === 'source_block' && node.attrs.role === 'paragraph'; };
	projected.forEach((node, _position, index) => {
		const cell = projection.cellBounds?.[index];
		if (cell && cell.first !== index) return;
		paragraphs.set(`${cell?.from ?? node.attrs.from}:${cell?.to ?? node.attrs.to}`, { start: paragraph(index), end: paragraph(cell?.last ?? index) });
	});
	const spans = bodyCells.slice(first, last + 1), contents = spans.map(span => ({ text: source.read(span.from, span.to), ...paragraphs.get(`${span.from}:${span.to}`) }));
	const [moving] = contents.splice(bodyIndex - first, 1); contents.splice(destination - first, 0, moving!);
	let previousParagraph = first > 0 && paragraphs.get(`${bodyCells[first - 1]!.from}:${bodyCells[first - 1]!.to}`)?.end;
	const rendered = contents.map((content) => {
		// The original first paragraph has no \\par marker. When moved after text,
		// supply that fence so two cells do not silently become one paragraph.
		const marker = /^% ModuTeX cell begin(?:\r\n|\r|\n)/.exec(content.text)?.[0] ?? '';
		const fence = content.start && previousParagraph && !/^\s*\\par\b/.test(content.text.slice(marker.length)) ? `\\par${source.profile.preferredLineEnding}` : '';
		previousParagraph = content.end;
		return marker + fence + content.text.slice(marker.length);
	});
	const insert = rendered.map((text, i) => {
		const gap = i < spans.length - 1 ? source.read(spans[i]!.to, spans[i + 1]!.from) : '';
		const following = gap || rendered[i + 1] || source.read(spans.at(-1)!.to, Math.min(source.length, spans.at(-1)!.to + 1));
		// A moved comment must end before any newly supplied paragraph fence.
		const lineEnd = text.endsWith(CELL_END) && !/^[\r\n]/.test(following) ? source.profile.preferredLineEnding : '';
		return text + lineEnd + gap;
	}).join('');
	return sourcePatchTransaction(state, source, [{ from: spans[0]!.from, to: spans.at(-1)!.to, insert, expected: source.read(spans[0]!.from, spans.at(-1)!.to) }], true);
}
