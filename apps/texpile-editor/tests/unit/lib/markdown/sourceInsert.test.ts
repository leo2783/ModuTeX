import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import {
	computeToggleDelim,
	computeHeadingLine,
	computeQuoteLines,
	computeFence,
	computeLink,
	computeMathBlock,
	computeTableSkeleton,
	computeHr
} from '$lib/markdown/sourceInsert';

function state(doc: string, anchor: number, head = anchor) {
	return EditorState.create({ doc, selection: EditorSelection.range(anchor, head) });
}
function apply(s: EditorState, spec: Parameters<EditorState['update']>[0]) {
	return s.update(spec).state.doc.toString();
}

describe('computeToggleDelim', () => {
	it('wraps a selection', () => {
		const s = state('hello world', 0, 5);
		expect(apply(s, computeToggleDelim(s, '**'))).toBe('**hello** world');
	});
	it('unwraps a selection that includes the delimiters', () => {
		const s = state('**hello** world', 0, 9);
		expect(apply(s, computeToggleDelim(s, '**'))).toBe('hello world');
	});
	it('unwraps when delimiters sit just outside the selection', () => {
		const s = state('**hello** world', 2, 7);
		expect(apply(s, computeToggleDelim(s, '**'))).toBe('hello world');
	});
	it('empty cursor inserts a pair, second invoke removes it', () => {
		const s = state('ab', 1);
		const once = s.update(computeToggleDelim(s, '*')).state;
		expect(once.doc.toString()).toBe('a**b');
		expect(once.selection.main.head).toBe(2); // between the pair
		expect(apply(once, computeToggleDelim(once, '*'))).toBe('ab');
	});
	it('handles multiple cursors right-to-left', () => {
		const s = EditorState.create({
			doc: 'one two',
			selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
			extensions: EditorState.allowMultipleSelections.of(true)
		});
		expect(apply(s, computeToggleDelim(s, '**'))).toBe('**one** **two**');
	});
});

describe('computeHeadingLine', () => {
	it('sets, changes and toggles off a heading', () => {
		let s = state('title', 2);
		s = s.update(computeHeadingLine(s, 2)).state;
		expect(s.doc.toString()).toBe('## title');
		s = s.update(computeHeadingLine(s, 3)).state;
		expect(s.doc.toString()).toBe('### title');
		s = s.update(computeHeadingLine(s, 3)).state;
		expect(s.doc.toString()).toBe('title');
	});
	it('level 0 strips any heading', () => {
		const s = state('#### deep', 3);
		expect(apply(s, computeHeadingLine(s, 0))).toBe('deep');
	});
});

describe('computeQuoteLines', () => {
	it('quotes all selected lines, then unquotes', () => {
		let s = state('a\nb', 0, 3);
		s = s.update(computeQuoteLines(s)).state;
		expect(s.doc.toString()).toBe('> a\n> b');
		s = s.update({ selection: EditorSelection.range(0, s.doc.length) }).state;
		expect(apply(s, computeQuoteLines(s))).toBe('a\nb');
	});
});

describe('block inserts', () => {
	it('fence wraps the selection and grows past inner backticks', () => {
		const s = state('code with ``` inside', 0, 20);
		const out = apply(s, computeFence(s));
		expect(out.startsWith('````\n')).toBe(true);
		expect(out).toContain('code with ``` inside\n````');
	});
	it('link selects the url placeholder', () => {
		const s = state('click me', 0, 5);
		const next = s.update(computeLink(s)).state;
		expect(next.doc.toString()).toBe('[click](url) me');
		expect(next.doc.sliceString(next.selection.main.from, next.selection.main.to)).toBe('url');
	});
	it('math block wraps', () => {
		const s = state('x^2', 0, 3);
		expect(apply(s, computeMathBlock(s))).toBe('$$\nx^2\n$$\n');
	});
	it('table skeleton lands after the current line', () => {
		const s = state('para', 2);
		const out = apply(s, computeTableSkeleton(s));
		expect(out).toBe('para\n\n| Column | Column |\n| --- | --- |\n|  |  |\n');
	});
	it('hr lands after the current line', () => {
		const s = state('para', 2);
		expect(apply(s, computeHr(s))).toBe('para\n\n---\n');
	});
});
