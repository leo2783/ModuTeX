import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	ContractError,
	relativePath,
	parseWorkspaceInfo,
	parseFileEntries,
	parseFileEvent,
	parseReadReceipt,
	parseWriteRequest,
	parseWriteReceipt,
	parseSaveAsRequest,
	parseSaveAsReceipt,
	parseCompileRequest,
	parseCompileIdentity,
	parseCompileResult
} from '../src/index.ts';

const file = { workspaceId: 'workspace-1', path: '論文/main.tex' };
const write = { ...file, bytes: Uint8Array.of(65, 66), expectedRevision: 'sha256:old', documentId: 'document-1', documentVersion: 4 };
const identity = {
	runId: 'run-1',
	workspaceId: file.workspaceId,
	entryPath: file.path,
	documentId: write.documentId,
	documentVersion: 4,
	savedRevision: 'sha256:saved'
};
const limits = { maxPdfBytes: 1024, maxLogCharacters: 100, maxDiagnostics: 4 };
const diagnostic = { severity: 'error', message: 'Undefined environment', path: file.path, line: 12, column: null };
const success = () => ({
	status: 'success',
	identity: { ...identity },
	log: 'Complete',
	diagnostics: [],
	// Wire-header fixture only. This is not a compiled or renderable PDF.
	pdf: new TextEncoder().encode('%PDF-1.7\n')
});
const rejected = (fn: () => unknown) => assert.throws(fn, ContractError);

test('relative filesystem paths retain Unicode and literal percent signs', () => {
	for (const path of ['main.tex', '論文/第1章.tex', '.config/settings.json', 'figures/%2e%2e.png']) {
		assert.equal(relativePath(path), path);
	}
});

test('absolute, escaping, Windows-ambiguous, device and URL paths are rejected', () => {
	for (const path of [
		'',
		'/root.tex',
		'C:/main.tex',
		'C:\\main.tex',
		'\\\\server\\file.tex',
		'../main.tex',
		'a/../main.tex',
		'./main.tex',
		'a//main.tex',
		'a/.. /main.tex',
		'a./main.tex',
		'a /main.tex',
		'a\u0000.tex',
		'a\n.tex',
		'a:stream.tex',
		'CON',
		'nul.tex',
		'A/COM1.png',
		'Lpt9',
		'https://example.org/main.tex'
	]) {
		rejected(() => relativePath(path));
	}
});

test('workspace picker cancellation and folder/file results are validated', () => {
	assert.equal(parseWorkspaceInfo(null), null);
	assert.deepEqual(parseWorkspaceInfo({ id: 'ws-1', label: '論文', entryPath: null }), { id: 'ws-1', label: '論文', entryPath: null });
	assert.deepEqual(parseWorkspaceInfo({ id: 'ws-1', label: '論文', entryPath: 'main.tex' }), {
		id: 'ws-1',
		label: '論文',
		entryPath: 'main.tex'
	});
	rejected(() => parseWorkspaceInfo({ id: 'C:/folder', label: '論文', entryPath: null }));
	rejected(() => parseWorkspaceInfo({ id: 'ws-1', label: '論文', entryPath: '../outside.tex' }));
});

test('file lists reject duplicate entries, invalid kinds, accessors and excessive size', () => {
	assert.equal(
		parseFileEntries(
			[
				{ path: 'main.tex', kind: 'file' },
				{ path: 'images', kind: 'directory' }
			],
			2
		).length,
		2
	);
	rejected(() =>
		parseFileEntries(
			[
				{ path: 'a', kind: 'file' },
				{ path: 'a', kind: 'file' }
			],
			2
		)
	);
	rejected(() => parseFileEntries([{ path: 'a', kind: 'symlink' }], 2));
	rejected(() => parseFileEntries([{ path: 'a', kind: 'file' }], 0));
	rejected(() => parseFileEntries(new Array(2), 2));
	let invoked = false;
	const items = [{ path: 'a', kind: 'file' }];
	Object.defineProperty(items, '0', {
		get() {
			invoked = true;
			return {};
		}
	});
	rejected(() => parseFileEntries(items, 2));
	assert.equal(invoked, false);
});

test('file watchers cannot dispatch a foreign workspace notification', () => {
	assert.deepEqual(parseFileEvent({ ...file, kind: 'changed' }, file.workspaceId), { ...file, kind: 'changed' });
	rejected(() => parseFileEvent({ ...file, kind: 'removed' }, 'other-workspace'));
	rejected(() => parseFileEvent({ ...file, kind: 'execute' }, file.workspaceId));
});

test('read receipt binds the file and owns a byte copy', () => {
	const bytes = Uint8Array.of(1, 2, 3);
	const parsed = parseReadReceipt({ ...file, bytes, revision: 'rev-1' }, file, 3);
	bytes.fill(9);
	assert.deepEqual(parsed.bytes, Uint8Array.of(1, 2, 3));
	assert.equal(Object.isFrozen(parsed), true);
	rejected(() => parseReadReceipt({ ...file, path: 'other.tex', bytes, revision: 'rev-1' }, file, 3));
	rejected(() => parseReadReceipt({ ...file, bytes, revision: 'rev-1' }, file, 2));
	rejected(() => parseReadReceipt({ ...file, bytes: [1, 2], revision: 'rev-1' }, file, 3));
});

test('byte validation does not trust overridden byteLength or iterators', () => {
	const bytes = Uint8Array.of(1, 2, 3);
	let invoked = false;
	Object.defineProperty(bytes, 'byteLength', {
		get() {
			invoked = true;
			return 0;
		}
	});
	Object.defineProperty(bytes, Symbol.iterator, {
		value() {
			invoked = true;
			throw new Error('should not execute');
		}
	});
	rejected(() => parseReadReceipt({ ...file, bytes, revision: 'r' }, file, 2));
	const parsed = parseReadReceipt({ ...file, bytes, revision: 'r' }, file, 3);
	assert.deepEqual(parsed.bytes, Uint8Array.of(1, 2, 3));
	assert.equal(invoked, false);
	rejected(() => parseReadReceipt({ ...file, bytes: new Uint16Array(1), revision: 'r' }, file, 3));
	rejected(() => parseReadReceipt({ ...file, bytes: new Uint8Array(new SharedArrayBuffer(3)), revision: 'r' }, file, 3));
	const detached = Uint8Array.of(1);
	structuredClone(detached.buffer, { transfer: [detached.buffer] });
	rejected(() => parseReadReceipt({ ...file, bytes: detached, revision: 'r' }, file, 3));
});

test('write request retains expected disk revision and snapshot identity', () => {
	const parsed = parseWriteRequest(write, 2);
	assert.equal(parsed.expectedRevision, 'sha256:old');
	assert.equal(parsed.documentVersion, 4);
	assert.notEqual(parsed.bytes, write.bytes);
	assert.equal(parseWriteRequest({ ...write, expectedRevision: null }, 2).expectedRevision, null);
	for (const documentVersion of [-1, NaN, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		rejected(() => parseWriteRequest({ ...write, documentVersion }, 2));
	}
	rejected(() => parseWriteRequest({ ...write, expectedRevision: '' }, 2));
});

test('save receipt cannot acknowledge a different file or document version', () => {
	const receipt = { ...file, documentId: write.documentId, documentVersion: write.documentVersion, revision: 'sha256:new' };
	assert.deepEqual(parseWriteReceipt(receipt, write), receipt);
	rejected(() => parseWriteReceipt({ ...receipt, documentVersion: 3 }, write));
	rejected(() => parseWriteReceipt({ ...receipt, documentId: 'other-document' }, write));
	rejected(() => parseWriteReceipt({ ...receipt, workspaceId: 'other-workspace' }, write));
});

test('save-as requests support unsaved documents, own bytes and reject renderer-chosen destinations', () => {
	const bytes = new TextEncoder().encode('\uFEFF雪\r\n');
	const request = { workspaceId: null, bytes, documentId: 'draft', documentVersion: 0 };
	const parsed = parseSaveAsRequest(request, bytes.length);
	bytes.fill(0);
	assert.deepEqual(parsed.bytes, new TextEncoder().encode('\uFEFF雪\r\n'));
	assert.equal(parsed.workspaceId, null);
	assert.equal(Object.isFrozen(parsed), true);
	assert.equal(parseSaveAsRequest({ ...request, workspaceId: 'ws-1' }, bytes.length).workspaceId, 'ws-1');
	for (const extra of [{ path: 'chosen.tex' }, { selected: 'C:/chosen.tex' }, { expectedRevision: null }, { root: 'C:/folder' }]) {
		rejected(() => parseSaveAsRequest({ ...request, ...extra }, bytes.length));
	}
	for (const documentVersion of [-1, NaN, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) rejected(() => parseSaveAsRequest({ ...request, documentVersion }, bytes.length));
	rejected(() => parseSaveAsRequest(request, bytes.length - 1));
	rejected(() => parseSaveAsRequest({ ...request, bytes: new Uint8Array(new SharedArrayBuffer(1)) }, bytes.length));
	let invoked = false;
	const accessor = { ...request };
	Object.defineProperty(accessor, 'workspaceId', { get() { invoked = true; return null; } });
	rejected(() => parseSaveAsRequest(accessor, bytes.length));
	assert.equal(invoked, false);
});

test('save-as receipt validates cancellation and newly assigned workspace against saved snapshot identity', () => {
	const request = { workspaceId: 'previous-workspace', bytes: Uint8Array.of(1), documentId: 'draft', documentVersion: 7 };
	const workspace = { id: 'new-workspace', label: '論文', entryPath: 'saved.tex' };
	const receipt = { workspace, write: { workspaceId: workspace.id, path: workspace.entryPath, documentId: request.documentId, documentVersion: 7, revision: 'sha256:saved' } };
	assert.equal(parseSaveAsReceipt(null, request), null);
	assert.deepEqual(parseSaveAsReceipt(receipt, request), receipt);
	assert.deepEqual(parseSaveAsReceipt(receipt, { ...request, workspaceId: null }), receipt);
	const parsed = parseSaveAsReceipt(receipt, request)!;
	assert.equal(Object.isFrozen(parsed), true);
	assert.equal(Object.isFrozen(parsed.workspace), true);
	assert.equal(Object.isFrozen(parsed.write), true);
	for (const change of [{ workspaceId: 'previous-workspace' }, { path: 'other.tex' }, { documentId: 'other-document' }, { documentVersion: 6 }, { revision: '' }]) {
		rejected(() => parseSaveAsReceipt({ ...receipt, write: { ...receipt.write, ...change } }, request));
	}
	rejected(() => parseSaveAsReceipt({ ...receipt, workspace: { ...workspace, entryPath: null } }, request));
	rejected(() => parseSaveAsReceipt({ ...receipt, workspace: null }, request));
	rejected(() => parseSaveAsReceipt({ ...receipt, cancelled: false }, request));
	let invoked = false;
	const accessor = { ...receipt };
	Object.defineProperty(accessor, 'write', { get() { invoked = true; return receipt.write; } });
	rejected(() => parseSaveAsReceipt(accessor, request));
	assert.equal(invoked, false);
});

test('compile requests are closed to extra shell commands, flags and URLs', () => {
	const { runId: _unused, ...saved } = identity;
	assert.equal(parseCompileRequest({ ...saved, engine: 'managed' }).engine, 'managed');
	assert.equal(parseCompileRequest({ ...saved, engine: 'system' }).engine, 'system');
	for (const extra of [{ command: 'shell' }, { flags: ['--shell-escape'] }, { url: 'https://host' }]) {
		rejected(() => parseCompileRequest({ ...saved, engine: 'managed', ...extra }));
	}
	rejected(() => parseCompileRequest({ ...saved, engine: 'custom' }));
});

test('compile success owns PDF bytes; failure/cancellation provide no replacement PDF', () => {
	const payload = success();
	const parsed = parseCompileResult(payload, identity, limits);
	assert.equal(parsed.status, 'success');
	if (parsed.status !== 'success') throw new Error('Unexpected status');
	payload.pdf.fill(0);
	assert.equal(parsed.pdf[0], 0x25);
	assert.equal(Object.isFrozen(parsed.identity), true);
	for (const status of ['failure', 'cancelled']) {
		const result = parseCompileResult({ status, identity, log: '', diagnostics: [diagnostic] }, identity, limits);
		assert.equal('pdf' in result, false);
		assert.equal(result.diagnostics[0]?.line, 12);
	}
});

test('all compile identity fields must match the started run', () => {
	for (const field of ['runId', 'workspaceId', 'entryPath', 'documentId', 'savedRevision'] as const) {
		const payload = success();
		payload.identity[field] = 'different';
		rejected(() => parseCompileResult(payload, identity, limits));
	}
	const payload = success();
	payload.identity.documentVersion++;
	rejected(() => parseCompileResult(payload, identity, limits));
});

test('wire limits and PDF header are validated without claiming PDF parse safety', () => {
	rejected(() => parseCompileResult({ ...success(), pdf: Uint8Array.of(1, 2, 3) }, identity, limits));
	rejected(() => parseCompileResult(success(), identity, { ...limits, maxPdfBytes: 4 }));
	rejected(() => parseCompileResult({ ...success(), log: 'x'.repeat(101) }, identity, limits));
	rejected(() => parseCompileResult({ ...success(), diagnostics: Array(5).fill(diagnostic) }, identity, limits));
	rejected(() => parseCompileResult(success(), identity, { ...limits, maxLogCharacters: NaN }));
});

test('compile start identity binds request fields and rejects engine extras or accessors', () => {
	const { runId: _runId, ...expected } = identity;
	assert.deepEqual(parseCompileIdentity(identity, expected), identity);
	rejected(() => parseCompileIdentity({ ...identity, documentVersion: 5 }, expected));
	rejected(() => parseCompileIdentity({ ...identity, engine: 'managed' }, expected));
	let invoked = false;
	const record = { ...identity };
	Object.defineProperty(record, 'runId', { get() { invoked = true; return 'x'; } });
	rejected(() => parseCompileIdentity(record, expected));
	assert.equal(invoked, false);
});

test('malformed diagnostics cannot smuggle coercion code or partial coordinates', () => {
	let invoked = false;
	const severity = {
		toString() {
			invoked = true;
			return 'error';
		}
	};
	for (const entry of [
		{ ...diagnostic, severity },
		{ ...diagnostic, line: 0 },
		{ ...diagnostic, path: null },
		{ ...diagnostic, line: null, column: 2 },
		{ ...diagnostic, path: '../main.tex' }
	])
		rejected(() => parseCompileResult({ ...success(), diagnostics: [entry] }, identity, limits));
	assert.equal(invoked, false);
});

test('records and arrays reject accessors, prototypes, sparse entries and extra keys', () => {
	let invoked = false;
	const payload = success();
	Object.defineProperty(payload, 'status', {
		get() {
			invoked = true;
			return 'success';
		}
	});
	rejected(() => parseCompileResult(payload, identity, limits));
	const read = { ...file, bytes: Uint8Array.of(1), revision: 'r' };
	Object.defineProperty(read, 'revision', {
		get() {
			invoked = true;
			return 'r';
		}
	});
	rejected(() => parseReadReceipt(read, file, 1));
	const inherited = Object.assign(Object.create({ inherited: true }), { ...file, bytes: Uint8Array.of(1), revision: 'r' });
	rejected(() => parseReadReceipt(inherited, file, 1));
	rejected(() => parseCompileResult({ ...success(), diagnostics: new Array(1) }, identity, limits));
	rejected(() => parseCompileResult({ ...success(), unexpected: 1 }, identity, limits));
	assert.equal(invoked, false);
});
