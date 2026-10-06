import { describe, it, expect } from 'vitest';
import { schema } from '$lib/schema/schema';
import { flattenDoc, resolvePmComments, pmComments, setPmComments, revealPmComment } from '$lib/editor/extensions/pmComments';
import { EditorState, TextSelection } from 'prosemirror-state';
import { buildAnchor } from '$lib/comments/anchor';
import type { CommentThread } from '$lib/comments/log';

const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const doc = (...children: Parameters<typeof schema.nodes.doc.create>[1][]) => schema.nodes.doc.create(null, children as never);

/** a thread whose anchor was written against `source`, the way the source editor writes them */
function threadOn(source: string, quote: string): CommentThread {
	const at = source.indexOf(quote);
	return {
		id: 't1',
		file: 'main.tex',
		anchor: buildAnchor(source, at, at + quote.length),
		resolved: false,
		messages: [{ id: 'm1', by: 'test', body: 'note', at: '2026-01-01T00:00:00Z' }]
	};
}

describe('flattenDoc', () => {
	it('collects text with one ProseMirror position per character', () => {
		const d = doc(p('alpha'), p('beta'));
		const { text, index } = flattenDoc(d);
		expect(text).toBe('alpha\nbeta');
		expect(index).toHaveLength(text.length);
		// every indexed position resolves to the character it claims to be
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n') continue; // block separator: maps to the block node, not a character
			expect(d.textBetween(index[i], index[i] + 1)).toBe(text[i]);
		}
	});

	it('separates blocks with a single newline', () => {
		const d = doc(p('one'), p('two'), p('three'));
		expect(flattenDoc(d).text).toBe('one\ntwo\nthree');
	});

	it('keeps atoms one character wide instead of splicing their neighbours together', () => {
		const math = schema.nodes.inline_math.create({ latex: 'x^2' });
		const d = doc(schema.nodes.paragraph.create(null, [schema.text('see '), math, schema.text(' here')]));
		const { text, index } = flattenDoc(d);
		expect(text).toBe('see \uFFFC here');
		expect(index).toHaveLength(text.length);
		// a quote spanning the atom cannot match, and neighbours stay at their own positions
		expect(d.textBetween(index[0], index[0] + 1)).toBe('s');
		expect(d.textBetween(index[6], index[6] + 1)).toBe('h');
	});

	it('walks a figure caption: an atom for selection, still prose on the page', () => {
		const fig = schema.nodes.image.create({ src: 'p.png' }, schema.text('The measured response'));
		const d = schema.nodes.doc.create(null, [p('before'), fig, p('after')]);
		const { text, index } = flattenDoc(d);
		expect(text).toBe('before\nThe measured response\nafter');
		expect(index).toHaveLength(text.length);
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n') continue;
			expect(d.textBetween(index[i], index[i] + 1)).toBe(text[i]);
		}
	});

	it('keeps the placeholder for an uncaptioned figure, so its neighbours stay apart', () => {
		const fig = schema.nodes.image.create({ src: 'p.png' });
		const d = schema.nodes.doc.create(null, [p('before'), fig, p('after')]);
		expect(flattenDoc(d).text).toBe('before\n￼\nafter');
	});
});

describe('resolvePmComments', () => {
	it('places a source-authored thread on the rendered text', () => {
		// the source has markup and a blank line the rendered doc does not
		const source = '\\section{Intro}\n\nThe first paragraph mentions gravity.\n\nThe second one does not.\n';
		const d = doc(p('The first paragraph mentions gravity.'), p('The second one does not.'));
		const t = threadOn(source, 'paragraph mentions gravity');
		const { ranges, lost } = resolvePmComments(d, [t]);
		expect(lost).toEqual([]);
		expect(ranges).toHaveLength(1);
		expect(d.textBetween(ranges[0].from, ranges[0].to)).toBe('paragraph mentions gravity');
	});

	it('uses context to pick between repeated quotes across paragraphs', () => {
		const source = 'One sees gravity at work.\n\nTwo sees gravity at rest.\n';
		const d = doc(p('One sees gravity at work.'), p('Two sees gravity at rest.'));
		const t = threadOn(source, 'sees gravity at re');
		const { ranges } = resolvePmComments(d, [t]);
		expect(ranges).toHaveLength(1);
		// resolved into the SECOND paragraph
		expect(d.textBetween(ranges[0].from, ranges[0].to)).toBe('sees gravity at re');
		expect(ranges[0].from).toBeGreaterThan(d.child(0).nodeSize);
	});

	it('reports a markup quote as not visible rather than guessing', () => {
		const source = 'Before.\n\n\\begin{figure}[h]\n\\centering\n\\end{figure}\n\nAfter.\n';
		const d = doc(p('Before.'), p('After.'));
		const t = threadOn(source, '\\begin{figure}[h]');
		const { ranges, lost } = resolvePmComments(d, [t]);
		expect(ranges).toEqual([]);
		expect(lost).toEqual(['t1']);
	});

	it('resolves a quote across a source line wrap through normalization', () => {
		const source = 'The theorem holds\nfor every bounded case.\n';
		const d = doc(p('The theorem holds for every bounded case.'));
		const t = threadOn(source, 'holds\nfor every');
		const { ranges, lost } = resolvePmComments(d, [t]);
		expect(lost).toEqual([]);
		expect(d.textBetween(ranges[0].from, ranges[0].to)).toBe('holds for every');
	});

	it('finds a raw-island quote as ordinary text', () => {
		// raw_latex blocks are NOT atoms: their source text is their rendered text, so a markup
		// quote inside one resolves at tier 1 and highlights inside the island itself
		const source = 'Before.\n\n\\begin{figure}[h]\n\\centering\n\\end{figure}\n\nAfter.\n';
		const island = schema.nodes.raw_latex.create(null, schema.text('\\begin{figure}[h]\n\\centering\n\\end{figure}'));
		const d = schema.nodes.doc.create(null, [p('Before.'), island, p('After.')]);
		const t = threadOn(source, '\\begin{figure}[h]');
		const { ranges, lost } = resolvePmComments(d, [t]);
		expect(lost).toEqual([]);
		expect(d.textBetween(ranges[0].from, ranges[0].to)).toBe('\\begin{figure}[h]');
	});

	it('reports a quote hidden inside an atom as not visible, never a guess', () => {
		// block_math IS an atom - its LaTeX is rendered, not text - so a quote on the environment
		// markup has no rendered text anywhere. The honest answer is "not in this view"; the
		// source editor still places it. (An earlier block-demotion tier washed the containing
		// block instead, and was dropped: same behaviour in every dialect beats a highlight over
		// a whole table claiming to be a comment on it.)
		const source = 'Before.\n\n\\begin{align}\nE=mc^2\n\\end{align}\n\nAfter.\n';
		const math = schema.nodes.block_math.create(null, schema.text('E=mc^2'));
		const d = schema.nodes.doc.create(null, [p('Before.'), math, p('After.')]);
		const t = threadOn(source, '\\begin{align}');
		const { ranges, lost } = resolvePmComments(d, [t]);
		expect(ranges).toEqual([]);
		expect(lost).toEqual(['t1']);
	});

	it('places a source-authored comment on a figure caption', () => {
		// the caption is the one part of a figure that is real prose in both dialects, so a thread
		// written against \caption{...} in the source has somewhere to land here
		const source =
			'Before.\n\n\\begin{figure}\n\\includegraphics{p.png}\n\\caption{The measured response curve}\n\\end{figure}\n\nAfter.\n';
		const fig = schema.nodes.image.create({ src: 'p.png' }, schema.text('The measured response curve'));
		const d = schema.nodes.doc.create(null, [p('Before.'), fig, p('After.')]);
		const t = threadOn(source, 'measured response curve');
		const { ranges, lost } = resolvePmComments(d, [t]);
		expect(lost).toEqual([]);
		expect(d.textBetween(ranges[0].from, ranges[0].to)).toBe('measured response curve');
	});

	it('carries the resolved flag through so resolved threads can stay undecorated', () => {
		const source = 'Plain text here.\n';
		const d = doc(p('Plain text here.'));
		const t = { ...threadOn(source, 'text here'), resolved: true };
		const { ranges } = resolvePmComments(d, [t]);
		expect(ranges[0].resolved).toBe(true);
	});
});

/**
 * A stand-in for EditorView: revealPmComment only reads `state` and calls `dispatch`, and a real
 * view needs a DOM this suite does not have.
 */
function stubView(initial: EditorState) {
	let current = initial;
	return {
		get state() {
			return current;
		},
		dispatch(tr: ReturnType<EditorState['tr']['setMeta']>) {
			current = current.apply(tr);
		}
	};
}

describe('revealPmComment', () => {
	const build = () => {
		const d = doc(p('First paragraph.'), p('Second paragraph mentions gravity.'));
		const view = stubView(EditorState.create({ doc: d, plugins: pmComments() }));
		const v = view as never;
		const { ranges } = resolvePmComments(d, [threadOn('Second paragraph mentions gravity.', 'mentions gravity')]);
		setPmComments(v, ranges);
		return { view, v, d, ranges };
	};

	it('parks the caret on a placed thread', () => {
		const { view, v, ranges } = build();
		expect(revealPmComment(v, 't1')).toBe(true);
		expect(view.state.selection.from).toBe(ranges[0].from);
	});

	it('leaves the caret collapsed, so the add-comment pill does not offer to comment on a comment', () => {
		const { view, v } = build();
		revealPmComment(v, 't1');
		expect(view.state.selection.empty).toBe(true);
		expect(view.state.selection instanceof TextSelection).toBe(true);
	});

	it('reports false for a thread this view has not placed, so the caller can fall back', () => {
		const { view, v } = build();
		const before = view.state.selection.from;
		expect(revealPmComment(v, 'somewhere-else')).toBe(false);
		expect(view.state.selection.from).toBe(before);
	});
});
