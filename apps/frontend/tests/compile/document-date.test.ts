import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '../../src/features/document-core/core.ts';
import { AUTOMATIC_DATE, DATE_VALUES, numericDatePreview, planDocumentDatePatches, readDocumentDate } from '../../src/features/compile/document-date.ts';

test('document dates distinguish implicit, disabled, automatic and custom values without guessing a language', () => {
	for (const [value, mode, implicit] of [['','document',true], ['\\date{}','none',false], ['\\date{\\today}','document',false], ['\\date{2020-01-01}','custom',false], [`\\date{${AUTOMATIC_DATE}}`,'iso',false]] as const) {
		const source = SourceDocument.open(new TextEncoder().encode(`\\documentclass{article}\r\n${value}\r\n\\begin{document}\r\nBody\r\n\\end{document}`));
		assert.deepEqual(readDocumentDate(source), {mode,implicit});
		for (const desired of ['none','iso','slash','day-first','document'] as const) {
			const updated = source.apply({expectedVersion:source.version,patches:planDocumentDatePatches(source,desired)}).document;
			assert.deepEqual(readDocumentDate(updated),{mode:desired,implicit:false});
			assert(updated.read().endsWith('\\begin{document}\r\nBody\r\n\\end{document}'));
			assert.equal(planDocumentDatePatches(updated,desired).length,0);
		}
	}
});

test('numeric preview uses the selected format without choosing a language', () => {
	const now = new Date(2026,0,3);
	assert.equal(numericDatePreview(`\\date{${DATE_VALUES.iso}}`,now),'2026-01-03');
	assert.equal(numericDatePreview(`\\date{${DATE_VALUES.slash}}`,now),'2026/01/03');
	assert.equal(numericDatePreview(`\\date{${DATE_VALUES['day-first']}}`,now),'03/01/2026');
	assert.equal(numericDatePreview('\\date{\\today}',now),null);
});

test('ambiguous date declarations and missing document envelopes are refused', () => {
	for (const text of ['\\date{}\\date{\\today}\\begin{document}x\\end{document}', 'plain text']) {
		const source = SourceDocument.open(new TextEncoder().encode(text));
		assert.throws(() => planDocumentDatePatches(source,'none'),/DATE_UNSUPPORTED/);
	}
});
