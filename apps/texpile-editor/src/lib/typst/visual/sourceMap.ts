// Typst's side of the block source map (see markdown/sourceMap.ts for the full story). The
// property that matters: words surviving the strip must match the RENDERED text's words, in the
// same order and count — anything the reader never sees (link targets, fence delimiters, markers)
// must not survive, or the caret lands on the wrong repeat of a word.

/** strip Typst markup so what's left resembles the rendered text the editor shows. */
export function stripTypst(s: string): string {
	return (
		s
			// fence delimiter lines go, the code text stays: a code block renders its own contents
			.replace(/^[ \t]*```+.*$/gm, ' ')
			.replace(/`+/g, '')
			// block markers: heading '=', list '-'/'+', "1." enums, term '/'
			.replace(/^[ \t]*=+[ \t]+/gm, '')
			.replace(/^[ \t]*(?:[-+]|\d+[.)])[ \t]+/gm, '')
			.replace(/^[ \t]*\/[ \t]+/gm, '')
			// #link("url")[text]: the visible text stays, the target never
			.replace(/#link\("[^"]*"\)\[([^\]]*)\]/g, '$1')
			// equations render as leaf objects the text index counts as one char
			.replace(/\$[^$\n]*\$/g, ' ')
			// labels are invisible in the rendered text
			.replace(/<[\p{L}\d_.:-]+>/gu, ' ')
			// emphasis delimiters. `_` only at word edges, so snake_case survives as ONE word
			.replace(/\*/g, '')
			.replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
			// backslash escapes reveal the character the reader actually sees
			.replace(/\\([^\p{L}\p{N}])/gu, '$1')
	);
}
