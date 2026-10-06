// The Format chips in the compile-command modal regenerate the command. These cover the switch
// itself: what the chips read back, and that a round trip does not lose the build directory.
import { describe, it, expect } from 'vitest';
import { buildCompileCommand, compileOutDir, detectEngine } from '$lib/workspace/compileCommand';
import { buildTypstCommand, isTypstCommand } from '$lib/workspace/typstCommand';

// mirrors applyFormat in CompileCommandModal.svelte
function applyFormat(command: string, next: 'latex' | 'typst', main: string | null): string {
	if ((next === 'typst') === isTypstCommand(command)) return command;
	return next === 'typst' ? buildTypstCommand(main) : buildCompileCommand(detectEngine(command) ?? 'lualatex', true, command);
}

const LATEX = 'latexmk -lualatex -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=output {main}';

describe('format switch', () => {
	it('turns a LaTeX command into a Typst one named after the main file', () => {
		const out = applyFormat(LATEX, 'typst', 'C:/proj/thesis.typ');
		expect(isTypstCommand(out)).toBe(true);
		expect(out).toContain('output/thesis.pdf');
	});

	it('turns a Typst command back into a LaTeX one', () => {
		const typ = buildTypstCommand('C:/proj/main.typ');
		const out = applyFormat(typ, 'latex', 'C:/proj/main.typ');
		expect(isTypstCommand(out)).toBe(false);
		expect(detectEngine(out)).toBe('lualatex');
	});

	it('keeps the build directory across a round trip', () => {
		const custom = 'latexmk -lualatex -output-directory=build {main}';
		const toTypst = applyFormat(custom, 'typst', 'C:/proj/main.typ');
		expect(compileOutDir(toTypst)).toBe('output'); // buildTypstCommand's own default
		const back = applyFormat(toTypst, 'latex', 'C:/proj/main.typ');
		// the LaTeX form reads the directory out of whatever the command currently is, so the
		// output does not silently move to the project root on the way back
		expect(compileOutDir(back)).toBe('output');
	});

	it('is a no-op when the format is already selected', () => {
		// re-clicking must not regenerate: it would discard flags the user typed in by hand
		const custom = 'latexmk -lualatex -shell-escape -output-directory=out {main}';
		expect(applyFormat(custom, 'latex', null)).toBe(custom);
		const typ = 'tinymist compile --root . --font-path ./fonts {main} out/x.pdf 2>out/x.log';
		expect(applyFormat(typ, 'typst', null)).toBe(typ);
	});

	it('reads the chip state back out of a hand-written command', () => {
		expect(isTypstCommand('typst compile --root . {main} out.pdf')).toBe(true);
		expect(isTypstCommand('make pdf')).toBe(false);
	});
});
