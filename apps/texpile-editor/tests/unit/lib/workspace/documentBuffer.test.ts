import { describe, expect, it, vi } from 'vitest';
import { DocumentBuffer } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';

vi.mock('$lib/typst/visual/roundtrip', () => ({ serializeTypstFile: () => '' }));

function makeBuffer() {
	const scheduleSave = vi.fn();
	const writeNow = vi.fn();
	const doc = new DocumentBuffer({
		scheduleSave,
		discardQueuedSave: vi.fn(),
		writeNow,
		rebuildVisual: vi.fn(),
		isVisualMode: () => false,
		clearPendingAnchor: vi.fn()
	});
	return { doc, scheduleSave, writeNow };
}

describe('DocumentBuffer local editing', () => {
	it('queues source edits directly for local autosave', () => {
		const { doc, scheduleSave } = makeBuffer();
		doc.openTex('/ws/main.tex', 'before', '\n');

		doc.onTexInput('after');

		expect(doc.texSource).toBe('after');
		expect(scheduleSave).toHaveBeenCalledOnce();
		expect(scheduleSave).toHaveBeenCalledWith('/ws/main.tex', 'after');
	});

	it('writes the current source directly on manual save', () => {
		const { doc, writeNow } = makeBuffer();
		doc.openTex('/ws/main.tex', 'before', '\n');
		doc.onTexInput('after');

		doc.save();

		expect(writeNow).toHaveBeenCalledWith('/ws/main.tex', 'after', false);
	});

	it('adds an absent title by splicing only the preamble and preserves the document body', () => {
		const { doc, scheduleSave } = makeBuffer();
		const source = '\\documentclass{article}\r\n% keep source bytes\r\n\\begin{document}\r\nBody.\r\n\\end{document}\r\n';
		doc.openTex('/ws/main.tex', source, '\r\n');
		doc.adoptParsed(parseLatexFile(source));

		expect(doc.addFrontmatter('title', '')).toBe(true);
		expect(doc.docMeta?.preamble).toContain('\\title{}\r\n');
		expect(doc.texSource).toContain('% keep source bytes\r\n\\title{}\r\n\\begin{document}\r\nBody.\r\n\\end{document}\r\n');
		expect(scheduleSave).toHaveBeenCalledOnce();
		expect(scheduleSave).toHaveBeenCalledWith('/ws/main.tex', doc.texSource);
	});

	it('refuses a duplicate title or a source-first buffer without changing the file', () => {
		const { doc, scheduleSave } = makeBuffer();
		const source = '\\documentclass{article}\n\\title{Existing}\n\\begin{document}\nBody.\n\\end{document}\n';
		doc.openTex('/ws/main.tex', source, '\n');
		doc.adoptParsed(parseLatexFile(source));
		expect(doc.addFrontmatter('title', 'New')).toBe(false);
		expect(doc.texSource).toBe(source);

		doc.openTex('/ws/main.tex', source, '\n');
		expect(doc.addFrontmatter('title', 'New')).toBe(false);
		expect(doc.texSource).toBe(source);
		expect(scheduleSave).not.toHaveBeenCalled();
	});
});
