// Parse and generate the Typst compile command, the counterpart to compileCommand.ts.
//
// Typst's CLI surface differs from a TeX engine's in the two ways that matter to the pipeline:
//
//   - the output file is a POSITIONAL argument (`tinymist compile main.typ out/main.pdf`), not a
//     `-output-directory=` flag, so the PDF path is read off the command line rather than derived
//     from the main file's name;
//   - there is no .log file at all. Diagnostics go to stderr, so the generated command redirects
//     them into one, which lets the whole existing log-watch/settle/publish path work untouched.
//
// Pure string logic, same as compileCommand.ts.

import { joinPath } from './fileSystem';

/** true when the command drives Typst rather than a TeX engine. Matches the binary name at the
 * head of the line only: a `--root` pointing at a directory called `typst` must not count. */
export function isTypstCommand(cmd: string): boolean {
	return /^\s*(?:[^\s"']*[\\/])?(?:tinymist|typst)(?:\.exe)?(?:\s|$)/i.test(cmd);
}

/** Split a command line into tokens, honouring quotes. Quotes are stripped from the result. */
function tokenize(cmd: string): string[] {
	const out: string[] = [];
	// a quoted run, or a bare run of non-space characters
	for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
	return out;
}

// Options that take a separate value; the value must not be mistaken for a positional argument.
// (`--flag=value` needs no entry: it is a single token.)
const VALUED_FLAGS = new Set([
	'--root',
	'--input',
	'--font-path',
	'--package-path',
	'--package-cache-path',
	'--format',
	'-f',
	'--pages',
	'--pdf-standard',
	'--ppi',
	'--name',
	'--when',
	'--lockfile',
	'--creation-timestamp',
	'--jobs',
	'-j',
	'--features',
	'--diagnostic-format'
]);

/** The positional arguments of a `typst`/`tinymist` compile line, in order: [input, output?]. */
function positionals(cmd: string): string[] {
	// everything after the redirect belongs to the shell, not to typst
	const tokens = tokenize(cmd.split(/\d?>>?/)[0] ?? '');
	const out: string[] = [];
	// [0] is the binary itself; [1] is the subcommand when present (compile / watch)
	let i = /^(compile|watch|c|w)$/i.test(tokens[1] ?? '') ? 2 : 1;
	for (; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith('-')) {
			if (VALUED_FLAGS.has(t)) i++; // skip its value
			continue;
		}
		out.push(t);
	}
	return out;
}

/** The `2>`/`2>>` redirect target, or null when the command has none. */
export function typstLogArg(cmd: string): string | null {
	const m = cmd.match(/2>>?\s*("[^"]*"|'[^']*'|\S+)/);
	return m && m[1] ? m[1].replace(/^["']|["']$/g, '') : null;
}

/** The explicit output file typst was told to write, or null when it was left to default. */
export function typstPdfArg(cmd: string): string | null {
	const pos = positionals(cmd);
	// [input, output]: an output is only present as the SECOND positional. A lone positional is
	// the input, and typst then defaults the PDF to the input's name.
	return pos.length >= 2 ? (pos[1] ?? null) : null;
}

/**
 * The directory the build writes into, for the mkdir the pipeline does before compiling.
 * Derived from the output argument rather than a flag, since Typst has no -output-directory.
 */
export function typstOutDir(cmd: string): string {
	const out = typstPdfArg(cmd) ?? typstLogArg(cmd);
	if (!out) return '.';
	const norm = out.replace(/\\/g, '/');
	const slash = norm.lastIndexOf('/');
	return slash > 0 ? norm.slice(0, slash) : '.';
}

/**
 * `main.typ` -> `main`; used to name the build outputs after the document.
 *
 * Strips ANY extension, not just `.typ`: the Format switch can be flipped while a LaTeX project is
 * open, and stripping only `.typ` there left the main file's own extension in the middle of the
 * output name (`output/main.tex.pdf`).
 */
export function typstJobName(main: string | null): string {
	const base = (main ?? '').split(/[\\/]/).pop() ?? '';
	return base.replace(/\.[^.]+$/, '') || 'main';
}

/**
 * The standard command for a Typst project.
 *
 * `{main}` is expanded by the pipeline to the root-relative main file. The outputs are named after
 * it so a project called thesis.typ builds thesis.pdf, matching what `typst compile` alone would
 * have produced, only inside an output directory.
 *
 * Paths use forward slashes deliberately: Typst 0.15 made backslashes in paths a hard error, and
 * every shell we spawn accepts `/` on Windows too.
 */
export function buildTypstCommand(main: string | null, outDir = 'output'): string {
	const job = typstJobName(main);
	const dir = outDir && outDir !== '.' ? `${outDir.replace(/\\/g, '/').replace(/\/+$/, '')}/` : '';
	return `tinymist compile --root . {main} ${dir}${job}.pdf 2>${dir}${job}.log`;
}

/** Absolute PDF path for a Typst command: the explicit output, else typst's own default. */
export function typstPdfPath(cmd: string, root: string | null, main: string | null): string | null {
	if (!root) return null;
	const arg = typstPdfArg(cmd);
	if (arg) return joinPath(root, arg);
	if (!main) return null;
	// no output argument: typst writes <input>.pdf beside the input
	return joinPath(root, `${typstJobName(main)}.pdf`);
}

/**
 * Absolute path of the file the command redirects diagnostics into.
 *
 * null when there is no redirect — the caller must then treat the run as having no log rather
 * than inventing one, since an absent redirect means the diagnostics went to the terminal.
 */
export function typstLogPath(cmd: string, root: string | null): string | null {
	const arg = typstLogArg(cmd);
	return root && arg ? joinPath(root, arg) : null;
}
