import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { mdPathCompletionSource } from '$lib/markdown/pathCompletion';
import { filePathStore } from '$lib/stores/editorStore';

const FILES = ['main.tex', 'notes.md', 'figures/plot.png', 'figures/diagram.svg', 'data/results.csv', 'output/main.log', 'refs.bib'];

/** run the source with the caret at the end of `doc` (explicit: false, as typing would) */
function complete(doc: string) {
	const state = EditorState.create({ doc, selection: { anchor: doc.length } });
	return mdPathCompletionSource(new CompletionContext(state, doc.length, false));
}
const labels = (r: ReturnType<typeof complete>) => (r?.options ?? []).map((o) => o.displayLabel ?? o.label);
/** what would actually be typed into the document for an option */
const inserts = (r: ReturnType<typeof complete>) => (r?.options ?? []).map((o) => o.apply as string);

beforeEach(() => filePathStore.set(FILES));

describe('markdown link-target completion', () => {
	it('offers every project file inside a link target', () => {
		const r = complete('see [the notes](');
		expect(r).toBeTruthy();
		expect(labels(r)).toContain('notes.md');
		expect(labels(r)).toContain('figures/plot.png');
	});

	it('offers only figures inside an IMAGE target', () => {
		const r = complete('![a plot](');
		expect(labels(r)).toEqual(expect.arrayContaining(['figures/plot.png', 'figures/diagram.svg']));
		expect(labels(r)).not.toContain('notes.md');
		expect(labels(r)).not.toContain('main.tex');
	});

	// the file list is project-wide and a .md sits beside the LaTeX build output
	it('hides build artifacts from a plain link', () => {
		expect(labels(complete('[log]('))).not.toContain('output/main.log');
	});

	it('inserts the path verbatim, with no extension stripping', () => {
		// \include{intro} appends its own .tex; a markdown target is the literal path
		expect(inserts(complete('![](')).find((p) => p.endsWith('plot.png'))).toBe('figures/plot.png');
	});

	it('replaces only what has been typed so far', () => {
		const doc = 'see [x](fig';
		const r = complete(doc);
		expect(r!.from).toBe(doc.length - 'fig'.length);
	});

	// a path containing '(' would break a naive lastIndexOf('(') boundary
	it('gets the boundary right when the filename itself contains a bracket', () => {
		filePathStore.set(['figures/fig(1).png']);
		const doc = '![alt](figures/fig(1';
		const r = complete(doc);
		expect(r!.from).toBe(doc.indexOf('figures/fig(1'));
	});

	// alt text with brackets must not confuse the trigger either
	it('handles parentheses in the alt text', () => {
		const doc = '![a (big) plot](fig';
		const r = complete(doc);
		expect(r!.from).toBe(doc.length - 'fig'.length);
	});

	describe('does not fire', () => {
		it('outside a link', () => {
			expect(complete('just a sentence')).toBeNull();
			expect(complete('# a heading')).toBeNull();
		});

		it('in the link TEXT rather than the target', () => {
			expect(complete('[some text')).toBeNull();
		});

		it('once the target is closed', () => {
			expect(complete('[x](figures/plot.png)')).toBeNull();
			expect(complete('[x](figures/plot.png) and more')).toBeNull();
		});

		// a space starts markdown's optional title, which is prose, not a path
		it('inside a link title', () => {
			expect(complete('[x](figures/plot.png "a cap')).toBeNull();
		});

		it('when the project has no files scanned yet', () => {
			filePathStore.set([]);
			expect(complete('![](')).toBeNull();
		});

		it('when an image target has no figures to offer', () => {
			filePathStore.set(['main.tex', 'notes.md']);
			expect(complete('![](')).toBeNull();
		});
	});
});
