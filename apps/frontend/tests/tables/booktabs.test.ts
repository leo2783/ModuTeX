import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { createTable, tableSource, parseTable } from '../../src/features/tables/source.ts';
import { booktabsPlan, tableInsertionTransaction } from '../../src/features/tables/preamble.ts';
import { createSourceState, sourceState, rangeInsertionTarget, historyTransaction } from '../../src/features/source-editor/state.ts';
import { sourceLimit } from '../../src/features/files/read.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (text: string) => new TextEncoder().encode(text);
const open = (text: string) => SourceDocument.open(bytes(text));
const draft = () => ({ ...createTable(3, 2), rules: 'booktabs' as const, cells: ['Name', 'Value', 'A & B', '10%', '雪\\{}_$^~#', ''], weights: [2, 1] });
function bodySpan(source: SourceDocument) { const from = source.read().indexOf('Body'); assert.ok(from >= 0); return { documentId: source.documentId, version: source.version, from, to: from + 4 }; }

test('booktabs exact subset round-trips header/caption/Unicode/literal escapes and preserves old hline generation', () => {
	for (const header of [true, false]) for (const position of ['none', 'above', 'below'] as const) for (const rows of [1, 3]) {
		const value = { ...draft(), rows, cells: draft().cells.slice(0, rows * 2), header, caption: { position, text: 'Results_#1' } };
		const text = tableSource(value), parsed = parseTable(text.replaceAll('\n', '\r\n'));
		assert.ok(parsed); assert.equal(parsed.rules, 'booktabs'); assert.equal(parsed.header, header);
		assert.deepEqual(parsed.cells, value.cells); assert.equal(parsed.caption.position, position); assert.equal(tableSource(parsed), text);
		assert.equal(text.match(/\\toprule/g)?.length, 1); assert.equal(text.match(/\\bottomrule/g)?.length, 1);
		assert.equal(text.match(/\\midrule/g)?.length ?? 0, header && rows > 1 ? 1 : 0); assert.doesNotMatch(text, /\\hline|usepackage/);
	}
	const old = createTable(); assert.equal(tableSource({ ...old, rules: 'hline' }), tableSource(old));
	assert.equal(parseTable(tableSource(old))?.rules, undefined);
	assert.throws(() => tableSource({ ...draft(), style: 'full' }), /TABLE_DRAFT/);
	assert.throws(() => tableSource({ ...draft(), style: 'horizontal' }), /TABLE_DRAFT/);
});

test('modified rule order, duplicate rules, unsupported options and mixed hline/booktabs remain unparsed Raw', () => {
	const text = tableSource(draft());
	for (const altered of [text.replace('\\toprule', '\\hline'), text.replace('\\bottomrule', '\\toprule'), text.replace('\\midrule', '\\midrule\n\\midrule'), text.replace('\\toprule', '\\toprule[2pt]'), text.replace('\\midrule', '\\cmidrule{1-2}')]) assert.equal(parseTable(altered), null);
});

test('package plan recognizes only current direct literal declarations and rejects incomplete/dynamic preambles', () => {
	for (const command of ['\\usepackage{booktabs}', '\\usepackage[foo]{array, booktabs}', '\\RequirePackage{booktabs}']) {
		const source = open('\\documentclass{article}\n' + command + '\n\\begin{document}\nBody\n\\end{document}');
		assert.equal(booktabsPlan(source, parseSource(source)), null);
	}
	const source = open('\uFEFF% \\usepackage{booktabs}\r\n\\documentclass{article}\r\n\\begin{document}\nBody\r\\end{document}');
	const plan = booktabsPlan(source, parseSource(source)); assert.ok(plan);
	assert.equal(plan.insert, '\\usepackage{booktabs}\n');
	assert.equal(plan.span.from, source.read().indexOf('\\begin{document}')); assert.equal(plan.span.to, plan.span.from);
	assert.deepEqual(source.toBytes(), bytes('\uFEFF% \\usepackage{booktabs}\r\n\\documentclass{article}\r\n\\begin{document}\nBody\r\\end{document}'));
	assert.throws(() => booktabsPlan(open(source.read()), parseSource(source)), /STALE_PREAMBLE/);
	const changed = source.apply({ expectedVersion: source.version, patches: [{ from: 0, to: 0, insert: 'new' }] }).document;
	assert.throws(() => booktabsPlan(changed, parseSource(source)), /STALE_PREAMBLE/);
	for (const text of ['\\documentclass{article}\nBody', '\\begin{document}\nBody', '\\begin{document}a\\end{document}\\begin{document}b\\end{document}', '\\usepackage{\\packages}\n\\begin{document}Body\\end{document}', '\\usepackage{booktabs\n\\begin{document}Body\\end{document}']) {
		const unsupported = open(text); assert.throws(() => booktabsPlan(unsupported, parseSource(unsupported)), /PREAMBLE_UNSUPPORTED/);
	}
});

test('confirmed package+table is one genuine CM history entry with exact BOM/mixed-EOL undo and redo', () => {
	const text = '\uFEFF% keep\r\n\\documentclass{article}\r\n\\begin{document}\r\nBody\r\\opaque{keep}\n\\end{document}';
	const source = open(text), plan = booktabsPlan(source, parseSource(source)); assert.ok(plan);
	let state = createSourceState(source); const span = bodySpan(source), target = rangeInsertionTarget(state, span), table = tableSource(draft());
	state = state.update({ selection: { anchor: state.doc.length } }).state;
	state = tableInsertionTransaction(state, target, table, plan, { span, inlineOnly: false }).state;
	const changed = state.field(sourceState).projection.document;
	const wanted = text.replace('\\begin{document}', '\\usepackage{booktabs}\r\n\\begin{document}').replace('Body', table.replaceAll('\n', '\r\n'));
	assert.deepEqual(changed.toBytes(), bytes(wanted)); assert.equal(state.field(sourceState).undo.length, 1);
	assert.equal(booktabsPlan(changed, parseSource(changed)), null);
	const undo = historyTransaction(state, 'undo'); assert.ok(undo); state = undo.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes()); assert.equal(state.field(sourceState).dirty, false);
	assert.equal(historyTransaction(state, 'undo'), null);
	const redo = historyTransaction(state, 'redo'); assert.ok(redo); assert.deepEqual(redo.state.field(sourceState).projection.document.toBytes(), changed.toBytes());
	const existing = open('\\usepackage{booktabs}\n\\begin{document}\nBody\n\\end{document}');
	const already = createSourceState(existing), captured = bodySpan(existing);
	const result = tableInsertionTransaction(already, rangeInsertionTarget(already, captured), table, booktabsPlan(existing, parseSource(existing))).state;
	assert.equal(result.field(sourceState).projection.document.read().match(/\\usepackage\{booktabs\}/g)?.length, 1);
});

test('package transaction rejects stale/foreign/tampered/overlapping plans and mismatched visual target atomically', () => {
	const source = open('\\documentclass{article}\n\\begin{document}\nBody\n\\end{document}'), state = createSourceState(source), span = bodySpan(source), target = rangeInsertionTarget(state, span), plan = booktabsPlan(source, parseSource(source)); assert.ok(plan);
	const table = tableSource(draft());
	const badPlans = [{ ...plan, insert: '\\usepackage{evil}\n' }, { ...plan, span: { ...plan.span, from: 0, to: 0 } }, { ...plan, span: { ...plan.span, to: plan.span.to + 1 } }, { ...plan, span }, { ...plan, span: { ...plan.span, version: plan.span.version + 1 } }, { ...plan, span: { ...plan.span, documentId: open(source.read()).documentId } }];
	for (const bad of badPlans) assert.throws(() => tableInsertionTransaction(state, target, table, bad), /PREAMBLE_RANGE|STALE_INSERTION/);
	assert.throws(() => tableInsertionTransaction(state, target, table, plan, { span: { ...span, from: 0, to: 0 }, inlineOnly: false }), /PREAMBLE_RANGE|STALE_INSERTION/);
	assert.throws(() => tableInsertionTransaction(state, target, table, plan, { span, inlineOnly: true }), /INSERTION_INLINE_ONLY/);
	const advanced = state.update({ changes: { from: state.doc.length, insert: 'new' } }).state;
	assert.throws(() => tableInsertionTransaction(advanced, target, table, plan), /STALE_INSERTION/);
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes()); assert.equal(state.field(sourceState).dirty, false); assert.equal(historyTransaction(state, 'undo'), null);
});

test('shared 5 MiB filter rejects combined preamble+table even when table alone fits; no partial package/history change', () => {
	const table = tableSource({ ...createTable(1, 1), rules: 'booktabs' }), prefix = '\\documentclass{article}\n%', suffix = '\n\\begin{document}\nBody\n\\end{document}';
	const padding = sourceLimit - table.length - 5 - prefix.length - suffix.length;
	const text = prefix + '雪'.repeat(Math.floor(padding / 3)) + 'a'.repeat(padding % 3) + suffix;
	const source = open(text), parsed = parseSource(source), plan = booktabsPlan(source, parsed); assert.ok(plan);
	const reasons: (string | undefined)[] = []; let state = createSourceState(source, reason => reasons.push(reason)); state = state.update({ selection: { anchor: 42 } }).state;
	const from = source.read().indexOf('Body'), span = { documentId: source.documentId, version: source.version, from, to: from }, before = state.field(sourceState);
	const transaction = tableInsertionTransaction(state, rangeInsertionTarget(state, span), table, plan);
	assert.equal(transaction.docChanged, false); assert.equal(transaction.state.field(sourceState), before); assert.equal(transaction.state.selection.main.anchor, 42);
	assert.deepEqual(transaction.state.field(sourceState).projection.document.toBytes(), source.toBytes()); assert.deepEqual(reasons, ['SOURCE_TOO_LARGE']); assert.equal(historyTransaction(transaction.state, 'undo'), null);
});

test('parser budget exhaustion refuses a package plan without touching the large ASCII source', () => {
	const source = open('\\documentclass{article}\n%' + 'a'.repeat(sourceLimit - 256) + '\n\\begin{document}\nBody\n\\end{document}');
	const parsed = parseSource(source);
	assert.ok(parsed.issues.some(issue => issue.code === 'BUDGET'));
	assert.throws(() => booktabsPlan(source, parsed), /PREAMBLE_UNSUPPORTED/);
	assert.doesNotMatch(source.read(), /\\usepackage\{booktabs\}/);
});

test('real Svelte SSR exposes explicit hline and booktabs choices without pretending confirmation was exercised', { timeout: 15000 }, async () => {
	const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'error' });
	try {
		const module = await server.ssrLoadModule('/src/features/tables/TablePanel.svelte'), { render } = await server.ssrLoadModule('svelte/server');
		const dom = new JSDOM(render(module.default, { props: { active: true, onInsert: () => assert.fail('SSR must not insert'), onClose: () => {} } }).body);
		try { assert.equal(dom.window.document.querySelector('option[value="booktabs"]')?.textContent, 'Booktabs'); assert.match(dom.window.document.querySelector('option[value="hline"]')?.textContent ?? '', /不加套件/); assert.equal(dom.window.document.querySelectorAll('script').length, 0); } finally { dom.window.close(); }
	} finally { await server.close(); }
});
