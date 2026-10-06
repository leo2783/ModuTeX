/* tslint:disable */
/* eslint-disable */

/**
 * A parsed Typst document that can be edited incrementally.
 */
export class TypstSyntax {
	free(): void;
	[Symbol.dispose](): void;
	/**
	 * The syntax tree, flattened into Lezer's `Tree.build` buffer format.
	 *
	 * Four values per node - `[typeId, from, to, size]` - where `size` counts the array entries
	 * covering the node AND its children. Children come before their parent, and siblings in
	 * document order, which is the post-order Lezer's buffer cursor reads.
	 *
	 * Offsets are UTF-16 code units, not bytes: CodeMirror positions are UTF-16, and converting
	 * here (where the text is at hand) is cheaper and less error-prone than doing it in JS.
	 */
	buffer(): Uint32Array;
	/**
	 * Replace the byte range `[from, to)` with `with`, reparsing incrementally.
	 *
	 * Offsets are BYTE offsets into the current text, which is what `Source` speaks. The JS side
	 * converts from CodeMirror's UTF-16 code-unit positions before calling.
	 */
	edit(from: number, to: number, _with: string): void;
	constructor(text: string);
	/**
	 * The node-type table for the tree most recently returned by `buffer`, as newline-separated
	 * names in id order. Id 0 is Lezer's `NodeType.none` and is not listed.
	 */
	node_names(): string;
	/**
	 * Replace the whole text. `Source::replace` diffs it down to one edit internally, so this is
	 * still cheaper than constructing a new parser.
	 */
	set_text(text: string): void;
	text_len(): number;
	/**
	 * The id `Tree.build` should use for the top node.
	 */
	top_name(): string;
}
