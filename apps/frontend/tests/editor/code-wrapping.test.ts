import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeAt, codeEditTransaction, codeSource, parseCodeContent } from '../../src/features/code/source.ts';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { createSourceState, historyTransaction, sourceState } from '../../src/features/source-editor/state.ts';
import { withCodePreamble } from '../../src/features/code/wrapping.ts';

function document(code: string) {
	return SourceDocument.open(new TextEncoder().encode('\\documentclass{article}\n\\begin{document}\n' + code + '\n\nFollowing ordinary text.\n\\end{document}\n'));
}

test('long tokens, whitespace and multiple pages of code survive generated source and parser round trips', () => {
	for (const language of ['text', 'python', 'javascript']) {
		for (const code of ['identifier'.repeat(1000), 'print("long line") '.repeat(1000), Array.from({ length: 180 }, (_, i) => `line_${i} = "literal % # & { } \\text"`).join('\n')]) {
			const source = document(codeSource(code, false, language));
			const located = codeAt(source, parseSource(source), source.read().indexOf('\\begin{lstlisting}'));
			assert.ok(located, language);
			assert.deepEqual(located.draft, { code, language });
			assert.equal(codeEditTransaction(createSourceState(source), located, located.draft), null);
			assert.ok(source.read().endsWith('Following ordinary text.\n\\end{document}\n'));
		}
	}
});

test('editing legacy verbatim and verbatim* migrates only that code plus package in a single reversible edit', () => {
	for (const environment of ['verbatim', 'verbatim*']) {
		const bytes = new TextEncoder().encode('\ufeff\\documentclass{article}\r\n% preserve\r\n\\begin{document}\r\n\\begin{' + environment + '}\r\n  old text\r\n\\end{' + environment + '}\r\nFollowing ordinary text.\r\n\\end{document}\r\n');
		const source = SourceDocument.open(bytes);
		const state = createSourceState(source);
		const located = codeAt(source, parseSource(source), source.read().indexOf('\\begin{' + environment + '}'))!;
		assert.equal(codeEditTransaction(state, located, located.draft), null);
		const code = '  long_token'.repeat(100);
		const changed = withCodePreamble(state, codeEditTransaction(state, located, { code })!).state;
		const updated = changed.field(sourceState).projection.document;
		const reparsed = codeAt(updated, parseSource(updated), updated.read().indexOf('\\begin{lstlisting}'))!;
		assert.equal(reparsed.draft.code, code);
		assert.equal(reparsed.starred, environment === 'verbatim*');
		assert.match(updated.read(), /\\usepackage\{listings\}\r\n/);
		assert.match(updated.read(), /\\newcommand\{\\ModuTeXCodeWrap\}/);
		assert.match(updated.read(), /Following ordinary text\.\r\n\\end\{document\}\r\n$/);
		assert.equal(codeEditTransaction(changed, reparsed, reparsed.draft), null);
		assert.deepEqual(historyTransaction(changed, 'undo')!.state.field(sourceState).projection.document.toBytes(), bytes);
	}
});

test('unsupported or partially changed listing settings remain source backed', () => {
	const generated = codeSource('value', false, 'python').slice('\\begin{lstlisting}'.length, -'\\end{lstlisting}'.length);
	for (const options of [generated.replace('breaklines=true', 'breaklines=false'), generated.replace('keepspaces=true,', ''), generated.replace(']', ',float=true]'), generated.replace(']', ',showspaces=true]')]) {
		assert.equal(parseCodeContent(options, 'lstlisting'), null);
	}
});
