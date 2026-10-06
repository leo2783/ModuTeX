/**
 * The live preview's own log. Its fixture is a real lualatex run of the MWE from the Unicode bug
 * report -- babel's hebrew ldf refusing LuaTeX, which then leaves every Hebrew character with no
 * glyph in the fallback font.
 *
 * The point of the test is the SHAPE of that failure. The engine still ships a page, so nothing
 * about the compile looks unsuccessful; the only trace is in the log. Live mode was not reading
 * that log at all -- the normal pipeline polls the .log of the user's compile command, which never
 * runs in live mode -- so this document rendered visibly wrong with an empty Problems panel and no
 * indication anywhere of why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCompileDiagnostics } from '$lib/latex-log';

const log = readFileSync(join(__dirname, 'fixtures', 'babel-hebrew-luatex.log'), 'utf8');

describe('draft compile log', () => {
	const parsed = parseCompileDiagnostics(log, null, null);

	it('reports the package error that broke the document', () => {
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.some((e) => /'hebrew' ldf style doesn't work with luatex/.test(e.message))).toBe(true);
	});

	it('reports the knock-on errors rather than only the first', () => {
		expect(parsed.errors.some((e) => /Right-to-Left Support Error/.test(e.message))).toBe(true);
		expect(parsed.errors.some((e) => /Undefined control sequence/.test(e.message))).toBe(true);
	});

	it('reports a missing character per unrenderable glyph', () => {
		// the ONLY machine-readable sign that the Hebrew silently vanished: no error accompanies it,
		// the page ships, and the text is simply absent
		const missing = parsed.warnings.filter((w) => /Missing character/.test(w.message));
		expect(missing.length).toBeGreaterThanOrEqual(5);
		expect(missing.some((w) => /U\+05E2/.test(w.message))).toBe(true);
	});

	it('separates errors from warnings', () => {
		expect(parsed.warnings.some((w) => /inputenc package ignored/.test(w.message))).toBe(true);
		expect(parsed.errors.every((e) => !/Missing character/.test(e.message))).toBe(true);
	});
});
