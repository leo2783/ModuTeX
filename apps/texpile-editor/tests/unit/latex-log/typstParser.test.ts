// Samples are real tinymist 0.15.2 output, captured by compiling broken documents.
import { describe, it, expect } from 'vitest';
import { isTypstLog, parseTypstLog } from '$lib/latex-log/typst-parser';
import { parseCompileDiagnostics } from '$lib/latex-log';

const P = 'C:\\proj\\main.typ';

const PARSE_ERRORS = `error: expected expression
  ┌─ ${P}:3:8
  │
3 │ #let x =
  │         ^

error: unclosed delimiter
  ┌─ ${P}:8:6
  │
8 │ #lorem(5
  │       ^
`;

// an error with a `help:` call-trace frame, followed by an unrelated warning
const TRACE_AND_WARNING = `error: cannot add string and integer
  ┌─ ${P}:3:12
  │
3 │ #let f(x) = x + 1
  │             ^^^^^

help: while calling \`f\`
  ┌─ ${P}:4:1
  │
4 │ #f("string")
  │  ^^^^^^^^^^^

warning: unknown font family: no such font family
  ┌─ ${P}:1:16
  │
1 │ #set text(font: "No Such Font Family")
  │                 ^^^^^^^^^^^^^^^^^^^^^
`;

describe('isTypstLog', () => {
	it('recognises tinymist output', () => {
		expect(isTypstLog(PARSE_ERRORS)).toBe(true);
	});

	it('rejects a TeX log', () => {
		const tex = `This is pdfTeX, Version 3.141592653\n! Undefined control sequence.\nl.5 \\alpah\n`;
		expect(isTypstLog(tex)).toBe(false);
	});

	it('rejects an empty log (a clean run)', () => {
		expect(isTypstLog('')).toBe(false);
	});
});

describe('parseTypstLog', () => {
	it('reads message, file, line and column', () => {
		const [first, second] = parseTypstLog(PARSE_ERRORS);
		expect(first).toMatchObject({ level: 'error', message: 'expected expression', file: P, line: 3, column: 8 });
		expect(second).toMatchObject({ level: 'error', message: 'unclosed delimiter', file: P, line: 8, column: 6 });
	});

	it('keeps a Windows drive letter out of the line/column split', () => {
		// the path regex is greedy: the LAST two colon groups are the position
		expect(parseTypstLog(PARSE_ERRORS)[0].file).toBe('C:\\proj\\main.typ');
	});

	it('folds a help: trace into the preceding error rather than emitting a row for it', () => {
		const entries = parseTypstLog(TRACE_AND_WARNING);
		expect(entries.map((e) => e.level)).toEqual(['error', 'warning']);
		expect(entries[0].message).toBe('cannot add string and integer');
		expect(entries[0].context).toContain('while calling `f`');
		// the trace's own location must not overwrite the error's
		expect(entries[0].line).toBe(3);
	});

	it('attributes the warning to its own position, not the error above it', () => {
		const warning = parseTypstLog(TRACE_AND_WARNING)[1];
		expect(warning).toMatchObject({ level: 'warning', line: 1, column: 16 });
	});

	it('captures the underlined span as the anchor text', () => {
		expect(parseTypstLog(TRACE_AND_WARNING)[0].anchorText).toBe('x + 1');
	});

	it('caps pathological input', () => {
		const many = Array.from({ length: 40 }, (_, i) => `error: boom ${i}\n  ┌─ ${P}:${i + 1}:1\n`).join('\n');
		expect(parseTypstLog(many, { maxEntries: 10 })).toHaveLength(10);
	});
});

describe('parseCompileDiagnostics dispatch', () => {
	it('routes a Typst log to the Typst parser', () => {
		const r = parseCompileDiagnostics(TRACE_AND_WARNING);
		expect(r.errors).toHaveLength(1);
		expect(r.warnings).toHaveLength(1);
		expect(r.errors[0].message).toBe('cannot add string and integer');
	});

	it('leaves a clean (empty) log with no problems', () => {
		const r = parseCompileDiagnostics('');
		expect(r.errors).toHaveLength(0);
		expect(r.warnings).toHaveLength(0);
	});
});
