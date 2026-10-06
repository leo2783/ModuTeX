// Narrows "the document changed to this" into the smallest single replacement that gets there.
//
// CodeMirror maps the caret, decorations and scroll position through a transaction's changes.
// A position INSIDE a changed range has nowhere faithful to map to, so it collapses to the
// range's edge; a position outside maps identically. Replacing a whole buffer therefore loses
// the user's place every time, while replacing only the differing middle almost never does --
// external pushes are usually a save round-trip or a normalization, differing in a few bytes.
//
// Deliberately a common-prefix/suffix trim rather than a real diff: it is O(n) with no
// allocation, and the one case it handles poorly (a change at both ends but not the middle) is
// no worse than the whole-buffer replacement it replaced.

export type Edit = { from: number; to: number; insert: string };

/**
 * The smallest `{from, to, insert}` that turns `from` into `to`. Returns a zero-width, empty
 * edit when the two are already equal, which callers may dispatch harmlessly or skip.
 */
export function minimalEdit(oldText: string, newText: string): Edit {
	const max = Math.min(oldText.length, newText.length);
	let pre = 0;
	while (pre < max && oldText.charCodeAt(pre) === newText.charCodeAt(pre)) pre++;
	// stop the suffix scan at the prefix, or the two overlap on a repeated run ("aaa" -> "aa")
	// and the edit comes out with to < from
	let suf = 0;
	while (suf < max - pre && oldText.charCodeAt(oldText.length - 1 - suf) === newText.charCodeAt(newText.length - 1 - suf)) suf++;
	return { from: pre, to: oldText.length - suf, insert: newText.slice(pre, newText.length - suf) };
}
