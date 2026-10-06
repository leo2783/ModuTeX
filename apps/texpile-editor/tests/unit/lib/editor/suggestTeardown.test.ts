// @vitest-environment jsdom
// The @ dropdown is a module-level element on document.body, removed only through the suggester's
// onExit. An editor being torn down mid-suggestion (tab switch, file switch, mode switch) must
// count as an exit, or the menu outlives the editor that opened it and floats over whatever
// replaces it - which is exactly the bug this pins.
import { describe, it, expect, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { createTexpileSuggest, type TexpileSuggester } from '$lib/editor/extensions/suggest/texpile-suggest';
import { typSchema } from '$lib/typst/visual/schema';

function openSuggestion(suggester: TexpileSuggester): EditorView {
	const doc = typSchema.nodes.doc.create(null, [typSchema.nodes.paragraph.create(null, typSchema.text('see '))]);
	const state = EditorState.create({ doc, plugins: [createTexpileSuggest(suggester)] });
	const view = new EditorView(document.body.appendChild(document.createElement('div')), { state });
	// type "@eq" at the end of the paragraph, cursor after it
	const end = view.state.doc.content.size - 1;
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).insertText('@eq'));
	return view;
}

describe('suggest plugin teardown', () => {
	// supportedCharacters passed the way the real reference suggester passes it (no star; the
	// plugin adds its own quantifier)
	const chars = /[a-zA-Z0-9\s_]/;

	it('activates on @ (sanity for the assertion below)', () => {
		const onChange = vi.fn();
		const view = openSuggestion({ char: '@', name: 'test', supportedCharacters: chars, onChange });
		expect(onChange).toHaveBeenCalled();
		view.destroy();
	});

	it('destroying the editor while a suggestion is open fires onExit', () => {
		const onExit = vi.fn();
		const view = openSuggestion({ char: '@', name: 'test', supportedCharacters: chars, onChange: () => {}, onExit });
		expect(onExit).not.toHaveBeenCalled();
		view.destroy();
		expect(onExit).toHaveBeenCalledTimes(1);
	});
});
