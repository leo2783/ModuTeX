import { describe, expect, it, vi } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '$lib/schema/schema';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';
import { addLatexPackage, hasLatexPackage } from '$lib/workspace/packagePatch';
import { get } from 'svelte/store';
import { isDirty } from '$lib/workspace/workspaceStore';

function makeBuffer() {
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const clearPendingAnchor = vi.fn();
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor
	};
	return { doc: new DocumentBuffer(deps), scheduled, clearPendingAnchor };
}

function replaceChild(doc: PMNode, index: number, node: PMNode): PMNode {
	const children: PMNode[] = [];
	for (let i = 0; i < doc.childCount; i++) children.push(i === index ? node : doc.child(i));
	return doc.copy(Fragment.fromArray(children));
}

describe('LaTeX package patch', () => {
	it('recognizes active individual, comma-list, option-bearing and RequirePackage declarations', () => {
		const source = `\\documentclass{article}
\\usepackage[dvipsnames]{xcolor, graphicx}
\\RequirePackage { amsmath }
\\begin{document}
\\end{document}
`;
		expect(hasLatexPackage(source, 'graphicx')).toBe(true);
		expect(hasLatexPackage(source, 'amsmath')).toBe(true);
		expect(addLatexPackage(source, 'graphicx')).toEqual({ kind: 'already-present', packageName: 'graphicx', result: source });
	});

	it('ignores commented declarations and performs exactly one insertion after the last active package line', () => {
		const source = `\\documentclass{article}
% \\usepackage{graphicx}
\\usepackage[utf8]{inputenc} % keep this comment
\\usepackage{xcolor,booktabs}

\\begin{document}
Body
\\end{document}
`;
		const patch = addLatexPackage(source, 'graphicx');
		expect(patch.kind).toBe('insert');
		if (patch.kind !== 'insert') throw new Error('expected insertion');
		expect(patch.text).toBe('\\usepackage{graphicx}\n');
		expect(patch.result.slice(0, patch.offset)).toBe(source.slice(0, patch.offset));
		expect(patch.result.slice(patch.offset + patch.text.length)).toBe(source.slice(patch.offset));
		expect(patch.result.length - source.length).toBe(patch.text.length);
	});

	it('inserts before document start when no package exists and preserves CRLF, BOM and surrounding bytes', () => {
		const source = '\uFEFF\\documentclass{article}\r\n% package section\r\n\\begin{document}\r\n\\end{document}\r\n';
		const patch = addLatexPackage(source, 'amsmath');
		expect(patch.kind).toBe('insert');
		if (patch.kind !== 'insert') throw new Error('expected insertion');
		expect(patch.result).toBe(
			'\uFEFF\\documentclass{article}\r\n% package section\r\n\\usepackage{amsmath}\r\n\\begin{document}\r\n\\end{document}\r\n'
		);
		expect(patch.result.charCodeAt(0)).toBe(0xfeff);
		expect(patch.result.replaceAll('\r\n', '')).not.toContain('\n');
		expect(patch.result.slice(0, patch.offset)).toBe(source.slice(0, patch.offset));
		expect(patch.result.slice(patch.offset + patch.text.length)).toBe(source.slice(patch.offset));
	});

	it('does not treat an escaped percent as a comment and ignores packages after document start', () => {
		const source = `\\documentclass{article}
\\newcommand{\\rate}{100\\%} \\usepackage{graphicx}
\\begin{document}
\\usepackage{body-only}
\\end{document}
`;
		expect(hasLatexPackage(source, 'graphicx')).toBe(true);
		expect(hasLatexPackage(source, 'body-only')).toBe(false);
	});

	it('does not mistake a doubled backslash for an active package or document command', () => {
		const source = '\\\\usepackage{graphicx}\n\\\\begin{document}\n';
		expect(hasLatexPackage(source, 'graphicx')).toBe(false);
		expect(() => addLatexPackage(source, 'amsmath')).toThrow('Cannot insert a package');
	});

	it('rejects package-token injection and a fragment without an active document preamble', () => {
		expect(() => addLatexPackage('\\begin{document}\n\\end{document}\n', 'x}\\input{secret')).toThrow('Invalid LaTeX package name');
		expect(() => addLatexPackage('fragment only', 'amsmath')).toThrow('Cannot insert a package');
	});

	it.each([
		'\\newcommand{\\later}{\\usepackage{amsmath}\\begin{document}}',
		'\\newcommand\\later[1][default]{\\usepackage{amsmath} #1}',
		'\\def\\later#1{\\usepackage{amsmath}\\begin{document} #1}',
		'\\gdef\\later{\\usepackage{amsmath}}'
	])('does not execute a deferred macro definition or count its false declarations: %s', (definition) => {
		const source = `\\documentclass{article}\n${definition}\n\\begin{document}\nBody\\unknown{raw}\n\\end{document}\n`;
		expect(hasLatexPackage(source, 'amsmath')).toBe(false);
		const patch = addLatexPackage(source, 'amsmath');
		expect(patch.kind).toBe('insert');
		if (patch.kind !== 'insert') throw new Error('expected insertion');
		expect(patch.offset).toBe(source.lastIndexOf('\\begin{document}'));
		expect(patch.result.slice(0, patch.offset)).toBe(source.slice(0, patch.offset));
		expect(patch.result.slice(patch.offset + patch.text.length)).toBe(source.slice(patch.offset));
		expect(patch.result).toContain(definition);
	});

	it.each([
		'\\iffalse\n\\usepackage{amsmath}\n\\begin{document}\n\\fi',
		'\\ifcustom\n\\usepackage{amsmath}\n\\fi',
		'\\ifdefined\\foo\n\\usepackage{amsmath}\n\\fi',
		'\\newif\\ifcustom\n\\usepackage{amsmath}',
		'\\else\n\\usepackage{amsmath}\n\\fi',
		'\\newcommand{\\later}{\\usepackage{amsmath}}\n\\later',
		'\\def\\later{\\usepackage{amsmath}}\n\\later',
		'\\edef\\later{\\usepackage{amsmath}}',
		'\\newcommand{\\begin}{document}',
		'\\def\\document{\\usepackage{amsmath}}',
		'\\renewcommand{\\enddocument}{}',
		'\\def\\usepackage#1{}',
		'\\let\\begin\\other',
		'\\catcode`\\%=12',
		'\\input{foreign}',
		'\\csname usepackage\\endcsname{amsmath}',
		'{\\usepackage{amsmath}\\begin{document}}',
		'\\\\usepackage{amsmath}\n\\\\begin{document}',
		'\\usepackageExtra{amsmath}',
		'\\usepackage@hidden{amsmath}',
		'\\usepackage[\\unknown]{amsmath}',
		'\\usepackage{\\dynamic}',
		'\\newcommand{\\later}{unbalanced',
		'\\def\\later\\begin{document}'
	])('rejects automatic insertion/evidence for unrecognized or unsafe preamble: %s', (preamble) => {
		const source = `\\documentclass{article}\n${preamble}\n\\begin{document}\nBody\n\\end{document}\n`;
		expect(hasLatexPackage(source, 'amsmath')).toBe(false);
		expect(() => addLatexPackage(source, 'amsmath')).toThrow('Cannot insert a package');
	});

	it('does not insert after a package line that enters an unknown conditional on the same line', () => {
		const source = '\\documentclass{article}\n\\usepackage{xcolor}\\iffalse\nignored\n\\fi\n\\begin{document}\nBody\n\\end{document}\n';
		expect(() => addLatexPackage(source, 'amsmath')).toThrow('unsafe LaTeX preamble');
	});

	it('falls back to the certified document boundary instead of splitting a same-line macro definition', () => {
		const definition = '\\newcommand{\\later}{line one\n\\usepackage{hidden}\nline three}';
		const source = `\\documentclass{article}\n\\usepackage{xcolor} ${definition}\n\\begin{document}\nBody\n\\end{document}\n`;
		const patch = addLatexPackage(source, 'amsmath');
		expect(patch.kind).toBe('insert');
		if (patch.kind !== 'insert') throw new Error('expected insertion');
		expect(patch.offset).toBe(source.indexOf('\\begin{document}'));
		expect(patch.result).toContain(definition);
		expect(hasLatexPackage(source, 'hidden')).toBe(false);
	});
});

describe('production DocumentBuffer package choices', () => {
	const source = `\\documentclass{article}
% \\usepackage{graphicx}
\\usepackage{booktabs} % preserve
\\begin{document}
Body
\\end{document}
`;

	it('add-and-insert patches the preamble and authorizes insertion', () => {
		const { doc, scheduled, clearPendingAnchor } = makeBuffer();
		isDirty.set(false);
		doc.openTex('/ws/main.tex', source, '\n');
		doc.adoptParsed(parseLatexFile(source));

		expect(doc.resolvePackageInsertion('graphicx', 'add-and-insert')).toBe('insert');
		expect(doc.texSource).toBe(
			source.replace('\\usepackage{booktabs} % preserve\n', '\\usepackage{booktabs} % preserve\n\\usepackage{graphicx}\n')
		);
		expect(scheduled).toEqual([{ path: '/ws/main.tex', content: doc.texSource }]);
		expect(clearPendingAnchor).toHaveBeenCalledOnce();
		expect(get(isDirty)).toBe(true);

		// A later visual save uses the patched production metadata and cannot erase the package.
		doc.onVisualChange(doc.visualDoc!);
		expect(doc.texSource).toContain('\\usepackage{graphicx}\n\\begin{document}');
	});

	it('insert-without-package authorizes insertion without mutating source', () => {
		const { doc, scheduled, clearPendingAnchor } = makeBuffer();
		doc.openTex('/ws/main.tex', source, '\n');
		doc.adoptParsed(parseLatexFile(source));

		expect(doc.resolvePackageInsertion('graphicx', 'insert-without-package')).toBe('insert');
		expect(doc.texSource).toBe(source);
		expect(scheduled).toEqual([]);
		expect(clearPendingAnchor).not.toHaveBeenCalled();
	});

	it('cancel denies insertion and leaves every production buffer unchanged', () => {
		const { doc, scheduled, clearPendingAnchor } = makeBuffer();
		doc.openTex('/ws/main.tex', source, '\n');
		doc.adoptParsed(parseLatexFile(source));
		const beforeMeta = doc.docMeta;
		const beforeVisual = doc.visualDoc;

		expect(doc.resolvePackageInsertion('graphicx', 'cancel')).toBe('cancel');
		expect(doc.texSource).toBe(source);
		expect(doc.docMeta).toBe(beforeMeta);
		expect(doc.visualDoc).toBe(beforeVisual);
		expect(scheduled).toEqual([]);
		expect(clearPendingAnchor).not.toHaveBeenCalled();
	});

	it('does not duplicate an active package when add-and-insert is chosen', () => {
		const active = source.replace('% \\usepackage{graphicx}', '\\usepackage[draft]{graphicx}');
		const { doc, scheduled } = makeBuffer();
		doc.openTex('/ws/main.tex', active, '\n');
		doc.adoptParsed(parseLatexFile(active));

		expect(doc.resolvePackageInsertion('graphicx', 'add-and-insert')).toBe('insert');
		expect(doc.texSource).toBe(active);
		expect(scheduled).toEqual([]);
	});

	it('refuses a stale preamble patch instead of racing a newer source edit', () => {
		const { doc, scheduled } = makeBuffer();
		doc.openTex('/ws/main.tex', source, '\n');
		doc.adoptParsed(parseLatexFile(source));
		const newer = source.replace('\\documentclass{article}', '\\documentclass[12pt]{article}');
		doc.onTexInput(newer);

		expect(() => doc.resolvePackageInsertion('graphicx', 'add-and-insert')).toThrow('source changed');
		expect(doc.texSource).toBe(newer);
		expect(scheduled).toEqual([{ path: '/ws/main.tex', content: newer }]);
	});

	it.each(['graphicx', 'amsmath'])('preserves foreign macro bytes on add failure and explicit without/cancel: %s', (packageName) => {
		const unsafe = `\\documentclass{article}\n\\newcommand{\\later}{\\usepackage{${packageName}}}\n\\ifunknown\\later\\fi\n\\begin{document}\nBody\\placeholder[foreign]{keep}\n\\end{document}\n`;
		const { doc, scheduled } = makeBuffer();
		doc.openTex('/ws/main.tex', unsafe, '\n');
		doc.adoptParsed(parseLatexFile(unsafe));
		expect(() => doc.resolvePackageInsertion(packageName, 'add-and-insert')).toThrow();
		expect(doc.texSource).toBe(unsafe);
		expect(scheduled).toEqual([]);
		expect(doc.resolvePackageInsertion(packageName, 'insert-without-package')).toBe('insert');
		expect(doc.resolvePackageInsertion(packageName, 'cancel')).toBe('cancel');
		expect(doc.texSource).toBe(unsafe);
		expect(scheduled).toEqual([]);
	});
});

describe('production DocumentBuffer source-range serialization', () => {
	it('a one-block edit preserves exact bytes before and after that original source range', () => {
		const source = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
First paragraph wrapped
with   unusual spacing.

Target paragraph before edit.

% keep this exact comment
Final paragraph with \\unknown{raw}.
\\end{document}
`;
		const parsed = parseLatexFile(source);
		let index = -1;
		for (let i = 0; i < parsed.doc.childCount; i++) {
			if (parsed.doc.child(i).textContent.includes('Target paragraph')) index = i;
		}
		expect(index).toBeGreaterThan(-1);
		const target = parsed.doc.child(index);
		const orig = target.attrs.orig as { start: number; latex: string };
		const edited = target.type.create(target.attrs, schema.text('Edited target only.'));
		const editedDoc = replaceChild(parsed.doc, index, edited);

		const { doc, scheduled } = makeBuffer();
		doc.openTex('/ws/main.tex', source, '\n');
		doc.adoptParsed(parsed);
		doc.onVisualChange(editedDoc);
		expect(scheduled).toHaveLength(1);

		const rangeStart = parsed.preamble.length + orig.start;
		const rangeEnd = rangeStart + orig.latex.length;
		expect(doc.texSource.slice(0, rangeStart)).toBe(source.slice(0, rangeStart));
		expect(doc.texSource.slice(doc.texSource.length - (source.length - rangeEnd))).toBe(source.slice(rangeEnd));
		expect(doc.texSource.slice(rangeStart, doc.texSource.length - (source.length - rangeEnd))).toContain('Edited target only.');
	});
});
