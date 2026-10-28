import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '../../src/features/document-core/core.ts';
import { BILINGUAL_PREAMBLE, planBilingualPatches } from '../../src/features/compile/document-language.ts';
import { createSourceState, historyTransaction, sourcePatchTransaction, sourceState } from '../../src/features/source-editor/state.ts';

for (const eol of ['\n', '\r\n']) {
	test(`enabling bilingual typesetting retains document bytes and shares undo (${JSON.stringify(eol)})`, () => {
		const text = ['% \\usepackage{ctex} is a comment', '\\documentclass{article}', '\\title{我葳 English}', '\\begin{document}', 'English 中文我葳', '\\end{document}'].join(eol);
		const source = SourceDocument.open(new TextEncoder().encode('\ufeff' + text));
		const state = createSourceState(source);
		const patches = planBilingualPatches(source);
		assert.equal(patches.length, 1);
		const next = sourcePatchTransaction(state, source, patches).state;
		const updated = next.field(sourceState).projection.document;
		assert.equal(updated.read(), text.replace('\\begin{document}', BILINGUAL_PREAMBLE + eol + '\\begin{document}'));
		assert.deepEqual(planBilingualPatches(updated), []);
		assert.deepEqual(historyTransaction(next, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
	});
}

for (const preamble of ['\\usepackage{ctex}', '\\RequirePackage[fontset=none]{ctex}', '\\usepackage{fontspec,xeCJK}\n\\setCJKmainfont{Custom}', '\\documentclass{ctexart}', '\\usepackage{CJKutf8}']) {
	test(`existing Chinese setup is preserved: ${preamble}`, () => {
		const source = SourceDocument.open(new TextEncoder().encode(preamble + '\n\\begin{document}我葳 English\\end{document}'));
		assert.deepEqual(planBilingualPatches(source), []);
	});
}

test('unsupported and incomplete preambles cannot be partially migrated', () => {
	for (const text of ['plain text', '\\usepackage{\\custom}\n\\begin{document}Body\\end{document}', '\\begin{document}A\\end{document}\\begin{document}B\\end{document}']) {
		const source = SourceDocument.open(new TextEncoder().encode(text));
		assert.throws(() => planBilingualPatches(source), /LANGUAGE_UNSUPPORTED/);
	}
});
