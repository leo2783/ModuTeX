// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { FoldedSectionState } from 'modutex-contracts';
import { schema } from '$lib/schema/schema';
import { createSectionFoldingPlugin, sectionDescriptors, sectionFoldingPluginKey } from '$lib/editor/extensions/section-folding';

const heading = (level: number, text: string) => schema.nodes.heading.create({ level, numbered: true }, schema.text(text));
const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const documentWithRepeatedSections = schema.nodes.doc.create(null, [
	heading(1, 'Overview'),
	paragraph('Lead'),
	heading(2, 'Details'),
	paragraph('First details'),
	heading(2, 'Details'),
	paragraph('Second details'),
	heading(1, 'Overview'),
	paragraph('Second overview')
]);

let hosts: HTMLDivElement[] = [];

function createView(doc = documentWithRepeatedSections, initial: FoldedSectionState[] = []) {
	const changes: FoldedSectionState[][] = [];
	const plugin = createSectionFoldingPlugin({
		relativeFile: 'chapters/main.tex',
		initial,
		onChange: (states) => changes.push(states),
		labels: { fold: 'Fold section', unfold: 'Unfold section' }
	});
	const host = document.body.appendChild(document.createElement('div'));
	hosts.push(host);
	const view = new EditorView(host, { state: EditorState.create({ schema, doc, plugins: [plugin] }) });
	return { view, changes };
}

afterEach(() => {
	for (const host of hosts) host.remove();
	hosts = [];
});

describe('section folding', () => {
	it('uses stable, distinct keys for nested and repeated headings', () => {
		const firstPass = sectionDescriptors(documentWithRepeatedSections, 'chapters/main.tex');
		const secondPass = sectionDescriptors(documentWithRepeatedSections, 'chapters/main.tex');

		expect(firstPass.map((section) => section.key)).toEqual(secondPass.map((section) => section.key));
		expect(new Set(firstPass.map((section) => section.key)).size).toBe(firstPass.length);
		expect(firstPass.filter((section) => section.title === 'Details').map((section) => section.occurrence)).toEqual([0, 1]);
		expect(firstPass[1].ancestorHeadingChain).toEqual(['Overview', 'Details']);
		expect(firstPass[1].contentTo).toBe(firstPass[2].headingPos);
	});

	it('moves an overlapping selection to the heading, persists the fold, and restores it on reopen', () => {
		const { view, changes } = createView();
		const section = sectionDescriptors(view.state.doc, 'chapters/main.tex')[0];
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, section.headingPos + 1, section.contentFrom + 2)));
		view.focus();

		const collapse = new KeyboardEvent('keydown', { code: 'BracketLeft', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
		view.dom.dispatchEvent(collapse);

		expect(collapse.defaultPrevented).toBe(true);
		expect(sectionFoldingPluginKey.getState(view.state)?.folded.has(section.key)).toBe(true);
		expect(view.state.selection.head).toBeLessThan(section.contentFrom);
		expect(view.dom.querySelector('.modutex-folded-section')).not.toBeNull();
		expect(view.dom.querySelector<HTMLButtonElement>('.modutex-fold-toggle')?.getAttribute('aria-label')).toBe('Unfold section');
		expect(changes.at(-1)).toEqual([
			{
				relativeFile: 'chapters/main.tex',
				ancestorHeadingChain: ['Overview'],
				level: 1,
				occurrence: 0,
				folded: true
			}
		]);

		const persisted = changes.at(-1)!;
		view.destroy();
		const reopened = createView(documentWithRepeatedSections, persisted);
		const reopenedSection = sectionDescriptors(reopened.view.state.doc, 'chapters/main.tex')[0];
		expect(sectionFoldingPluginKey.getState(reopened.view.state)?.folded.has(reopenedSection.key)).toBe(true);
		expect(reopened.view.dom.querySelector<HTMLButtonElement>('.modutex-fold-toggle')?.getAttribute('aria-expanded')).toBe('false');

		reopened.view.dispatch(
			reopened.view.state.tr.setSelection(TextSelection.create(reopened.view.state.doc, reopenedSection.headingPos + 1))
		);
		reopened.view.focus();
		const expand = new KeyboardEvent('keydown', { code: 'BracketRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
		reopened.view.dom.dispatchEvent(expand);
		expect(expand.defaultPrevented).toBe(true);
		expect(sectionFoldingPluginKey.getState(reopened.view.state)?.folded.has(reopenedSection.key)).toBe(false);

		reopened.view.destroy();
	});
});
