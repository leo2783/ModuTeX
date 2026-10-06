// @vitest-environment jsdom
// Proves the Typst language actually HIGHLIGHTS, not just parses: the wasm parser must produce a
// tree whose nodes carry standard @lezer/highlight tags, because that is what lets our own
// theme-aware style (cmHighlight) colour Typst the same way it colours .tex and .md.
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toggleComment } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { typstLanguage } from '$lib/typst/typstLanguage';

const DOC = `// a comment
= Heading

Some *strong* and _emph_ text.

#let greet(name) = [Hello #name]
#greet("world")
`;

// A real HighlightStyle generates opaque class names (ͼ7), which say nothing about whether the
// right TAG was applied. This maps the standard tags to readable names so the assertions below are
// about semantics rather than about CodeMirror's class-name generator.
const named = tagHighlighter([
	{ tag: tags.comment, class: 'comment' },
	{ tag: tags.heading, class: 'heading' },
	{ tag: tags.strong, class: 'strong' },
	{ tag: tags.emphasis, class: 'emphasis' },
	{ tag: tags.string, class: 'string' },
	{ tag: tags.keyword, class: 'keyword' },
	{ tag: tags.controlKeyword, class: 'control' },
	{ tag: tags.definitionKeyword, class: 'defkeyword' },
	{ tag: tags.variableName, class: 'variable' },
	{ tag: tags.name, class: 'name' }
]);

/** every tagged span in `doc`, as {text, cls} */
function tokens(doc: string): { text: string; cls: string }[] {
	const state = EditorState.create({ doc, extensions: [typstLanguage()] });
	const out: { text: string; cls: string }[] = [];
	highlightTree(syntaxTree(state), named, (from, to, cls) => out.push({ text: doc.slice(from, to), cls }));
	return out;
}

const clsOf = (toks: { text: string; cls: string }[], needle: string) => toks.find((t) => t.text.includes(needle))?.cls ?? '';

describe('typstLanguage', () => {
	it('parses into a non-empty tree', () => {
		const state = EditorState.create({ doc: DOC, extensions: [typstLanguage()] });
		expect(syntaxTree(state).length).toBeGreaterThan(0);
	});

	it('emits highlight tags, so the document is not painted flat', () => {
		expect(tokens(DOC).length).toBeGreaterThan(0);
	});

	it('tags the comment', () => {
		expect(clsOf(tokens(DOC), 'a comment')).toBe('comment');
	});

	it('tags the heading', () => {
		expect(clsOf(tokens(DOC), 'Heading')).toBe('heading');
	});

	it('tags #let as a keyword', () => {
		// tags.definitionKeyword or controlKeyword depending on the mapping; either is a keyword
		expect(clsOf(tokens(DOC), 'let')).toMatch(/keyword|control|def/);
	});

	it('injects no colours of its own', () => {
		// The package's typst() bundles syntaxHighlighting(TypstHighlightSytle), a hardcoded
		// light-mode palette (black headings, deeppink keywords, hotpink braces). Mounting it would
		// write those literals into the document's style sheets, giving near-invisible headings in
		// dark mode and a Typst tab matching no other tab. Regression guard: if anyone swaps
		// typstLanguage() back for the package's typst(), this fails.
		const view = new EditorView({ state: EditorState.create({ doc: DOC, extensions: [typstLanguage()] }), parent: document.body });
		try {
			const css = Array.from(document.querySelectorAll('style'))
				.map((s) => s.textContent ?? '')
				.join('\n');
			expect(css).not.toMatch(/deeppink|hotpink|slateblue/i);
		} finally {
			view.destroy();
		}
	});

	it('Mod-/ toggles a // line comment, not a /* */ wrap', () => {
		// toggleComment is driven entirely by the language's commentTokens: without `line` it fell
		// back to wrapping lines in /* */, which is what "Ctrl+/ doesn't work in .typ" looked like
		const state = EditorState.create({ doc: 'Some text\n', extensions: [typstLanguage()] });
		let next = state;
		toggleComment({ state, dispatch: (tr) => (next = tr.state) });
		expect(next.doc.toString()).toBe('// Some text\n');
		let back = next;
		toggleComment({ state: next, dispatch: (tr) => (back = tr.state) });
		expect(back.doc.toString()).toBe('Some text\n');
	});

	it('keeps highlighting after an edit (the parser tracks changes incrementally)', () => {
		const state = EditorState.create({ doc: '= One\n', extensions: [typstLanguage()] });
		const next = state.update({ changes: { from: 6, insert: '= Two\n' } }).state;
		const text = next.doc.toString();
		const out: string[] = [];
		highlightTree(syntaxTree(next), named, (from, to, cls) => {
			if (text.slice(from, to).includes('Two')) out.push(cls);
		});
		expect(out.join(' ')).toContain('heading');
	});
});
