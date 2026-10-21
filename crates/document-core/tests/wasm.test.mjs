// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
const directory = resolve(process.env.MODUTEX_DOCUMENT_CORE_WASM_DIR ?? 'apps/frontend/src/features/document-core/generated');
const core = await import(pathToFileURL(resolve(directory, 'modutex_document_core.js')).href);
core.initSync({ module: await readFile(resolve(directory, 'modutex_document_core_bg.wasm')) });
const utf8 = new TextEncoder();
function owned(t) {
	const objects = [];
	t.after(() => {
		for (const value of objects.reverse()) value.free();
	});
	return (value) => {
		objects.push(value);
		return value;
	};
}
function code(expected) {
	return (error) => error?.name === 'SourceError' && error.code === expected;
}
function synctexCode(expected) {
	return (error) => error?.name === 'SynctexError' && error.code === expected;
}
const compactKinds = ['text', 'comment', 'heading', 'format', 'math', 'environment', 'raw'];
const compactRootParent = 0xffffffff;
const synctexSource = 'C:\\' + String.fromCodePoint(0x8cc7, 0x6599) + '\\main.tex';
const synctexFixture = [
	'SyncTeX Version:1',
	`Input:17:${synctexSource}`,
	'Output:pdf',
	'Magnification:1000',
	'Unit:1',
	'X Offset:0',
	'Y Offset:0',
	'Content:',
	'{1',
	'[17,7:655360,1310720:1310720,655360,65536',
	'h17,7,4:655360,1310720:655360,327680,65536',
	']',
	'}1',
	'Postamble:',
	'Count:30',
	'!17',
	'Post scriptum:',
	'!24',
	''
].join('\n');
function compactProjection(projection) {
	const records = projection.compactNodes();
	assert(records instanceof Uint32Array);
	assert.equal(records.length % 8, 0);
	const names = JSON.parse(projection.compactNamesJson());
	assert(Array.isArray(names));
	assert(names.every((name) => typeof name === 'string'));
	assert.equal(new Set(names).size, names.length);
	const issues = JSON.parse(projection.issuesJson());
	assert(Array.isArray(issues));
	const documentId = projection.documentId,
		version = projection.version;
	assert.equal(typeof documentId, 'string');
	assert(Number.isSafeInteger(version));
	const roots = [],
		ancestors = [];
	for (let index = 0; index < records.length / 8; index++) {
		const offset = index * 8,
			kind = compactKinds[records[offset]],
			from = records[offset + 1],
			to = records[offset + 2],
			hasContent = records[offset + 3],
			contentFrom = records[offset + 4],
			contentTo = records[offset + 5],
			parentIndex = records[offset + 6],
			nameIndex = records[offset + 7];
		assert.notEqual(kind, undefined);
		assert(from <= to);
		assert(hasContent === 0 || hasContent === 1);
		assert(nameIndex < names.length);
		let content = null;
		if (hasContent === 0) {
			assert.equal(contentFrom, 0);
			assert.equal(contentTo, 0);
		} else {
			assert(from <= contentFrom);
			assert(contentFrom <= contentTo);
			assert(contentTo <= to);
			content = { documentId, from: contentFrom, to: contentTo, version };
		}
		const node = { kind, span: { documentId, from, to, version }, name: names[nameIndex], content, children: [] };
		if (parentIndex === compactRootParent) {
			ancestors.length = 0;
			roots.push(node);
		} else {
			assert(parentIndex < index);
			while (ancestors.length && ancestors[ancestors.length - 1].index !== parentIndex) ancestors.pop();
			assert(ancestors.length > 0);
			ancestors[ancestors.length - 1].node.children.push(node);
		}
		ancestors.push({ index, node });
	}
	return { documentId, version, nodes: roots, issues };
}

test('WASM owns the exact input view and preserves BOM, mixed line endings and UTF-16 ranges', (t) => {
	const keep = owned(t);
	const bytes = utf8.encode('\ufeffA𠀀\r\nB\rC\n');
	const allocation = new Uint8Array(bytes.length + 2);
	allocation.fill(255);
	allocation.set(bytes, 1);
	const doc = keep(core.SourceDocument.open(allocation.subarray(1, -1)));
	allocation.fill(0);
	assert.deepEqual(doc.toBytes(), bytes);
	assert.equal(doc.read(0, doc.length), 'A𠀀\r\nB\rC\n');
	assert.equal(doc.read(1, 3), '𠀀');
	assert.throws(() => doc.read(1, 2), code('RANGE'));
	const profile = JSON.parse(doc.profileJson());
	assert.equal(profile.bom, true);
	assert.deepEqual(profile.originalLineEndings, { lf: 1, crlf: 1, cr: 1 });
});

test('WASM transactions remain atomic and restoration preserves snapshot ownership and increasing versions', (t) => {
	const keep = owned(t);
	const original = keep(core.SourceDocument.open(utf8.encode('A𠀀B')));
	const update = keep(original.apply(JSON.stringify({ expectedVersion: 0, patches: [{ from: 0, to: 1, insert: '甲', expected: 'A' }] })));
	const doc = keep(update.document);
	const change = keep(update.change);
	assert.equal(original.read(0, original.length), 'A𠀀B');
	assert.equal(doc.read(0, doc.length), '甲𠀀B');
	assert.equal(doc.version, 1);
	assert.equal(core.mapPosition(change, 4, 'after'), 4);
	assert.throws(() => doc.apply(JSON.stringify({ expectedVersion: 0, patches: [] })), code('VERSION'));
	assert.throws(() => doc.apply(JSON.stringify({ expectedVersion: 1, patches: [{ from: 1, to: 2, insert: 'x' }] })), code('RANGE'));
	assert.equal(doc.read(0, doc.length), '甲𠀀B');
	const restored = keep(doc.restore(original, 1));
	assert.equal(restored.version, 2);
	assert.deepEqual(restored.toBytes(), original.toBytes());
	const foreign = keep(core.SourceDocument.open(original.toBytes()));
	assert.throws(() => doc.restore(foreign, 1), code('ORIGIN'));
});

test('WASM JSON boundary rejects unpaired UTF-16 and unsafe JavaScript positions', (t) => {
	const keep = owned(t);
	const doc = keep(core.SourceDocument.open(utf8.encode('safe')));
	for (const position of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => doc.read(position, 1), code('RANGE'));
	assert.throws(() => core.SourceDocument.openAt(utf8.encode('x'), 'worker', 1.5), code('VERSION'));
	assert.throws(
		() => doc.apply(JSON.stringify({ expectedVersion: 0, patches: [{ from: 0, to: 0, insert: String.fromCharCode(0xd800) }] })),
		code('ENCODING')
	);
	assert.equal(doc.read(0, doc.length), 'safe');
});

test('WASM compact AST records reconstruct the exact owned projection', (t) => {
	const keep = owned(t);
	const source = 'before%comment\n\\section{\u7532 \\textbf{bold}} $\u{20000}$ \\begin{document}body\\end{document} \\unknown{raw} }';
	const doc = keep(core.SourceDocument.openAt(utf8.encode(source), 'compact-worker', 9));
	const projection = keep(core.parseSource(doc));
	const expected = JSON.parse(projection.toJson());
	const actual = compactProjection(projection);
	assert.deepEqual(actual, expected);
	const kinds = new Set();
	const visit = (nodes) => {
		for (const node of nodes) {
			kinds.add(node.kind);
			visit(node.children);
		}
	};
	visit(actual.nodes);
	assert.deepEqual([...kinds].sort(), ['comment', 'environment', 'format', 'heading', 'math', 'raw', 'text']);
	assert(actual.issues.some((issue) => issue.code === 'MISMATCH'));
});

test('WASM parser binds worker identity/version to every node and preserves budget fallback', (t) => {
	const keep = owned(t);
	const doc = keep(core.SourceDocument.openAt(utf8.encode('\\section{甲}𠀀 \\textbf{bold}'), 'worker-owned', 7));
	const parsed = keep(core.parseSource(doc));
	const p = JSON.parse(parsed.toJson());
	assert.equal(p.documentId, 'worker-owned');
	assert.equal(p.version, 7);
	const visit = (nodes) => {
		for (const node of nodes) {
			assert.equal(node.span.documentId, 'worker-owned');
			assert.equal(node.span.version, 7);
			if (node.content) {
				assert.equal(node.content.documentId, 'worker-owned');
				assert.equal(node.content.version, 7);
			}
			visit(node.children ?? []);
		}
	};
	visit(p.nodes);
	assert.equal(core.projectionIsCurrent(doc, parsed), true);
	const limited = keep(core.parseSourceWithLimits(doc, 1, 100000));
	const value = JSON.parse(limited.toJson());
	assert.deepEqual(compactProjection(limited), value);
	assert(value.issues.some((issue) => issue.code === 'BUDGET'));
	assert.equal(value.nodes.length, 1);
	assert.equal(value.nodes[0].kind, 'raw');
	assert.equal(value.nodes[0].span.to, doc.length);
});

test('WASM editor projection keeps disk bytes and maps CRLF edits and undo correctly', (t) => {
	const keep = owned(t);
	const doc = keep(core.SourceDocument.open(utf8.encode('A\r\n𠀀B\rC')));
	const editor = keep(core.EditorProjection.open(doc));
	assert.equal(editor.text(), 'A\n𠀀B\nC');
	assert.equal(editor.toSource(2), 3);
	const changed = keep(editor.apply(JSON.stringify([{ from: 0, to: 1, insert: '甲\n' }]), 0));
	const changedDoc = keep(changed.document);
	assert.equal(changed.text(), '甲\n\n𠀀B\nC');
	assert.equal(changedDoc.read(0, changedDoc.length), '甲\r\n\r\n𠀀B\rC');
	const restored = keep(changed.restore(editor));
	const restoredDoc = keep(restored.document);
	assert.deepEqual(restoredDoc.toBytes(), doc.toBytes());
	assert.equal(restoredDoc.version, 2);
});

test('WASM SyncTeX index owns plain and gzip UTF-8 bytes and returns core forward/inverse results', (t) => {
	const keep = owned(t);
	const bytes = utf8.encode(synctexFixture);
	const index = keep(core.SynctexIndex.parse(bytes));
	bytes.fill(0);
	const location = JSON.parse(index.forwardSearch(synctexSource, 7, null));
	const scale = 7200 / 7227;
	assert.equal(location.page, 1);
	for (const [field, value] of Object.entries({ x: 10 * scale, y: 15 * scale, width: 10 * scale, height: 5 * scale, depth: scale }))
		assert(Math.abs(location[field] - value) < 1e-9);
	assert.equal(JSON.parse(index.forwardSearch(synctexSource, 7, 1)).page, 1);
	assert.deepEqual(JSON.parse(index.inverseSearch(location.page, location.x + location.width / 2, location.y + location.height / 2)), {
		path: synctexSource,
		line: 7,
		column: 4
	});
	assert.equal(JSON.parse(index.forwardSearch('C:\\other\\main.tex', 7, null)), null);
	assert.equal(JSON.parse(index.inverseSearch(2, 0, 0)), null);
	const compressed = keep(core.SynctexIndex.parse(gzipSync(utf8.encode(synctexFixture))));
	assert.deepEqual(JSON.parse(compressed.forwardSearch(synctexSource, 7, null)), location);
});

test('WASM SyncTeX index rejects invalid query numbers and preserves parser error codes', (t) => {
	const keep = owned(t);
	const index = keep(core.SynctexIndex.parse(utf8.encode(synctexFixture)));
	for (const line of [NaN, Infinity, -1, 0, 0.5, 0x1_0000_0000, Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() => index.forwardSearch(synctexSource, line, null), synctexCode('INVALID_NUMBER'));
	for (const page of [NaN, Infinity, -1, 0, 1.5, 0x1_0000_0000])
		assert.throws(() => index.inverseSearch(page, 0, 0), synctexCode('INVALID_NUMBER'));
	for (const pageHint of [NaN, Infinity, -1, 0, 1.5, 0x1_0000_0000])
		assert.throws(() => index.forwardSearch(synctexSource, 7, pageHint), synctexCode('INVALID_NUMBER'));
	for (const coordinate of [NaN, Infinity, -Infinity, 1_000_000_000_001, -1_000_000_000_001]) {
		assert.throws(() => index.inverseSearch(1, coordinate, 0), synctexCode('INVALID_COORDINATE'));
		assert.throws(() => index.inverseSearch(1, 0, coordinate), synctexCode('INVALID_COORDINATE'));
	}
	assert.throws(
		() => core.SynctexIndex.parse(utf8.encode(synctexFixture.replace('Unit:1', 'Unit:NaN'))),
		(error) => error?.name === 'SynctexError' && error.code === 'INVALID_NUMBER' && error.message === 'Invalid SyncTeX number'
	);
});
