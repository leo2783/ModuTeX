import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { minimalEdit } from '$lib/editor/minimalEdit';

const apply = (doc: string, cursor: number, next: string) => {
	const start = EditorState.create({ doc, selection: { anchor: cursor } });
	return start.update({ changes: minimalEdit(doc, next) }).state;
};

describe('minimalEdit', () => {
	it('finds the changed middle', () => {
		expect(minimalEdit('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
	});

	it('handles a pure deletion', () => {
		expect(minimalEdit('hello brave world', 'hello world')).toEqual({ from: 6, to: 12, insert: '' });
	});

	it('handles an append and a prepend', () => {
		expect(minimalEdit('abc', 'abcdef')).toEqual({ from: 3, to: 3, insert: 'def' });
		expect(minimalEdit('abc', 'xyzabc')).toEqual({ from: 0, to: 0, insert: 'xyz' });
	});

	it('never emits a backwards range when prefix and suffix would overlap', () => {
		// "aaa" -> "aa": the common prefix is 2 and the common suffix would also reach 2, and an
		// unclamped scan produces to < from, which CodeMirror rejects outright
		for (const [a, b] of [
			['aaa', 'aa'],
			['aa', 'aaa'],
			['', 'x'],
			['x', ''],
			['abab', 'ab']
		]) {
			const e = minimalEdit(a, b);
			expect(e.to).toBeGreaterThanOrEqual(e.from);
			expect(a.slice(0, e.from) + e.insert + a.slice(e.to)).toBe(b);
		}
	});

	it('reproduces the target for a spread of shapes', () => {
		const cases: [string, string][] = [
			['', ''],
			['same', 'same'],
			['line one\nline two\n', 'line one\nline TWO\n'],
			['\\section{A}\n\ntext', '\\section{A}\n\ntext more'],
			['abc', 'xyz']
		];
		for (const [a, b] of cases) {
			const e = minimalEdit(a, b);
			expect(a.slice(0, e.from) + e.insert + a.slice(e.to)).toBe(b);
		}
	});
});

describe('caret survival through an external push', () => {
	// the actual bug: an external value push landed while the user was typing, and the whole
	// document was replaced -- so the caret had nowhere to map and jumped away mid-edit
	const doc = '\\section{Intro}\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph.\n';
	const cursor = doc.indexOf('brown') + 3; // mid-word, in the middle paragraph

	it('keeps the caret when the change is elsewhere in the document', () => {
		const next = doc.replace('A second paragraph.', 'A second paragraph!!');
		expect(apply(doc, cursor, next).selection.main.head).toBe(cursor);
	});

	it('keeps the caret when the file is normalized on save', () => {
		const next = doc.replace(/\n$/, '\n\n'); // a trailing newline appended by the save pipeline
		expect(apply(doc, cursor, next).selection.main.head).toBe(cursor);
	});

	it('shifts the caret by exactly the edit when text is inserted before it', () => {
		const next = doc.replace('\\section{Intro}', '\\section{Introduction}');
		expect(apply(doc, cursor, next).selection.main.head).toBe(cursor + 'duction'.length);
	});

	it('a whole-buffer replacement loses it, which is what this replaced', () => {
		const next = doc.replace('A second paragraph.', 'A second paragraph!!');
		const state = EditorState.create({ doc, selection: { anchor: cursor } });
		const after = state.update({ changes: { from: 0, to: doc.length, insert: next } }).state;
		expect(after.selection.main.head).not.toBe(cursor);
	});
});
