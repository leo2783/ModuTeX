import { describe, it, expect } from 'vitest';
import { mdSchema } from '$lib/markdown/schema';
import { schema as texSchema } from '$lib/schema/schema';
import { markdownToProseMirror } from '$lib/markdown/converter';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';

describe('mdSchema separation', () => {
	it('excludes every LaTeX-only node and mark', () => {
		for (const n of ['citation', 'ref', 'environment', 'abstract', 'includedoc', 'table_wrapper', 'table_caption', 'table_notes']) {
			expect(mdSchema.nodes[n]).toBeUndefined();
		}
		for (const m of ['u', 'sup', 'sub', 'textcolor', 'highlight']) {
			expect(mdSchema.marks[m]).toBeUndefined();
		}
	});

	it('keeps the shared shapes', () => {
		for (const n of ['heading', 'list', 'table', 'code_block', 'raw_latex', 'inline_latex', 'block_math', 'inline_math', 'image']) {
			expect(mdSchema.nodes[n]).toBeDefined();
		}
		for (const m of ['link', 'em', 'strong', 'code', 's']) {
			expect(mdSchema.marks[m]).toBeDefined();
		}
		// the orig verbatim layer's attrs survive the trim
		expect(mdSchema.nodes.paragraph.spec.attrs).toHaveProperty('orig');
		expect(mdSchema.nodes.doc.spec.attrs).toHaveProperty('docTail');
	});

	// the insert paths (drop/paste/toolbar) create images on the schema default, so this default
	// is what stops a fresh markdown image rendering a "Figure N:" prefix and offering the
	// LaTeX reference-label field — neither of which `![alt](src "title")` can carry
	it('images default to unnumbered, unlike the tex schema', () => {
		expect(mdSchema.nodes.image.create({ src: 'a.png' }).attrs.numbered).toBe(false);
		expect(texSchema.nodes.image.create({ src: 'a.png' }).attrs.numbered).toBe(true);
		// still a block figure with a caption, which markdown DOES have (the title slot)
		expect(mdSchema.nodes.image.create({ src: 'a.png' }).attrs.showCaption).toBe(true);
	});

	it('each importer builds docs in its OWN schema object', () => {
		const md = markdownToProseMirror('# Title\n\n- a\n').doc;
		expect(md.type.schema).toBe(mdSchema);
		expect(md.type.schema).not.toBe(texSchema);
		const tex = parseLatexFile('\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n').doc;
		expect(tex.type.schema).toBe(texSchema);
	});
});
