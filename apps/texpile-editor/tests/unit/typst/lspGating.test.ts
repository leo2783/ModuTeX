// When the Typst language server runs. It activates on the FILE, like every other language server
// (VS Code's own tinymist extension is `onLanguage:typst`) — not on the project's compile command,
// which would deny intellisense to anyone building Typst from a Makefile. Its ~90MB is reclaimed by
// releasing the server when the last .typ editor closes, not by refusing to start it.
//
// Mirrors the condition in SourceEditor.svelte, which cannot be imported out of a component.
import { describe, it, expect } from 'vitest';

/** the rule as implemented: a .typ file, and the setting not turned off */
const shouldRun = (file: string | null, intellisense: boolean) => !!file && /\.typ$/i.test(file) && intellisense;

describe('when the Typst language server should run', () => {
	it('runs for a .typ file', () => {
		expect(shouldRun('C:/p/main.typ', true)).toBe(true);
		expect(shouldRun('C:/p/sub/chapter.TYP', true)).toBe(true);
	});

	it('runs for a .typ inside a LaTeX project', () => {
		// activation follows the language, not the build. Someone editing a .typ still wants
		// completion in it, whatever the folder compiles with.
		expect(shouldRun('C:/latex-project/notes.typ', true)).toBe(true);
	});

	it('does not run for other files', () => {
		expect(shouldRun('C:/p/main.tex', true)).toBe(false);
		expect(shouldRun('C:/p/refs.bib', true)).toBe(false);
		expect(shouldRun('C:/p/README.md', true)).toBe(false);
		expect(shouldRun(null, true)).toBe(false);
	});

	it('does not run when the user turned intellisense off', () => {
		expect(shouldRun('C:/p/main.typ', false)).toBe(false);
	});

	it('is not fooled by .typ appearing mid-name', () => {
		expect(shouldRun('C:/p/main.typ.bak', true)).toBe(false);
		expect(shouldRun('C:/p/typst/notes.tex', true)).toBe(false);
	});
});
