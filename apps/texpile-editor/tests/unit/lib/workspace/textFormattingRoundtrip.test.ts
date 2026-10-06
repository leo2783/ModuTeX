import { describe, expect, it } from 'vitest';
import { Fragment } from 'prosemirror-model';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';
import { FONT_SIZES, ALIGNMENT_DECLARATIONS } from '$lib/schema/text-formatting';
import { schema } from '$lib/schema/schema';
import { serializeNode } from '$lib/serializer/latexSerializer';

const file = (body: string) =>
	'\uFEFF\\documentclass{article}\r\n\\newcommand{\\foreign}{Kept}\r\n\\begin{document}\r\n' + body + '\r\n\\end{document}\r\n';
describe('finite text formatting round-trip', () => {
	for (const size of FONT_SIZES)
		it(`models ${size} without losing original bytes`, () => {
			const source = file(`Before {\\${size} Sized} after.`);
			const parsed = parseLatexFile(source);
			parsed.doc.check();
			expect(parsed.doc.textContent).toBe('Before Sized after.');
			const marked = parsed.doc.firstChild!.child(1);
			expect(marked.marks.find((mark) => mark.type.name === 'font_size')?.attrs.size).toBe(size);
			expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
			const regenerated = parsed.doc.firstChild!.type.create(
				{ ...parsed.doc.firstChild!.attrs, orig: null },
				parsed.doc.firstChild!.content
			);
			const serialized = serializeNode(regenerated, { parent: parsed.doc, index: 0, isLastChild: true, inTableCell: false });
			expect(serialized).toContain(`{\\${size} Sized}`);
			expect(
				parseLatexFile(file(serialized))
					.doc.firstChild!.child(1)
					.marks.find((mark) => mark.type.name === 'font_size')?.attrs.size
			).toBe(size);
		});
	for (const [alignment, declaration] of Object.entries(ALIGNMENT_DECLARATIONS))
		it(`models scoped ${alignment} and keeps par inside the scope`, () => {
			const source = file(`{\\${declaration} Aligned text \\par}\r\n\r\nUntouched   neighbour.`);
			const parsed = parseLatexFile(source);
			expect(parsed.doc.child(0).attrs.alignment).toBe(alignment);
			expect(parsed.doc.child(1).attrs.alignment).toBe('auto');
			expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
			const edited = parsed.doc.child(0).type.create({ ...parsed.doc.child(0).attrs }, schema.text('Changed text'));
			const doc = parsed.doc.copy(Fragment.fromArray([edited, parsed.doc.child(1)]));
			const output = serializeLatexFile(parsed, doc);
			expect(output).toContain(`{\\${declaration} Changed text \\par}`);
			expect(output).toContain('Untouched   neighbour.');
			expect(parseLatexFile(output).doc.child(0).attrs.alignment).toBe(alignment);
			expect(parseLatexFile(output).doc.child(1).attrs.alignment).toBe('auto');
		});
	for (const body of [
		'{\\large A\n\nB}',
		'{\\large \\foreign}',
		'{\\large \\small A}',
		'{\\centering A}',
		'{\\centering A\\par B\\par}',
		'{\\centering \\foreign \\par}',
		'{\\raggedright $x$ \\par}',
		'{\\small A% keep comment\nB}',
		'{\\large \\textcolor{\\foreign}{A}}',
		'{\\centering \\href{\\foreign}{A} \\par}',
		'{\\large \\^{A}}',
		'{\\large {\\sethlcolor{red}\\hl{\\foreign}}}',
		'{\\centering {\\sethlcolor{red}\\hl{A%keep\nB}} \\par}',
		'{\\large {\\sethlcolor{red}\\hl{A\n\nB}}}',
		'{\\centering A\\indent B\\par}',
		'\\begin{center}A\n\nB\\end{center}'
	])
		it(`preserves unsupported scope ${body}`, () => {
			const source = file(body);
			const parsed = parseLatexFile(source);
			expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
			expect(parsed.doc.firstChild?.attrs.alignment ?? 'auto').toBe('auto');
			let sizeMarks = 0;
			parsed.doc.descendants((node) => {
				sizeMarks += node.marks.filter((mark) => mark.type.name === 'font_size').length;
			});
			expect(sizeMarks).toBe(0);
			if (body.startsWith('{')) {
				const paragraph = parsed.doc.firstChild!;
				const regenerated = paragraph.type.create({ ...paragraph.attrs, orig: null }, paragraph.content);
				expect(serializeNode(regenerated, { parent: parsed.doc, index: 0, isLastChild: true, inTableCell: false })).toContain(body);
			}
		});
	it('bounds oversized groups and does not turn an unsafe declaration into generated TeX', () => {
		const source = file('{\\large ' + 'x'.repeat(65537) + '}');
		const parsed = parseLatexFile(source);
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
		expect(() =>
			serializeNode(schema.text('x', [schema.marks.font_size.create({ size: 'evil}\\input{private}' })]), {
				parent: parsed.doc,
				index: 0,
				isLastChild: true,
				inTableCell: false
			})
		).toThrow('Invalid font size');
	});
	it('supports nested size groups and strong text without leaking the outer size', () => {
		const parsed = parseLatexFile(file('{\\small A {\\Large B} \\textbf{C}} D'));
		const content = parsed.doc.firstChild!;
		expect(content.textContent).toBe('A B C D');
		const b = [...Array(content.childCount)].map((_, i) => content.child(i)).find((node) => node.text === 'B')!;
		expect(b.marks.find((mark) => mark.type.name === 'font_size')?.attrs.size).toBe('Large');
		expect(content.lastChild!.marks.find((mark) => mark.type.name === 'font_size')).toBeUndefined();
	});
	it('reopens generated alignment and size together without moving par out of scope', () => {
		const paragraph = schema.nodes.paragraph.create(
			{ alignment: 'right' },
			schema.text('Formatted', [schema.marks.font_size.create({ size: 'Large' })])
		);
		const doc = schema.nodes.doc.create(null, paragraph);
		const generated = serializeNode(paragraph, { parent: doc, index: 0, isLastChild: true, inTableCell: false });
		expect(generated).toContain('{\\raggedleft {\\Large Formatted} \\par}');
		const reopened = parseLatexFile(file(generated));
		expect(reopened.doc.firstChild!.attrs.alignment).toBe('right');
		expect(reopened.doc.firstChild!.firstChild!.marks[0].attrs.size).toBe('Large');
	});
});
