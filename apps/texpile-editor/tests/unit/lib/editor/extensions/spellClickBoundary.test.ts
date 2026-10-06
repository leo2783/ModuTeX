// @vitest-environment jsdom
//
// The rule this guards: clicking past the last letter of a flagged word places the caret and must
// NOT open the suggestion box. The first attempt keyed off event.target, which never fired - that
// click lands outside the flagged span's own box, so the target is the block around it - and the
// bug survived a release. These assertions are the reason to trust the second attempt.
import { describe, expect, it } from 'vitest';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { spellClickBoundaryPlugin } from '$lib/editor/extensions/spellcheck/spellcheckplugin';

// "Hello World" in one paragraph: content starts at 1, so Hello is 1-6, the space 6, World 7-12.
const FLAG_FROM = 7;
const FLAG_TO = 12;

function mountEditor() {
	const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('Hello World')])]);
	// stands in for the proofread plugin's own decoration; only the class name matters here
	const flagWorld = new Plugin({
		props: {
			decorations: (state) => DecorationSet.create(state.doc, [Decoration.inline(FLAG_FROM, FLAG_TO, { class: 'proofread-spell' })])
		}
	});
	const place = document.createElement('div');
	document.body.appendChild(place);
	const view = new EditorView(place, { state: EditorState.create({ doc, plugins: [flagWorld] }) });
	return { view, place };
}

const clickAt = (view: EditorView, pos: number) =>
	spellClickBoundaryPlugin.props.handleClick!.call(spellClickBoundaryPlugin, view, pos, new MouseEvent('click'));

describe('spellClickBoundaryPlugin', () => {
	it('swallows the click at the end of a flagged word, so the caret can go there', () => {
		const { view, place } = mountEditor();
		expect(clickAt(view, FLAG_TO)).toBe(true);
		view.destroy();
		place.remove();
	});

	it('lets a click inside the word through, which is a real request for suggestions', () => {
		const { view, place } = mountEditor();
		expect(clickAt(view, FLAG_FROM + 2)).toBe(false);
		view.destroy();
		place.remove();
	});

	// the leading edge stays clickable, matching how source mode behaves
	it('lets a click at the start of the word through', () => {
		const { view, place } = mountEditor();
		expect(clickAt(view, FLAG_FROM)).toBe(false);
		view.destroy();
		place.remove();
	});

	// returning true here would eat the click for every other handleClick handler in the editor
	it('ignores the end of a word that is not flagged', () => {
		const { view, place } = mountEditor();
		expect(clickAt(view, 6)).toBe(false); // end of "Hello", no decoration
		view.destroy();
		place.remove();
	});

	it('ignores a position with no character behind it', () => {
		const { view, place } = mountEditor();
		expect(clickAt(view, 1)).toBe(false);
		view.destroy();
		place.remove();
	});
});
