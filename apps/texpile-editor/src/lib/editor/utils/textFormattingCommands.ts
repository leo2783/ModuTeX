import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { isFontSize, isParagraphAlignment } from '../../schema/text-formatting';

export interface TextFormattingReceipt {
	readonly doc: Node;
	readonly selection: EditorState['selection'];
}
export interface TextFormattingHost {
	readonly state: EditorState;
	readonly editable: boolean;
	dispatch(transaction: Transaction): void;
}
/** Capture BEFORE opening a menu/await. Reuse only while exact doc and selection survive. */
export function captureTextFormattingReceipt(state: EditorState): TextFormattingReceipt {
	return Object.freeze({ doc: state.doc, selection: state.selection });
}
function supportedParagraphs(host: TextFormattingHost, receipt: TextFormattingReceipt): number[] | null {
	const { state } = host;
	if (!host.editable || state.doc !== receipt.doc || state.selection !== receipt.selection || !(state.selection instanceof TextSelection))
		return null;
	const positions: number[] = [];
	let unsupported = false;
	state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos, parent) => {
		if (node.type.name === 'paragraph') {
			node.forEach((child) => {
				if (!child.isText) unsupported = true;
			});
			if (parent !== state.doc)
				unsupported = true; // list/table/unknown architecture is not owned here
			else positions.push(pos);
		} else if (node.isText) {
			if (parent?.type.name !== 'paragraph') unsupported = true;
		} else unsupported = true; // includes math, raw chips, node/cell selections
	});
	// An empty selection still owns the containing paragraph, but has no selected text range.
	if (state.selection.empty && positions.length === 0) {
		const $from = state.selection.$from;
		if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return null;
		$from.parent.forEach((child) => {
			if (!child.isText) unsupported = true;
		});
		positions.push($from.before());
	}
	return !unsupported && positions.length > 0 ? positions : null;
}
/** Read-only eligibility check for toolbar state; application commands repeat this exact gate. */
export function supportsTextFormatting(host: TextFormattingHost, receipt: TextFormattingReceipt): boolean {
	return supportedParagraphs(host, receipt) !== null;
}
/** One undoable transaction. null removes the size mark; no arbitrary point-size TeX. */
export function applyTextFontSize(host: TextFormattingHost, receipt: TextFormattingReceipt, size: unknown): boolean {
	if (size !== null && !isFontSize(size)) return false;
	if (!supportedParagraphs(host, receipt)) return false;
	const { state } = host;
	const mark = state.schema.marks.font_size;
	if (!mark) return false;
	const tr = state.tr;
	if (state.selection.empty) {
		if (size === null) tr.removeStoredMark(mark);
		else tr.addStoredMark(mark.create({ size }));
	} else {
		tr.removeMark(state.selection.from, state.selection.to, mark);
		if (size !== null) tr.addMark(state.selection.from, state.selection.to, mark.create({ size }));
	}
	host.dispatch(tr);
	return true;
}
/** auto removes our scoped alignment; does not evaluate or rewrite foreign source scopes. */
export function applyParagraphAlignment(host: TextFormattingHost, receipt: TextFormattingReceipt, alignment: unknown): boolean {
	if (!isParagraphAlignment(alignment)) return false;
	const positions = supportedParagraphs(host, receipt);
	if (!positions) return false;
	const tr = host.state.tr;
	for (const pos of positions) {
		const node = host.state.doc.nodeAt(pos)!;
		tr.setNodeMarkup(pos, undefined, { ...node.attrs, alignment });
	}
	host.dispatch(tr);
	return true;
}
