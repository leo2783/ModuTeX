// The column-0 rescue behind Typst's visual-mode forward sync.
//
// tinymist's jump_from_cursor resolves the syntax leaf ENDING at the position, so a jump has to
// land just AFTER some text: column 0 never resolves, and neither does a position sitting in
// markup. The visual caret maps to column 0 whenever its block carries no parse stamp - i.e.
// anything typed since the last reparse, which resolves to its block start - so those jumps used
// to be dropped silently, which is most of "sync works sometimes and not others". These pin the
// rescue: same line, first word's end.
import { describe, it, expect } from 'vitest';
import { firstWordEndOnLine } from '$lib/editor/sourceMap';

describe('firstWordEndOnLine', () => {
	it('lands just after the first word of a plain line', () => {
		const src = 'Hello world\n';
		expect(firstWordEndOnLine(src, 0)).toBe(5); // after "Hello"
	});

	it('skips leading whitespace and indentation', () => {
		const src = '  indented text\n';
		expect(firstWordEndOnLine(src, 0)).toBe(10); // after "indented"
	});

	it('skips a leading markup marker, which never resolves on its own', () => {
		// the `=` of a typst heading, and the `-` of a list item
		expect(firstWordEndOnLine('= Introduction\n', 0)).toBe(14);
		expect(firstWordEndOnLine('- first item\n', 0)).toBe(7);
	});

	it('measures from the given line start, not the file start', () => {
		const src = 'first line\nsecond line\n';
		expect(firstWordEndOnLine(src, 11)).toBe(6); // after "second", relative to its own line
	});

	it('handles the last line when the file has no trailing newline', () => {
		expect(firstWordEndOnLine('tail', 0)).toBe(4);
	});

	it('keeps hyphens and apostrophes inside one word', () => {
		expect(firstWordEndOnLine("don't stop\n", 0)).toBe(5);
		expect(firstWordEndOnLine('well-known result\n', 0)).toBe(10);
	});

	it('counts digits as word characters, so a numbered line still resolves', () => {
		expect(firstWordEndOnLine('2024 was the year\n', 0)).toBe(4);
	});

	it('gives up on a line with no word at all, rather than aiming at markup', () => {
		expect(firstWordEndOnLine('\n', 0)).toBeNull();
		expect(firstWordEndOnLine('   \n', 0)).toBeNull();
		expect(firstWordEndOnLine('#{}[]()\n', 0)).toBeNull();
	});
});
