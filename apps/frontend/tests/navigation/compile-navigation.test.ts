import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '@modutex/document-core';
import type { CompileIdentity, Diagnostic } from '@modutex/frontend-contracts';
import { diagnosticSpan, previewStatus } from '../../src/features/compile/navigation.ts';
import { createSourceState, sourceState, sourceNavigationTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';

const open = (text: string) => SourceDocument.open(new TextEncoder().encode(text));
const identity = (source: SourceDocument): CompileIdentity => ({ runId: 'actual-run-binding', workspaceId: 'workspace', entryPath: 'main.tex', documentId: source.documentId, documentVersion: source.version, savedRevision: 'sha256:' + 'a'.repeat(64) });
const diagnostic: Diagnostic = { severity: 'error', message: 'Undefined control sequence', path: 'main.tex', line: 3, column: null };

test('diagnostic line navigation uses actual CodeMirror state and preserves BOM, mixed EOL, bytes and history', () => {
	const source = open('\uFEFF% 😀\r\none\rtarget 雪\nlast');
	const span = diagnosticSpan(source, 'main.tex', identity(source), diagnostic)!;
	assert.equal(source.read(span.from, span.to), 'target 雪');
	const state = createSourceState(source), navigated = sourceNavigationTransaction(state, span).state;
	assert.equal(navigated.doc.lineAt(navigated.selection.main.head).number, 3);
	assert.equal(navigated.field(sourceState), state.field(sourceState));
	assert.deepEqual(navigated.field(sourceState).projection.document.toBytes(), source.toBytes());
	assert.equal(historyTransaction(navigated, 'undo'), null);
	assert.equal(source.read(diagnosticSpan(source, 'main.tex', identity(source), { ...diagnostic, line: 4 })!.from), 'last');
});
test('stale, foreign, included-file, missing or invalid diagnostics cannot navigate current source', () => {
	const source = open('one\ntwo\nthree'), bound = identity(source);
	const changed = source.apply({ expectedVersion: source.version, patches: [{ from: 0, to: 0, insert: 'prefix\n' }] }).document;
	assert.equal(diagnosticSpan(changed, 'main.tex', bound, diagnostic), null);
	assert.equal(diagnosticSpan(open(source.read()), 'main.tex', bound, diagnostic), null);
	assert.equal(diagnosticSpan(source, 'other.tex', bound, diagnostic), null);
	for (const value of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER, 4]) assert.equal(diagnosticSpan(source, 'main.tex', bound, { ...diagnostic, line: value }), null);
	assert.equal(diagnosticSpan(source, 'main.tex', bound, { ...diagnostic, path: 'include.tex' }), null);
});
test('PDF ownership distinguishes external, current and stale without treating old results as current', () => {
	const source = open('one'), bound = identity(source);
	assert.equal(previewStatus(source, 'main.tex', null), 'external');
	assert.equal(previewStatus(source, 'main.tex', bound), 'current');
	const changed = source.apply({ expectedVersion: source.version, patches: [{ from: 0, to: 0, insert: 'new' }] }).document;
	assert.equal(previewStatus(changed, 'main.tex', bound), 'stale');
	assert.equal(previewStatus(null, 'main.tex', bound), 'stale');
	assert.equal(previewStatus(open(source.read()), 'main.tex', bound), 'stale');
	assert.equal(previewStatus(source, 'other.tex', bound), 'stale');
});
