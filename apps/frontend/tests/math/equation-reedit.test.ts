import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { equationAt, equationSource, equationReplacement } from '../../src/features/math/source.ts';
import { equationEditTransaction } from '../../src/features/math/editor.ts';
import { createSourceState, sourceState, rangeInsertionTarget, insertionTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
const bytes = (text: string) => new TextEncoder().encode(text);

for (const [opening, closing, inline] of [['$', '$', true], ['$$', '$$', false], ['\\(', '\\)', true], ['\\[', '\\]', false]] as const) {
	test(`closed ${opening} equation lookup uses genuine parser spans without changing source bytes`, () => {
		const body = '\\frac{1}{2}+雪^2';
		const text = '\uFEFF😀 prefix\r\n' + opening + body + closing + '\n\\opaque{untouched}\r';
		const source = SourceDocument.open(bytes(text)), parsed = parseSource(source);
		const from = source.read().indexOf(opening);
		for (const position of [from, from + opening.length + 2, from + opening.length + body.length]) {
			const found = equationAt(source, parsed, position);
			assert.ok(found);
			assert.equal(found.draft.inline, inline);
			assert.equal(found.draft.latex, body);
			assert.equal(source.read(found.span.from, found.span.to), opening + body + closing);
			assert.equal(source.read(found.content.from, found.content.to), body);
			for (const span of [found.span, found.content]) {
				assert.equal(span.documentId, source.documentId);
				assert.equal(span.version, source.version);
			}
		}
		assert.equal(equationAt(source, parsed, 0), null);
		assert.deepEqual(source.toBytes(), bytes(text));
	});
}

test('comments, literal bodies, escaped dollars and unsupported environments do not become editable equations', () => {
	for (const text of [
		'% $needle$\r\nbody', '\\verb|$needle$|', '\\verb*|\\(needle\\)|',
		'\\begin{verbatim}\n$needle$\n\\end{verbatim}',
		'\\begin{lstlisting}\n\\[needle\\]\n\\end{lstlisting}',
		'\\begin{minted}{tex}\n$needle$\n\\end{minted}',
		'\\$needle\\$', '\\opaque{$needle$}',
		'\\begin{unknown}\n$needle$\n\\end{unknown}',
		'\\begin{equation}needle\\end{equation}',
		'\\begin{align}needle\\end{align}',
		'$needle', '$$needle', '\\(needle', '\\[needle'
	]) {
		const source = SourceDocument.open(bytes(text));
		assert.equal(equationAt(source, parseSource(source), source.read().indexOf('needle')), null, text);
		assert.deepEqual(source.toBytes(), bytes(text));
	}
});

test('parser comments and escaped dollar signs inside closed math do not terminate lookup early', () => {
	const text = '\\begin{document}\r\n$x+\\$y% ignored $\r\n+z$\n\\end{document}';
	const source = SourceDocument.open(bytes(text));
	const found = equationAt(source, parseSource(source), source.read().indexOf('+z'));
	assert.ok(found);
	assert.equal(source.read(found.span.from, found.span.to), '$x+\\$y% ignored $\r\n+z$');
	assert.equal(source.read(found.content.from, found.content.to), 'x+\\$y% ignored $\r\n+z');
	assert.deepEqual(source.toBytes(), bytes(text));
});

test('old and foreign parser identities cannot grant equation editing authority', () => {
	const source = SourceDocument.open(bytes('prefix $x^2$ suffix'));
	const parsed = parseSource(source);
	const next = source.apply({ expectedVersion: source.version, patches: [{ from: 0, to: 0, insert: 'new ' }] }).document;
	assert.equal(equationAt(next, parsed, next.read().indexOf('x')), null);
	assert.equal(equationAt(SourceDocument.open(source.toBytes()), parsed, source.read().indexOf('x')), null);
	assert.deepEqual(source.toBytes(), bytes('prefix $x^2$ suffix'));
});

test('unchanged equation replacement preserves all original delimiters, whitespace and mixed EOL bytes', () => {
	for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
		const text = '\uFEFF😀 prefix\r\n' + open + ' \r\nx^2% keep\n +雪\r ' + close + '\nend\r';
		const source = SourceDocument.open(bytes(text));
		const located = equationAt(source, parseSource(source), source.read().indexOf('x^2'));
		assert.ok(located);
		const replacement = equationReplacement(source, located, { ...located.draft });
		assert.equal(replacement, source.read(located.span.from, located.span.to));
		assert.deepEqual(source.toBytes(), bytes(text));
		assert.equal(equationReplacement(source, located, { ...located.draft, latex: 'y^3' }).startsWith(open!), true);
		assert.equal(equationReplacement(source, located, { ...located.draft, latex: 'y^3' }).endsWith(close!), true);
		const switched = equationReplacement(source, located, { latex: 'z^4', inline: !located.draft.inline });
		assert.equal(switched, equationSource('z^4', !located.draft.inline));
	}
});

test('equation replacement rejects stale, foreign and malformed span authority', () => {
	const source = SourceDocument.open(bytes('prefix $x^2$ suffix'));
	const located = equationAt(source, parseSource(source), source.read().indexOf('x^2'));
	assert.ok(located);
	const next = source.apply({ expectedVersion: source.version, patches: [{ from: 0, to: 0, insert: 'new ' }] }).document;
	assert.throws(() => equationReplacement(next, located, located.draft), /STALE_EQUATION/);
	assert.throws(() => equationReplacement(SourceDocument.open(source.toBytes()), located, located.draft), /STALE_EQUATION/);
	for (const changed of [
		{ span: { ...located.span, documentId: 'foreign' } },
		{ content: { ...located.content, version: located.content.version + 1 } },
		{ span: { ...located.span, from: -1 } },
		{ span: { ...located.span, to: source.length + 1 } },
		{ content: { ...located.content, from: located.span.from - 1 } },
		{ content: { ...located.content, to: located.span.to + 1 } },
		{ content: { ...located.content, from: located.content.to + 1 } }
	]) assert.throws(() => equationReplacement(source, { ...located, ...changed }, located.draft));
	assert.deepEqual(source.toBytes(), bytes('prefix $x^2$ suffix'));
});

for (const originalEquation of ['$x^2$', '$$x^2$$', '\\(x^2\\)', '\\[x^2\\]']) {
	test(`${originalEquation} local re-edit uses real CodeMirror history and restores BOM/mixed EOL bytes`, () => {
		const original = bytes('\uFEFF😀% keep\r\n' + originalEquation + '\r\n\\opaque{雪}\nlast\r');
		const initial = SourceDocument.open(original);
		let state = createSourceState(initial);
		const found = equationAt(initial, parseSource(initial), initial.read().indexOf('x'));
		assert.ok(found);
		const target = rangeInsertionTarget(state, found.span);
		state = insertionTransaction(state, target, equationReplacement(initial, found, { latex: 'y+\\alpha', inline: found.draft.inline }).replace(/\r\n|\r/g, '\n')).state;
		const changed = state.field(sourceState).projection.document;
		assert.equal(changed.documentId, initial.documentId);
		assert.equal(state.field(sourceState).undo.length, 1);
		assert.equal(state.field(sourceState).dirty, true);
		assert.match(changed.read(), /^😀% keep\r\n/);
		assert.match(changed.read(), /\r\n\\opaque\{雪\}\nlast\r$/);
		assert.throws(() => insertionTransaction(state, target, 'stale'), /STALE_INSERTION/);
		assert.throws(() => rangeInsertionTarget(state, found.span), /STALE_INSERTION/);
		const fresh = equationAt(changed, parseSource(changed), changed.read().indexOf('y+'));
		assert.ok(fresh);
		assert.equal(fresh.draft.latex.trim(), 'y+\\alpha');
		state = insertionTransaction(state, rangeInsertionTarget(state, fresh.span), equationReplacement(changed, fresh, { latex: 'z^3', inline: fresh.draft.inline }).replace(/\r\n|\r/g, '\n')).state;
		assert.equal(state.field(sourceState).undo.length, 2);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original);
		assert.equal(state.field(sourceState).dirty, false);
		const restored = state.field(sourceState).projection.document;
		const reopened = equationAt(restored, parseSource(restored), restored.read().indexOf('x'));
		assert.ok(reopened);
		assert.equal(restored.read(reopened.span.from, reopened.span.to), originalEquation);
		state = historyTransaction(state, 'redo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
		assert.deepEqual(initial.toBytes(), original);
	});
}

test('unchanged genuine mixed-EOL equation edit is a no-op without dirty state or history', () => {
	const original = bytes('\uFEFF😀 prefix\r\n\\[ \r\nx^2% keep\n +雪\r \\]\r\n\\opaque{untouched}\nlast\r');
	const source = SourceDocument.open(original), state = createSourceState(source);
	const located = equationAt(source, parseSource(source), source.read().indexOf('x^2'));
	assert.ok(located);
	const before = state.field(sourceState);
	assert.equal(equationEditTransaction(state, located, { ...located.draft }), null);
	assert.equal(state.field(sourceState), before);
	assert.equal(state.field(sourceState).dirty, false);
	assert.equal(state.field(sourceState).undo.length, 0);
	assert.equal(historyTransaction(state, 'undo'), null);
	assert.deepEqual(source.toBytes(), original);
});

test('real equation edit helper accepts CRLF inner source, preserves surrounding bytes and undoes exactly', () => {
	const prefix = '\uFEFF😀% keep\r\n';
	const suffix = '\r\n\\opaque{雪}\nlast\r';
	const original = bytes(prefix + '\\[\r\nx^2\r\n\\]' + suffix);
	const source = SourceDocument.open(original);
	let state = createSourceState(source);
	const located = equationAt(source, parseSource(source), source.read().indexOf('x^2'));
	assert.ok(located);
	const draft = { latex: '\r\ny+\\alpha\r\n', inline: false };
	const transaction = equationEditTransaction(state, located, draft);
	assert.ok(transaction);
	state = transaction.state;
	const changed = state.field(sourceState).projection.document;
	assert.deepEqual(changed.toBytes(), bytes(prefix + '\\[\r\ny+\\alpha\r\n\\]' + suffix));
	assert.equal(state.field(sourceState).dirty, true);
	assert.equal(state.field(sourceState).undo.length, 1);
	assert.throws(() => equationEditTransaction(state, located, draft), /STALE/);
	const fresh = equationAt(changed, parseSource(changed), changed.read().indexOf('y+'));
	assert.ok(fresh);
	assert.equal(equationEditTransaction(state, fresh, { ...fresh.draft }), null);
	assert.equal(state.field(sourceState).undo.length, 1);
	assert.equal(state.field(sourceState).dirty, true);
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original);
	assert.equal(state.field(sourceState).dirty, false);
	state = historyTransaction(state, 'redo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
	assert.deepEqual(source.toBytes(), original);
});
