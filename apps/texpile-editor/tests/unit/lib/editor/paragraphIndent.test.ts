import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '$lib/schema/schema';
import { setParagraphIndent } from '$lib/editor/helperCommands';
import { serializeToLatex } from '$lib/serializer/latexSerializer';

function stateForParagraphIndent() {
	const doc = schema.nodes.doc.create(null, [
		schema.nodes.paragraph.create(null, schema.text('First paragraph')),
		schema.nodes.raw_latex.create(null, schema.text('\\customblock{keep this untouched}')),
		schema.nodes.paragraph.create(null, schema.text('Second paragraph'))
	]);
	return EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) });
}

describe('paragraph indent commands', () => {
	it('directly selects Auto, Indent, and No indent without changing paragraph text or raw LaTeX', () => {
		let state = stateForParagraphIndent();
		const originalText = state.doc.textContent;
		const originalRaw = state.doc.child(1).textContent;

		for (const [indent, marker] of [
			['indent', '\\indent First paragraph \\par'],
			['noindent', '\\noindent First paragraph \\par'],
			['auto', 'First paragraph \\par']
		] as const) {
			const handled = setParagraphIndent(indent)(state, (transaction) => (state = state.apply(transaction)));
			expect(handled).toBe(true);
			expect(state.doc.firstChild?.attrs.indent).toBe(indent);
			expect(state.doc.textContent).toBe(originalText);
			expect(state.doc.child(1).textContent).toBe(originalRaw);
			expect(serializeToLatex(state.doc)).toContain(marker);
		}
	});

	it('does not claim success when the current selection has no paragraph parent', () => {
		const heading = schema.nodes.heading.create({ level: 1, numbered: true }, schema.text('Heading'));
		const doc = schema.nodes.doc.create(null, [heading]);
		const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) });
		expect(setParagraphIndent('indent')(state)).toBe(false);
	});
});
