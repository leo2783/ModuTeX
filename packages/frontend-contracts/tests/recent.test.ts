import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError, parseRecentDocuments, recentDocumentId } from '../src/index.ts';

const uuid = (index = 1) => '12345678-abcd-4def-8123-' + String(index).padStart(12, '0');
const entry = (index = 1) => ({ id: uuid(index), label: '論文😀', entryPath: '第1章.tex', openedAt: 0 });
const rejects = (operation: () => unknown) => assert.throws(operation, ContractError);

test('recent documents accept empty and 20-entry MRU payloads without changing order or exposing paths', () => {
	assert.deepEqual(parseRecentDocuments([]), []);
	const entries = Array.from({ length: 20 }, (_, index) => ({ ...entry(index + 1), openedAt: 20 - index, entryPath: index % 2 ? null : 'main.TEX' }));
	const parsed = parseRecentDocuments(entries);
	assert.deepEqual(parsed, entries);
	assert.deepEqual(parsed.map((item) => item.id), entries.map((item) => item.id));
	assert.equal(parsed[0]!.openedAt, 20);
	assert.equal(parsed[1]!.entryPath, null);
	for (const item of parsed) assert.deepEqual(Object.keys(item).sort(), ['entryPath', 'id', 'label', 'openedAt']);
	assert.deepEqual(parseRecentDocuments([Object.assign(Object.create(null), entry())]), [entry()]);
});

test('recent document identifiers require exact lowercase UUIDv4 without coercion', () => {
	assert.equal(recentDocumentId(uuid()), uuid());
	for (const variant of ['8', '9', 'a', 'b']) assert.equal(recentDocumentId('12345678-abcd-4def-' + variant + '123-000000000001').length, 36);
	let invoked = false;
	for (const value of [uuid().toUpperCase(), uuid().replace('-4def-', '-3def-'), uuid().replace('-8123-', '-7123-'), uuid() + ' ',
		'../main.tex', 'C:/main.tex', 'https://example.org/main.tex', '', null, 1, [], { toString() { invoked = true; return uuid(); } }]) rejects(() => recentDocumentId(value));
	assert.equal(invoked, false);
});

test('recent list rejects a 21st entry and duplicate IDs rather than silently truncating or merging', () => {
	rejects(() => parseRecentDocuments(Array.from({ length: 21 }, (_, index) => entry(index + 1))));
	rejects(() => parseRecentDocuments([entry(), { ...entry(), label: 'other', entryPath: 'other.tex' }]));
});

test('display-name bounds count UTF-16 units and reject control characters or path-shaped names', () => {
	assert.equal(parseRecentDocuments([{ ...entry(), label: '雪'.repeat(4096) }])[0]!.label.length, 4096);
	for (const label of ['', 'x'.repeat(4097), 'a/b', 'a\\b', '\u0000', 'line\nname', 'line\rname', '\tname', 'name\u007f', null, 1, {}]) {
		rejects(() => parseRecentDocuments([{ ...entry(), label }]));
	}
});

test('entry paths accept only a bounded safe single TeX filename or null', () => {
	for (const entryPath of [null, '論文😀.tex', 'MAIN.TEX', 'literal%2e%2e.tex', 'a'.repeat(4092) + '.tex']) {
		assert.equal(parseRecentDocuments([{ ...entry(), entryPath }])[0]!.entryPath, entryPath);
	}
	for (const entryPath of ['', 'a'.repeat(4093) + '.tex', '../outside.tex', 'folder/main.tex', '/main.tex', 'C:/main.tex', 'C:\\main.tex',
		'\\\\server\\main.tex', 'main.tex:stream', 'nul.tex', 'COM1.tex', 'main.tex.', 'main.tex ', './main.tex', 'main.js',
		'main\u0000.tex', 'main\n.tex', 'main\u007f.tex', undefined, {}, 1]) rejects(() => parseRecentDocuments([{ ...entry(), entryPath }]));
});

test('recent timestamps must be nonnegative safe integers without date or string coercion', () => {
	for (const openedAt of [0, Number.MAX_SAFE_INTEGER]) assert.equal(parseRecentDocuments([{ ...entry(), openedAt }])[0]!.openedAt, openedAt);
	for (const openedAt of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '123', null, undefined, new Date(0)]) {
		rejects(() => parseRecentDocuments([{ ...entry(), openedAt }]));
	}
});

test('recent parser returns independently owned frozen records and a frozen array', () => {
	const payload = [entry()];
	const parsed = parseRecentDocuments(payload);
	assert.notEqual(parsed, payload); assert.notEqual(parsed[0], payload[0]);
	assert.equal(Object.isFrozen(parsed), true); assert.equal(Object.isFrozen(parsed[0]), true);
	payload[0]!.label = 'changed'; payload[0]!.openedAt = 99; payload.push(entry(2));
	assert.deepEqual(parsed, [entry()]);
	assert.equal(Reflect.set(parsed[0]!, 'label', 'injected'), false);
	assert.equal(Reflect.set(parsed, '0', entry(3)), false);
	assert.equal(Object.isFrozen(parseRecentDocuments([])), true);
});

test('recent records reject getters, classes, inherited prototypes and extra data fields without executing code', () => {
	let invoked = false;
	for (const field of ['id', 'label', 'entryPath', 'openedAt']) {
		const accessor = { ...entry() };
		Object.defineProperty(accessor, field, { get() { invoked = true; return entry()[field as keyof ReturnType<typeof entry>]; } });
		rejects(() => parseRecentDocuments([accessor]));
	}
	class RecentRecord { id = uuid(); label = '論文'; entryPath = 'main.tex'; openedAt = 0; }
	rejects(() => parseRecentDocuments([new RecentRecord()]));
	rejects(() => parseRecentDocuments([Object.assign(Object.create({ inherited: true }), entry())]));
	for (const extra of [{ selected: 'C:/private/main.tex' }, { kind: 'file' }, { workspaceId: 'ws' }, { root: 'C:/private' }]) rejects(() => parseRecentDocuments([{ ...entry(), ...extra }]));
	const symbolic = { ...entry(), [Symbol('hidden')]: true }; rejects(() => parseRecentDocuments([symbolic]));
	assert.equal(invoked, false);
});

test('recent arrays reject sparse, augmented and accessor-bearing inputs without executing getters or iterators', () => {
	let invoked = false;
	const accessor = [entry()];
	Object.defineProperty(accessor, '0', { get() { invoked = true; return entry(); } });
	rejects(() => parseRecentDocuments(accessor));
	rejects(() => parseRecentDocuments(new Array(1)));
	rejects(() => parseRecentDocuments(Object.assign([entry()], { extra: true })));
	const symbolic = [entry()];
	Object.defineProperty(symbolic, Symbol.iterator, { get() { invoked = true; return Array.prototype[Symbol.iterator]; } });
	rejects(() => parseRecentDocuments(symbolic));
	for (const value of [null, {}, '[]', { 0: entry(), length: 1 }]) rejects(() => parseRecentDocuments(value));
	assert.equal(invoked, false);
});

test('recent arrays reject nonstandard class/prototype containers at the wire boundary', () => {
	class RecentArray extends Array<ReturnType<typeof entry>> {}
	const subclass = new RecentArray(); subclass.push(entry());
	rejects(() => parseRecentDocuments(subclass));
	const inherited = [entry()];
	Object.setPrototypeOf(inherited, Object.create(Array.prototype));
	rejects(() => parseRecentDocuments(inherited));
});
