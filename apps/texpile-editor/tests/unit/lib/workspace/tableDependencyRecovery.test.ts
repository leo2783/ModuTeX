// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DocumentBuffer } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';
import { setTableColumnWidth } from '$lib/editor/comp/toolbar/table-preset-commands';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import { schema } from '$lib/schema/schema';

const source = String.raw`\documentclass{article}
% Keep this preamble comment.
\usepackage{booktabs}
\begin{document}
Unrelated text.
\begin{table}[h]
\caption{Keep the caption}
\begin{tabularx}{0.8\textwidth}{XX}
\toprule
Header A & Header B \\
\midrule
Value A & Value B \\
\bottomrule
\end{tabularx}
\end{table}
\end{document}
`;

const views: EditorView[] = [];
afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
	document.body.replaceChildren();
});

function harness(text = source, path = '/workspace/main.tex') {
	const saves: string[] = [];
	const buffer = new DocumentBuffer({
		scheduleSave: (_path, content) => saves.push(content),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor: () => {}
	});
	buffer.openTex(path, text, text.includes('\r\n') ? '\r\n' : '\n');
	const parsed = parseLatexFile(text);
	buffer.adoptParsed(parsed);
	const view = new EditorView(document.body.appendChild(document.createElement('div')), {
		state: EditorState.create({ schema, doc: parsed.doc }),
		dispatchTransaction(tr) {
			view.updateState(view.state.apply(tr));
			if (tr.docChanged) buffer.onVisualChange(view.state.doc);
		}
	});
	views.push(view);
	return { buffer, parsed, saves, view };
}

function tableOf(doc: PMNode) {
	let target: { pos: number; node: PMNode } | null = null;
	doc.descendants((node, pos) => {
		if (node.type.name === 'table' && !target) target = { pos, node };
	});
	if (!target) throw new Error('Expected a parsed table');
	return target as { pos: number; node: PMNode };
}

describe('real table edits through the authoritative document save buffer', () => {
	it.each(['\n', '\r\n'])('adds tabularx once on width editing, preserves preamble bytes and survives reopen (%j)', (eol) => {
		const text = source.replaceAll('\n', eol);
		const h = harness(text);
		expect(setTableColumnWidth(h.view, tableOf(h.view.state.doc), 0, 40)).toBe(true);
		expect(h.saves).toHaveLength(1);
		expect(h.buffer.docMeta!.preamble).toBe(
			h.parsed.preamble.replace(`\\usepackage{booktabs}${eol}`, `\\usepackage{booktabs}${eol}\\usepackage{tabularx}${eol}`)
		);
		expect(h.buffer.texSource).toContain('p{0.4\\linewidth}X');
		expect(h.buffer.texSource).toContain('Header A & Header B');
		expect(h.buffer.texSource).toContain('Value A & Value B');
		expect(h.buffer.texSource).toContain('Keep the caption');
		expect(setTableColumnWidth(h.view, tableOf(h.view.state.doc), 1, 35)).toBe(true);
		expect(h.buffer.texSource.match(/\\usepackage\{tabularx\}/g)).toHaveLength(1);
		const reopened = parseLatexFile(h.buffer.texSource);
		expect(serializeLatexFile(reopened, reopened.doc)).toBe(h.buffer.texSource);
		expect(tableOf(reopened.doc).node.attrs.colspec).toBe('p{0.4\\linewidth}p{0.35\\linewidth}');
	});

	it('does not rewrite a missing dependency on open, no-edit clone or unrelated paragraph edit', () => {
		const h = harness();
		expect(h.buffer.texSource).toBe(source);
		h.buffer.onVisualChange(PMNode.fromJSON(schema, h.parsed.doc.toJSON()));
		expect(h.buffer.texSource).toBe(source);
		expect(h.saves).toEqual([]);
		let pos = -1;
		h.view.state.doc.descendants((node, at) => {
			if (node.type.name === 'paragraph' && node.textContent === 'Unrelated text.') pos = at + 1;
		});
		expect(pos).toBeGreaterThan(-1);
		h.view.dispatch(h.view.state.tr.insertText('Edited ', pos));
		expect(h.buffer.texSource).not.toContain('\\usepackage{tabularx}');
		expect(h.buffer.docMeta!.preamble).toBe(h.parsed.preamble);
	});

	it('recognizes an existing multi-package declaration with options and does not duplicate it', () => {
		const h = harness(source.replace('\\usepackage{booktabs}', '\\usepackage{booktabs}\n\\usepackage[debugshow]{tabularx,array}'));
		setTableColumnWidth(h.view, tableOf(h.view.state.doc), 0, 40);
		expect(h.buffer.docMeta!.preamble).toBe(h.parsed.preamble);
		expect(h.buffer.texSource).not.toContain('\\usepackage{tabularx}');
	});

	it('does not treat a commented declaration as loaded', () => {
		const h = harness(source.replace('% Keep this preamble comment.', '% \\usepackage{tabularx}'));
		setTableColumnWidth(h.view, tableOf(h.view.state.doc), 0, 40);
		expect(h.buffer.texSource).toContain('% \\usepackage{tabularx}\n');
		expect(h.buffer.texSource).toContain('\n\\usepackage{tabularx}\n');
	});

	it('covers the legacy serializer fallback when a newly created table has no layout attrs', () => {
		const h = harness('\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n');
		const presetTable = createTableNode(schema, 2, 2, false, 'full-grid');
		const legacyTable = presetTable.type.create({ ...presetTable.attrs, env: null, colspec: null }, presetTable.content);
		const wrapper = schema.nodes.table_wrapper.create(null, legacyTable);
		h.buffer.onVisualChange(h.parsed.doc.copy(h.parsed.doc.content.append(Fragment.from(wrapper))));
		expect(h.buffer.texSource).toContain('\\begin{tabularx}');
		expect(h.buffer.texSource).toContain('\\usepackage{tabularx}');
	});

	it('plain tabular presets/width changes do not add tabularx', () => {
		const h = harness(source.replaceAll('tabularx', 'tabular').replace('{0.8\\textwidth}{XX}', '{cc}'));
		setTableColumnWidth(h.view, tableOf(h.view.state.doc), 0, 40);
		expect(h.buffer.texSource).toContain('\\begin{tabular}{p{0.4\\linewidth}c}');
		expect(h.buffer.docMeta!.preamble).toBe(h.parsed.preamble);
	});

	it.each([
		source.replace('\\begin{document}', '\\input{local-config}\n\\begin{document}'),
		source.slice(source.indexOf('\\begin{table}'), source.indexOf('\\end{table}') + '\\end{table}'.length)
	])('never injects into an indirect preamble or document fragment', (text) => {
		const h = harness(text);
		setTableColumnWidth(h.view, tableOf(h.view.state.doc), 0, 40);
		expect(h.buffer.docMeta!.preamble).toBe(h.parsed.preamble);
		expect(h.buffer.texSource).not.toContain('\\usepackage{tabularx}');
	});
});
