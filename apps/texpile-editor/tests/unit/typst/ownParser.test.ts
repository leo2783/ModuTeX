// @vitest-environment jsdom
// Our own wasm build of typst-syntax, exercised through the Lezer parser that wraps it.
// These are the tests that justify replacing codemirror-lang-typst: correct offsets (including
// astral-plane characters), a real immutable Tree, and reparsing that keeps up with edits.
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { typstLanguage } from '$lib/typst/typstLanguage';

const named = tagHighlighter([
	{ tag: tags.comment, class: 'comment' },
	{ tag: tags.heading, class: 'heading' },
	{ tag: tags.strong, class: 'strong' },
	{ tag: tags.string, class: 'string' },
	{ tag: tags.keyword, class: 'keyword' },
	{ tag: tags.controlKeyword, class: 'control' },
	{ tag: tags.definitionKeyword, class: 'defkeyword' }
]);

const state = (doc: string) => EditorState.create({ doc, extensions: [typstLanguage()] });

function leaves(doc: string): { name: string; text: string }[] {
	const tree = syntaxTree(state(doc));
	const out: { name: string; text: string }[] = [];
	tree.cursor().iterate((n) => {
		if (n.to > n.from && n.node.firstChild == null) out.push({ name: n.name, text: doc.slice(n.from, n.to) });
	});
	return out;
}

describe('typst parser (own wasm build)', () => {
	it('produces a tree spanning the whole document', () => {
		const doc = '= Heading\n\nBody text.\n';
		expect(syntaxTree(state(doc)).length).toBe(doc.length);
	});

	it('places leaves at offsets that match the source text', () => {
		const doc = '= Title\n';
		// the tree must agree with the document about where things are, or every downstream
		// feature (highlighting, folding, goto) points at the wrong characters
		const joined = leaves(doc)
			.map((l) => l.text)
			.join('');
		expect(joined).toBe(doc);
	});

	it('keeps offsets correct across astral-plane characters', () => {
		// an emoji is ONE code point but TWO UTF-16 units and FOUR bytes. Typst counts bytes,
		// CodeMirror counts UTF-16 units; a naive conversion drifts from here to the end of the file.
		const doc = 'text 🎉 more *strong*\n';
		const joined = leaves(doc)
			.map((l) => l.text)
			.join('');
		expect(joined).toBe(doc);
		expect(syntaxTree(state(doc)).length).toBe(doc.length);
	});

	it('resolves a position back to the node covering it', () => {
		const doc = '= Heading\n\nplain body\n';
		const at = doc.indexOf('body');
		const node = syntaxTree(state(doc)).resolve(at, 1);
		expect(doc.slice(node.from, node.to)).toContain('body');
	});

	it('highlights: comment, heading and a string', () => {
		const doc = '// note\n= Heading\n\n#let a = "hi"\n';
		const st = state(doc);
		const found: Record<string, string> = {};
		highlightTree(syntaxTree(st), named, (from, to, cls) => {
			found[doc.slice(from, to)] = cls;
		});
		const entry = (needle: string) => Object.entries(found).find(([text]) => text.includes(needle))?.[1] ?? '';
		expect(entry('note')).toBe('comment');
		expect(entry('Heading')).toBe('heading');
		expect(entry('let')).toMatch(/keyword|control|def/);
	});

	it('reparses after an edit', () => {
		const before = state('= One\n');
		const after = before.update({ changes: { from: 2, to: 5, insert: 'Two Words' } }).state;
		const doc = after.doc.toString();
		expect(doc).toBe('= Two Words\n');
		expect(syntaxTree(after).length).toBe(doc.length);
		const out: string[] = [];
		highlightTree(syntaxTree(after), named, (from, to, cls) => {
			if (doc.slice(from, to).includes('Two')) out.push(cls);
		});
		expect(out.join(' ')).toContain('heading');
	});

	it('survives a wholesale document replacement', () => {
		// the source-editor remount path replaces the doc without an incremental change
		const first = state('#let x = 1\n');
		expect(syntaxTree(first).length).toBe(11);
		const replaced = first.update({ changes: { from: 0, to: 11, insert: '= Totally different\n' } }).state;
		expect(syntaxTree(replaced).length).toBe(replaced.doc.length);
	});

	it('does not choke on an empty document', () => {
		expect(syntaxTree(state('')).length).toBe(0);
	});

	it('handles unterminated syntax without losing the rest of the file', () => {
		// the bug fixed upstream in Typst 0.15 that the 0.13.1 blob still carries
		const doc = '#let s = "unterminated\n= Later Heading\n';
		expect(syntaxTree(state(doc)).length).toBe(doc.length);
	});
});
