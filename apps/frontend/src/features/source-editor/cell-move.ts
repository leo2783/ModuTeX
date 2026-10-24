import type { EditorState } from '@codemirror/state';
import { parseSource, type SourceSpan } from '../document-core/core.ts';
import { projectVisual } from '../visual-editor/schema.ts';
import { sourceState, sourcePatchTransaction } from './state.ts';

/** Rotate cell contents, retaining the exact separators and one shared undo entry. */
export function cellMoveTransaction(state: EditorState, cells: readonly SourceSpan[], index: number, boundary: number) {
	const source = state.field(sourceState).projection.document;
	if (!Number.isInteger(index) || !Number.isInteger(boundary) || index < 0 || index >= cells.length || boundary < 0 || boundary > cells.length) throw new Error('CELL_MOVE_RANGE');
	for (let i = 0; i < cells.length; i++) {
		const span = cells[i]!;
		if (span.documentId !== source.documentId || span.version !== source.version || span.from < 0 || span.to < span.from || span.to > source.length || i > 0 && cells[i - 1]!.to > span.from) throw new Error('STALE_CELL_MOVE');
	}
	if (boundary === index || boundary === index + 1) return null;
	const destination = boundary > index ? boundary - 1 : boundary;
	const first = Math.min(index, destination), last = Math.max(index, destination);
	const projected = projectVisual(source, parseSource(source)).document;
	const paragraphs = new Set<string>(); projected.forEach(node => { if (node.type.name === 'source_block') paragraphs.add(`${node.attrs.from}:${node.attrs.to}`); });
	const spans = cells.slice(first, last + 1), contents = spans.map(span => ({ text: source.read(span.from, span.to), paragraph: paragraphs.has(`${span.from}:${span.to}`) }));
	const [moving] = contents.splice(index - first, 1); contents.splice(destination - first, 0, moving!);
	let previousParagraph = first > 0 && paragraphs.has(`${cells[first - 1]!.from}:${cells[first - 1]!.to}`);
	const insert = contents.map((content, i) => {
		// The original first paragraph has no \\par marker. When moved after text,
		// supply that fence so two cells do not silently become one paragraph.
		const fence = content.paragraph && previousParagraph && !/^\\par\b/.test(content.text) ? `\\par${source.profile.preferredLineEnding}` : '';
		previousParagraph = content.paragraph;
		return fence + content.text + (i < spans.length - 1 ? source.read(spans[i]!.to, spans[i + 1]!.from) : '');
	}).join('');
	return sourcePatchTransaction(state, source, [{ from: spans[0]!.from, to: spans.at(-1)!.to, insert, expected: source.read(spans[0]!.from, spans.at(-1)!.to) }], true);
}
