import type { EditorState } from '@codemirror/state';
import { parseSource, type SourceSpan, type SourcePatch } from '../document-core/core.ts';
import { sourceState, sourcePatchTransaction } from './state.ts';

export type TextStructure = 'paragraph' | 'title' | 'abstract' | 'section' | 'subsection' | 'subsubsection';
export interface StructureSelection {
	readonly span: SourceSpan;
	readonly contentSpan: SourceSpan;
	readonly name: string;
}

/** One source transaction owns wrappers, paragraph fences, EOLs and shared history. */
export function structureTransaction(state: EditorState, selected: StructureSelection, kind: TextStructure) {
	const source = state.field(sourceState).projection.document;
	const { span, contentSpan } = selected;
	if (span.documentId !== source.documentId || span.version !== source.version ||
		contentSpan.documentId !== span.documentId || contentSpan.version !== span.version) throw new Error('STALE_STRUCTURE');
	if (contentSpan.from < span.from || contentSpan.to > span.to || contentSpan.from > contentSpan.to) throw new Error('STRUCTURE_RANGE');
	if (!['paragraph', 'title', 'abstract', 'section', 'subsection', 'subsubsection'].includes(kind)) throw new Error('STRUCTURE_KIND');
	const eol = source.profile.preferredLineEnding;
	// Plain cells may include source separator newlines. Do not trim Unicode spaces.
	const content = source.read(contentSpan.from, contentSpan.to).replace(/^[\r\n]+|[\r\n]+$/g, '');
	const value = kind === 'abstract' ? `\\begin{abstract}${eol}${content}${eol}\\end{abstract}`
		: kind === 'title' ? `\\title{${content}}${eol}\\maketitle`
		: kind === 'paragraph' ? `\\par${eol}${content}` : `\\${kind}{${content}}`;
	const patches: SourcePatch[] = [];
	let from = span.from;
	const body = selected.name === 'title' ? parseSource(source).nodes.find(node => node.kind === 'environment' && node.name === 'document') : null;
	// A displayed preamble title is projected at \maketitle. Move its content to
	// that body position when it becomes a paragraph, abstract or section.
	if (selected.name === 'title' && body?.content && span.to <= body.content.from) {
		const marker = body.children.find(node => node.kind === 'raw' && node.name === 'maketitle' && node.content === null);
		if (!marker) throw new Error('STRUCTURE_RANGE');
		if (kind === 'title') return { transaction: state.update({}), cell: span };
		patches.push({ from: span.from, to: span.to, insert: '', expected: source.read(span.from, span.to) });
		from = marker.span.from - (span.to - span.from) + eol.length;
		patches.push({ from: marker.span.from, to: marker.span.to, insert: eol + value + eol, expected: source.read(marker.span.from, marker.span.to) });
	} else {
		const prefix = span.from > 0 && !/[\r\n]/.test(source.read(span.from - 1, span.from)) ? eol : '';
		const suffix = span.to < source.length && /[\r\n]/.test(source.read(span.to, span.to + 1)) ? '' : eol;
		patches.push({ from: span.from, to: span.to, insert: prefix + value + suffix, expected: source.read(span.from, span.to) });
		from += prefix.length;
	}
	if (patches.every(patch => patch.insert === patch.expected)) return { transaction: state.update({}), cell: span };
	const transaction = sourcePatchTransaction(state, span, patches, true);
	if (!transaction.docChanged) throw new Error('STRUCTURE_REJECTED');
	const next = transaction.state.field(sourceState).projection.document;
	return { transaction, cell: { documentId: next.documentId, version: next.version, from, to: from + value.length } };
}
