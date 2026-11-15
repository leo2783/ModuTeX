import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_WRAPPING_PREAMBLE } from '../../src/features/code/latex.ts';
import { codeAt, codeSource } from '../../src/features/code/source.ts';
import { mergePreparationPatches, planCodeWrappingPatches, withCodePreamble } from '../../src/features/code/wrapping.ts';
import { planDefaultBilingualPatches } from '../../src/features/compile/document-language.ts';
import { parseSource, SourceDocument } from '../../src/features/document-core/core.ts';
import { createSourceState, historyTransaction, insertionTarget, insertionTransaction, sourcePatchTransaction, sourceState } from '../../src/features/source-editor/state.ts';

for (const eol of ['\n', '\r\n', '\r']) {
	test(`managed legacy code preparation keeps literal bodies and undo bytes (${JSON.stringify(eol)})`, () => {
		const code = '  identifier'.repeat(100) + eol + '\t  % # & { } \\literal';
		const text = ['\\documentclass{article}', '% preserve', '\\begin{document}', '中文 before.', '\\begin{verbatim*}', code, '\\end{verbatim*}', '\\begin{lstlisting}[language=Python,name=python]', 'print("legacy")', '\\end{lstlisting}', 'Following ordinary text.', '\\end{document}', ''].join(eol);
		const source = SourceDocument.open(new TextEncoder().encode('\ufeff' + text));
		const patches = mergePreparationPatches(planDefaultBilingualPatches(source), planCodeWrappingPatches(source));
		const state = createSourceState(source);
		const next = sourcePatchTransaction(state, source, patches).state;
		const updated = next.field(sourceState).projection.document;
		assert.ok(updated.read().includes(eol + code + eol), 'literal code bytes and line endings stay intact');
		assert.ok(updated.read().includes(CODE_WRAPPING_PREAMBLE.replaceAll('\n', eol)));
		assert.equal(updated.read().match(/\\usepackage\{listings\}/g)?.length, 1);
		assert.match(updated.read(), /\\usepackage\[UTF8,scheme=plain,fontset=fandol\]\{ctex\}/);
		assert.equal(updated.profile.bom, true);
		assert.deepEqual(planCodeWrappingPatches(updated), [], 'code preparation is idempotent');
		assert.deepEqual(planDefaultBilingualPatches(updated), []);
		const located = codeAt(updated, parseSource(updated), updated.read().indexOf('\\begin{lstlisting}'))!;
		assert.equal(located.starred, true);
		assert.equal(located.draft.code, code.replace(/\r\n|\r/g, '\n'));
		assert.ok(updated.read().endsWith('Following ordinary text.' + eol + '\\end{document}' + eol));
		assert.deepEqual(historyTransaction(next, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
	});
}

test('inserting generated plain text publishes code, package and bounded-token helper in one undo', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n'));
	let state = createSourceState(source);
	state = state.update({ selection: { anchor: state.doc.toString().indexOf('\\end{document}') } }).state;
	const inserted = insertionTransaction(state, insertionTarget(state), codeSource('identifier'.repeat(1000)));
	const next = withCodePreamble(state, inserted).state;
	const updated = next.field(sourceState).projection.document;
	assert.ok(updated.read().includes(CODE_WRAPPING_PREAMBLE));
	assert.equal(updated.read().match(/\\usepackage\{listings\}/g)?.length, 1);
	assert.deepEqual(planCodeWrappingPatches(updated), []);
	assert.deepEqual(historyTransaction(next, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
});

test('custom options, opaque containers, unsafe environment delimiters and incomplete documents stay unchanged', () => {
	for (const body of [
		'\\begin{lstlisting}[language=Python,breaklines=false]\nvalue\n\\end{lstlisting}',
		'\\begin{minipage}{5cm}\n\\begin{verbatim}\nvalue\n\\end{verbatim}\n\\end{minipage}',
		'\\begin{table}\n\\begin{verbatim}\nvalue\n\\end{verbatim}\n\\end{table}',
		'\\begin{verbatim}\n\\end{lstlisting}\n\\end{verbatim}',
		'\\begin{verbatim}\nvalue'
	]) {
		const source = SourceDocument.open(new TextEncoder().encode('\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n'));
		assert.deepEqual(planCodeWrappingPatches(source), [], body);
	}
});

test('an existing user macro is never overwritten and preparations reject overlapping source edits', () => {
	const text = '\\documentclass{article}\n\\newcommand{\\ModuTeXCodeWrap}{custom}\n\\begin{document}\n\\begin{verbatim}\ncode\n\\end{verbatim}\n\\end{document}';
	assert.deepEqual(planCodeWrappingPatches(SourceDocument.open(new TextEncoder().encode(text))), []);
	assert.throws(() => mergePreparationPatches([{ from: 2, to: 5, insert: '' }], [{ from: 4, to: 6, insert: '' }]), /OVERLAP/);
});
