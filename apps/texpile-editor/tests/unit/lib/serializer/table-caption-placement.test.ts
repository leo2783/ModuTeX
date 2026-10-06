import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { schema } from '$lib/schema/schema';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';
import { parseTypstFile, serializeTypstFile } from '$lib/typst/visual/roundtrip';
import { typSchema } from '$lib/typst/visual/schema';

const tabular = String.raw`\begin{tabular}{|l|c|}
\hline
CELL & B \\
\hline
\end{tabular}`;
const caption = String.raw`\caption[Short \emph{entry}]{Long caption}`;
const labels = String.raw`\label{tab:extra}\label{tab:main}`;
const setup = String.raw`\setlength{\tabcolsep}{4pt}`;

function source(placement: 'above' | 'below' | 'none'): string {
	return `\\documentclass{article}\n% untouched preamble\n\\usepackage{array}\n\\begin{document}\n% before float\n\\begin{table*}[t]\n${placement === 'above' ? caption + labels + '\n' : ''}${setup}\n${tabular}\n${placement === 'below' ? caption + labels + '\n' : placement === 'none' ? labels + '\n' : ''}\\end{table*}\n\\end{document}`;
}

function firstWrapper(doc: PMNode): { node: PMNode; pos: number } {
	let found: { node: PMNode; pos: number } | undefined;
	doc.descendants((node, pos) => {
		if (!found && node.type.name === 'table_wrapper') found = { node, pos };
	});
	if (!found) throw new Error('Expected editable table wrapper');
	return found;
}

function editCell(doc: PMNode, useSchema = schema): PMNode {
	let textPos: number | undefined;
	doc.descendants((node, pos) => {
		if (node.isText && node.text === 'CELL') textPos = pos;
	});
	if (textPos == null) throw new Error('Expected cell text');
	const state = EditorState.create({ schema: useSchema, doc });
	return state.apply(state.tr.insertText('EDITED', textPos, textPos + 4)).doc;
}

describe('optional LaTeX captions and caption placement', () => {
	it.each(['above', 'below', 'none'] as const)(
		'preserves untouched %s float bytes and edits a real cell without dropping metadata',
		(placement) => {
			const original = source(placement);
			const parsed = parseLatexFile(original);
			parsed.doc.check();
			expect(serializeLatexFile(parsed, parsed.doc)).toBe(original);
			const wrapper = firstWrapper(parsed.doc).node;
			const captionNode = wrapper.firstChild?.type.name === 'table_caption' ? wrapper.firstChild : null;
			expect(Boolean(captionNode)).toBe(placement !== 'none');
			if (captionNode) {
				expect(captionNode.attrs.captionOpt).toBe(String.raw`Short \emph{entry}`);
				expect(wrapper.attrs.captionPlacement).toBe(placement);
			}
			const editedDoc = editCell(parsed.doc);
			editedDoc.check();
			const output = serializeLatexFile(parsed, editedDoc);
			expect(output).toContain('EDITED & B');
			expect(output).not.toContain('CELL');
			expect(output.startsWith(parsed.preamble)).toBe(true);
			expect(output).toContain('\\begin{table*}[t]');
			expect(output).toContain(setup);
			expect(output).toContain('\\begin{tabular}{|l|c|}');
			expect(output).toContain('\\label{tab:extra}');
			expect(output).toContain('\\label{tab:main}');
			if (placement === 'none') expect(output).not.toContain('\\caption');
			else {
				expect(output).toContain(caption);
				expect(output.indexOf(caption) < output.indexOf('\\begin{tabular}')).toBe(placement === 'above');
				expect(output.indexOf('\\label{tab:main}')).toBeGreaterThan(output.indexOf(caption));
			}
			const reopened = parseLatexFile(output);
			reopened.doc.check();
			expect(serializeLatexFile(reopened, reopened.doc)).toBe(output);
		}
	);

	it('switches placement through a real transaction, with caption and labels following the table', () => {
		const parsed = parseLatexFile(source('above'));
		const { node, pos } = firstWrapper(parsed.doc);
		const state = EditorState.create({ schema, doc: parsed.doc });
		const updated = state.apply(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, captionPlacement: 'below' })).doc;
		const output = serializeLatexFile(parsed, updated);
		expect(output.indexOf(caption)).toBeGreaterThan(output.indexOf('\\end{tabular}'));
		expect(firstWrapper(parseLatexFile(output).doc).node.attrs.captionPlacement).toBe('below');
	});

	it('removing a nonempty caption persists absence without synthesizing numbering', () => {
		const parsed = parseLatexFile(source('above'));
		const { node, pos } = firstWrapper(parsed.doc);
		const state = EditorState.create({ schema, doc: parsed.doc });
		const updated = state.apply(state.tr.delete(pos + 1, pos + 1 + node.firstChild!.nodeSize)).doc;
		updated.check();
		const output = serializeLatexFile(parsed, updated);
		expect(output).not.toContain('\\caption');
		expect(output).not.toContain('\\refstepcounter');
		expect(output).toContain('\\label{tab:main}');
		expect(firstWrapper(parseLatexFile(output).doc).node.firstChild!.type.name).toBe('table');
	});

	it('adds a caption to a captionless float through a schema-valid transaction', () => {
		const parsed = parseLatexFile(source('none'));
		const { pos } = firstWrapper(parsed.doc);
		const state = EditorState.create({ schema, doc: parsed.doc });
		const newCaption = schema.nodes.table_caption.createChecked({ captionOpt: '' }, schema.text('Added caption'));
		const updated = state.apply(state.tr.insert(pos + 1, newCaption)).doc;
		updated.check();
		const output = serializeLatexFile(parsed, updated);
		expect(output).toContain('\\caption[]{Added caption}');
		expect(output.indexOf('\\caption[]')).toBeLessThan(output.indexOf('\\begin{tabular}'));
		const reopened = firstWrapper(parseLatexFile(output).doc).node;
		expect(reopened.firstChild!.attrs.captionOpt).toBe('');
		expect(reopened.attrs.captionPlacement).toBe('above');
	});

	it.each([`${caption}${caption}\n${tabular}`, `${caption}\n${tabular}\n${tabular}`, `${String.raw`\caption*{Unnumbered}`}\n${tabular}`])(
		'keeps unmodellable floats raw instead of dropping bodies or caption semantics',
		(body) => {
			const original = `\\begin{table}\n${body}\n\\end{table}`;
			const parsed = parseLatexFile(original);
			expect(parsed.doc.firstChild!.type.name).toBe('raw_latex');
			expect(parsed.doc.firstChild!.textContent).toBe(original);
			expect(serializeLatexFile(parsed, parsed.doc)).toBe(original);
		}
	);

	it('leaves nested contextual tables on the existing environment path', () => {
		const original = `\\begin{table}\n\\begin{center}\n${tabular}\n\\end{center}\n\\end{table}`;
		const parsed = parseLatexFile(original);
		expect(parsed.doc.firstChild!.type.name).toBe('environment');
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(original);
	});

	it('retains Typst required-caption schema and genuine figure regeneration without TeX-only attrs', () => {
		const original = '#figure(table(columns: 2, [CELL], [B]), caption: [Caption])';
		const parsed = parseTypstFile(original);
		parsed.doc.check();
		expect(serializeTypstFile(parsed, parsed.doc)).toBe(original);
		const wrapper = firstWrapper(parsed.doc).node;
		expect(wrapper.attrs).not.toHaveProperty('captionPlacement');
		expect(wrapper.firstChild!.attrs).not.toHaveProperty('captionOpt');
		expect(typSchema.nodes.table_wrapper.spec.content).toBe('table_caption table table_notes?');
		const output = serializeTypstFile(parsed, editCell(parsed.doc, typSchema));
		expect(output).toContain('[EDITED]');
		expect(output).toContain('caption: [Caption]');
		expect(output).not.toContain('\\caption');
		parseTypstFile(output).doc.check();
	});
});
