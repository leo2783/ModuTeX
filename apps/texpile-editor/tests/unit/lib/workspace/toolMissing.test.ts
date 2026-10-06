import { describe, it, expect } from 'vitest';
import { leadingProgram, shellSaidNotFound } from '$lib/workspace/toolMissing';

describe('leadingProgram', () => {
	it('takes the first word of a command', () => {
		expect(leadingProgram('latexmk -pdf -interaction=nonstopmode main.tex')).toBe('latexmk');
	});

	it('strips a directory, quotes and .exe', () => {
		expect(leadingProgram('"C:\\texlive\\bin\\latexmk.exe" -pdf')).toBe('latexmk');
		expect(leadingProgram("'/usr/local/bin/xelatex' main.tex")).toBe('xelatex');
	});

	it('is null for an empty command', () => {
		expect(leadingProgram('   ')).toBeNull();
	});
});

describe('shellSaidNotFound', () => {
	const CASES: Record<string, string> = {
		bash: 'bash: latexmk: command not found',
		zsh: 'zsh: command not found: latexmk',
		dash: 'sh: 1: latexmk: not found',
		cmd: "'latexmk' is not recognized as an internal or external command,\noperable program or batch file.",
		powershell: "latexmk : The term 'latexmk' is not recognized as a name of a cmdlet, function, script file, or executable program."
	};

	for (const [shell, output] of Object.entries(CASES)) {
		it(`recognizes ${shell}`, () => {
			expect(shellSaidNotFound(output, 'latexmk')).toBe(true);
		});
	}

	it('finds the line among a run of ordinary output', () => {
		const out = ['Compiling…', 'bash: tectonic: command not found', 'done'].join('\n');
		expect(shellSaidNotFound(out, 'tectonic')).toBe(true);
	});

	// the false positive this whole function is shaped around: a TeX log is full of "not found"
	it('does not mistake a missing package for a missing compiler', () => {
		const out = [
			'Latexmk: This is Latexmk, John Collins, 2024',
			"! LaTeX Error: File `geometry.sty' not found.",
			'Latexmk: Errors, so I did not complete making targets'
		].join('\n');
		expect(shellSaidNotFound(out, 'latexmk')).toBe(false);
	});

	it('does not fire when a DIFFERENT program was the missing one', () => {
		// biber missing is a real failure, but it is not the compile command's program, and telling
		// the user "latexmk was not found" would send them looking in the wrong place
		expect(shellSaidNotFound('bash: biber: command not found', 'latexmk')).toBe(false);
	});

	it('matches a quoted or path-qualified mention of the program', () => {
		expect(shellSaidNotFound("'/opt/texbin/latexmk' is not recognized as an internal or external command,", 'latexmk')).toBe(true);
	});

	it('says nothing for empty output or an empty program', () => {
		expect(shellSaidNotFound('', 'latexmk')).toBe(false);
		expect(shellSaidNotFound('bash: latexmk: command not found', '')).toBe(false);
	});

	it('treats a program name with regex characters literally', () => {
		expect(shellSaidNotFound('bash: c++: command not found', 'c++')).toBe(true);
		expect(shellSaidNotFound('bash: cXX: command not found', 'c++')).toBe(false);
	});
});
