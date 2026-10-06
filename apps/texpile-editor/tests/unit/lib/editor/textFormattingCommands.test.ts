import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, NodeSelection, type Transaction } from 'prosemirror-state';
import { history, undo, redo } from 'prosemirror-history';
import { schema } from '$lib/schema/schema';
import {
	applyParagraphAlignment,
	applyTextFontSize,
	captureTextFormattingReceipt,
	supportsTextFormatting
} from '$lib/editor/utils/textFormattingCommands';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';
import { serializeNode } from '$lib/serializer/latexSerializer';

function harness(
	doc = schema.nodes.doc.create(null, [
		schema.nodes.paragraph.create(null, schema.text('First')),
		schema.nodes.paragraph.create(null, schema.text('Second'))
	])
) {
	let state = EditorState.create({ doc, plugins: [history()] });
	state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
	const transactions: Transaction[] = [];
	const host = {
		get state() {
			return state;
		},
		editable: true,
		dispatch(tr: Transaction) {
			transactions.push(tr);
			state = state.apply(tr);
		}
	};
	return { host, transactions };
}
describe('text-formatting commands', () => {
	it('enables a current top-level plain-text selection and caret', () => {
		const { host } = harness();
		expect(supportsTextFormatting(host, captureTextFormattingReceipt(host.state))).toBe(true);
		host.dispatch(host.state.tr.setSelection(TextSelection.create(host.state.doc, 2)));
		expect(supportsTextFormatting(host, captureTextFormattingReceipt(host.state))).toBe(true);
	});
	it('disables stale receipts and read-only hosts', () => {
		const { host } = harness();
		const stale = captureTextFormattingReceipt(host.state);
		host.dispatch(host.state.tr.setSelection(TextSelection.create(host.state.doc, 2)));
		expect(supportsTextFormatting(host, stale)).toBe(false);
		const current = captureTextFormattingReceipt(host.state);
		host.editable = false;
		expect(supportsTextFormatting(host, current)).toBe(false);
	});
	for (const indent of ['auto', 'indent', 'noindent'])
		for (const mark of [null, 'strong', 'em', 'u', 'sup', 'sub', 'code', 'textcolor', 'link', 'highlight'])
			it(`reopens generated size/alignment with ${indent} and ${mark ?? 'plain text'}`, () => {
				const attrs =
					mark === 'textcolor' || mark === 'highlight'
						? { color: 'red' }
						: mark === 'link'
							? { href: 'https://example.org/a?x=1&y=2' }
							: {};
				const marks = mark ? [schema.marks[mark].create(attrs)] : [];
				const text = 'A \\ { } # % & $ _ ^ B';
				const { host } = harness(schema.nodes.doc.create(null, schema.nodes.paragraph.create({ indent }, schema.text(text, marks))));
				expect(applyTextFontSize(host, captureTextFormattingReceipt(host.state), 'Large')).toBe(true);
				expect(applyParagraphAlignment(host, captureTextFormattingReceipt(host.state), 'center')).toBe(true);
				const generated = serializeNode(host.state.doc.firstChild!, {
					parent: host.state.doc,
					index: 0,
					isLastChild: true,
					inTableCell: false
				});
				const reopened = parseLatexFile('\\documentclass{article}\n\\begin{document}\n' + generated + '\n\\end{document}').doc;
				expect(reopened.firstChild!.type.name).toBe('paragraph');
				expect(reopened.firstChild!.attrs).toMatchObject({ alignment: 'center', indent });
				expect(reopened.textContent).toBe(text);
				reopened.firstChild!.forEach((child) => {
					expect(child.isText).toBe(true);
					expect(child.marks.some((m) => m.type.name === 'font_size' && m.attrs.size === 'Large')).toBe(true);
					if (mark) expect(child.marks.some((m) => m.type.name === mark)).toBe(true);
				});
			});
	it('sets multiple paragraph alignments in one undoable transaction and preserves indent', () => {
		const { host, transactions } = harness();
		expect(applyParagraphAlignment(host, captureTextFormattingReceipt(host.state), 'center')).toBe(true);
		expect(transactions).toHaveLength(1);
		expect(host.state.doc.child(0).attrs.alignment).toBe('center');
		expect(host.state.doc.child(1).attrs.alignment).toBe('center');
		expect(undo(host.state, host.dispatch)).toBe(true);
		expect(host.state.doc.child(0).attrs.alignment).toBe('auto');
		expect(redo(host.state, host.dispatch)).toBe(true);
		expect(host.state.doc.child(0).attrs.alignment).toBe('center');
	});
	it('sets and removes a finite font size with one transaction per action', () => {
		const { host, transactions } = harness();
		expect(applyTextFontSize(host, captureTextFormattingReceipt(host.state), 'Large')).toBe(true);
		expect(transactions).toHaveLength(1);
		expect(host.state.doc.firstChild!.firstChild!.marks[0].attrs.size).toBe('Large');
		expect(applyTextFontSize(host, captureTextFormattingReceipt(host.state), null)).toBe(true);
		expect(host.state.doc.firstChild!.firstChild!.marks).toEqual([]);
	});
	it('supports an empty caret through stored marks without changing existing text', () => {
		const { host } = harness();
		host.dispatch(host.state.tr.setSelection(TextSelection.create(host.state.doc, 2)));
		const original = host.state.doc;
		expect(applyTextFontSize(host, captureTextFormattingReceipt(host.state), 'small')).toBe(true);
		expect(host.state.doc).toBe(original);
		expect(host.state.storedMarks?.[0].attrs.size).toBe('small');
	});
	it('rejects stale document, selection, noneditable, and arbitrary values without dispatch', () => {
		const { host, transactions } = harness();
		const receipt = captureTextFormattingReceipt(host.state);
		host.dispatch(host.state.tr.setSelection(TextSelection.create(host.state.doc, 2)));
		transactions.length = 0;
		expect(applyTextFontSize(host, receipt, 'small')).toBe(false);
		expect(applyParagraphAlignment(host, receipt, 'center')).toBe(false);
		const current = captureTextFormattingReceipt(host.state);
		host.editable = false;
		expect(applyParagraphAlignment(host, current, 'right')).toBe(false);
		host.editable = true;
		expect(applyTextFontSize(host, current, '42pt')).toBe(false);
		expect(applyParagraphAlignment(host, current, 'justify; color:red')).toBe(false);
		expect(transactions).toHaveLength(0);
		host.dispatch(host.state.tr.insertText('new', 1));
		transactions.length = 0;
		expect(applyParagraphAlignment(host, current, 'center')).toBe(false);
		expect(transactions).toHaveLength(0);
	});
	for (const kind of ['raw_latex', 'block_math', 'table'])
		it(`rejects ${kind} without mutation`, () => {
			const node =
				kind === 'table'
					? schema.nodes.table.create(
							null,
							schema.nodes.table_row.create(
								null,
								schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text('Cell')))
							)
						)
					: schema.nodes[kind].create(null, schema.text('x'));
			let state = EditorState.create({ doc: schema.nodes.doc.create(null, node) });
			state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 0)));
			const dispatch = () => {
				throw new Error('Must not dispatch');
			};
			const host = { state, editable: true, dispatch };
			expect(applyTextFontSize(host, captureTextFormattingReceipt(state), 'small')).toBe(false);
			expect(applyParagraphAlignment(host, captureTextFormattingReceipt(state), 'left')).toBe(false);
		});
	for (const kind of ['inline_latex', 'inline_math'])
		it(`rejects a caret in a paragraph containing ${kind}`, () => {
			const paragraph = schema.nodes.paragraph.create(null, [
				schema.text('Before'),
				schema.nodes[kind].create(null, schema.text('x')),
				schema.text('After')
			]);
			let state = EditorState.create({ doc: schema.nodes.doc.create(null, paragraph) });
			state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
			const host = {
				state,
				editable: true,
				dispatch() {
					throw new Error('Must not dispatch');
				}
			};
			const receipt = captureTextFormattingReceipt(state);
			expect(supportsTextFormatting(host, receipt)).toBe(false);
			expect(applyTextFontSize(host, receipt, 'small')).toBe(false);
			expect(applyParagraphAlignment(host, receipt, 'left')).toBe(false);
		});
	it('disables a caret in a list and a selection spanning a non-paragraph block', () => {
		const listedParagraph = schema.nodes.paragraph.create(null, schema.text('List text'));
		const list = schema.nodes.list.create({ kind: 'bullet' }, listedParagraph);
		let listState = EditorState.create({ doc: schema.nodes.doc.create(null, list) });
		listState = listState.apply(listState.tr.setSelection(TextSelection.create(listState.doc, 4)));
		const listHost = { state: listState, editable: true, dispatch() {} };
		expect(supportsTextFormatting(listHost, captureTextFormattingReceipt(listState))).toBe(false);

		const paragraph = schema.nodes.paragraph.create(null, schema.text('Plain'));
		const codeBlock = schema.nodes.code_block.create(null, schema.text('Code'));
		let mixedState = EditorState.create({ doc: schema.nodes.doc.create(null, [paragraph, codeBlock]) });
		mixedState = mixedState.apply(mixedState.tr.setSelection(TextSelection.create(mixedState.doc, 1, paragraph.nodeSize + 2)));
		const mixedHost = { state: mixedState, editable: true, dispatch() {} };
		expect(supportsTextFormatting(mixedHost, captureTextFormattingReceipt(mixedState))).toBe(false);
	});
});
