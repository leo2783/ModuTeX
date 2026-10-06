// "The compile command names a program that isn't installed" - detected two ways, from one place.
//
// The compile modal asks BEFORE the fact, by probing for the program the command starts with. The
// pipeline finds out AFTER it, from what the shell printed. Both need the same idea of which
// program a command runs, and both should agree about what counts as proof, so both live here and
// are pure - no DOM, no IPC, unit-testable.

/**
 * The program a shell command runs: its first word, minus surrounding quotes, any directory, and a
 * .exe suffix. Null when there is no first word.
 *
 * A first word is all this claims to find. `VAR=1 latexmk`, a pipeline, a `cmd && cmd` chain - the
 * answer will be wrong-ish, and that is fine: every caller treats an unrecognised program as "no
 * opinion" rather than as a problem, so a bad guess costs a warning that is never shown, not a
 * false accusation.
 */
export function leadingProgram(cmd: string): string | null {
	const first = cmd
		.trim()
		.split(/\s+/)[0]
		?.replace(/^["']|["']$/g, '');
	if (!first) return null;
	const base = (first.split(/[/\\]/).pop() ?? first).replace(/\.exe$/i, '').toLowerCase();
	return base || null;
}

/**
 * What each shell says when it cannot find a program.
 *
 *   bash/zsh   bash: latexmk: command not found  |  zsh: command not found: latexmk
 *   dash/sh    sh: 1: latexmk: not found
 *   cmd.exe    'latexmk' is not recognized as an internal or external command,
 *   PowerShell The term 'latexmk' is not recognized as a name of a cmdlet...
 */
const NOT_FOUND = [/command not found/i, /:\s*not found\b/, /is not recognized as (?:an internal|a name)/i, /CommandNotFoundException/];

/**
 * Did the shell report `program` as missing, in this run's output?
 *
 * BOTH conditions on ONE line: the line has to name the program AND carry a shell's not-found
 * phrasing. Either alone is a false positive waiting to happen - a TeX log is full of `File
 * 'geometry.sty' not found`, and latexmk prints its own name on most lines it writes. Requiring
 * them together is what keeps a missing .sty from being reported as a missing compiler.
 */
export function shellSaidNotFound(output: string, program: string): boolean {
	if (!program) return false;
	// the shell may quote it, path-qualify it, or add .exe; match the bare name on a word boundary
	const named = new RegExp(`(?:^|[^\\w.-])${program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.exe)?(?:$|[^\\w-])`, 'i');
	return output.split(/\r?\n/).some((line) => named.test(line) && NOT_FOUND.some((re) => re.test(line)));
}
