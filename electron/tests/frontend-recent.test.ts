import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { FrontendRecent } from '../src/frontend-recent';
import { FrontendFiles } from '../src/frontend-files';

describe('real recent-document persistence filesystem', () => {
	let directory: string, store: string, recent: FrontendRecent;
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-frontend-recent-'));
		store = path.join(directory, 'data', 'recent.json');
		recent = new FrontendRecent(store);
	});
	afterEach(async () => {
		if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('modutex-frontend-recent-')) throw new Error('Unsafe cleanup');
		await fs.rm(directory, { recursive: true, force: true });
	});
	async function tex(name: string) {
		const selected = path.join(directory, name + '.tex');
		await fs.writeFile(selected, 'original ' + name);
		return selected;
	}
	async function stored(value: unknown) {
		await fs.mkdir(path.dirname(store), { recursive: true });
		await fs.writeFile(store, JSON.stringify(value), 'utf8');
	}

	it('starts empty, persists file/folder choices and rereads disk across sequential instances without exporting paths', async () => {
		expect(await recent.list()).toEqual([]);
		const selected = await tex('論文');
		const file = await recent.remember(selected, 'file');
		expect(file).toEqual({ id: expect.stringMatching(/^[a-f0-9-]{36}$/), label: path.basename(directory), entryPath: '論文.tex', openedAt: expect.any(Number) });
		expect(Object.isFrozen(file)).toBe(true);
		expect(Object.keys(file).sort()).toEqual(['entryPath', 'id', 'label', 'openedAt']);
		expect(JSON.stringify(file)).not.toContain(directory);
		const folder = await recent.remember(directory, 'folder');
		expect(folder.entryPath).toBeNull();
		const reopened = new FrontendRecent(store);
		expect(await reopened.list()).toEqual([folder, file]);
		expect(await reopened.resolve(file.id)).toEqual({ selected: await fs.realpath(selected), kind: 'file' });
		expect(await reopened.resolve(folder.id)).toEqual({ selected: await fs.realpath(directory), kind: 'folder' });
		await reopened.remove(file.id);
		expect(await recent.list()).toEqual([folder]); // Existing instance rereads disk, not a stale memory snapshot.
		const disk = JSON.parse(await fs.readFile(store, 'utf8'));
		expect(disk.version).toBe(1); expect(disk.entries).toHaveLength(1);
		expect(await fs.readdir(path.dirname(store))).toEqual(['recent.json']);
	});

	it('moves an existing selection to MRU, preserves its ID and deduplicates actual Windows casing', async () => {
		const selected = await tex('Case');
		const first = await recent.remember(selected, 'file');
		await recent.remember(await tex('other'), 'file');
		const casing = process.platform === 'win32' ? selected.toUpperCase() : selected;
		const latest = await recent.remember(casing, 'file');
		expect(latest.id).toBe(first.id);
		expect(latest.openedAt).toBeGreaterThanOrEqual(first.openedAt);
		const entries = await recent.list();
		expect(entries).toHaveLength(2); expect(entries[0]!.id).toBe(first.id);
	});

	it('serializes real same-instance remember/remove operations without lost updates', async () => {
		const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map(tex));
		const [first, second] = await Promise.all([recent.remember(a!, 'file'), recent.remember(b!, 'file')]);
		const [third, , fourth] = await Promise.all([recent.remember(c!, 'file'), recent.remove(first.id), recent.remember(d!, 'file')]);
		expect((await recent.list()).map((entry) => entry.id)).toEqual([fourth.id, third.id, second.id]);
		expect((await new FrontendRecent(store).list()).map((entry) => entry.id)).toEqual([fourth.id, third.id, second.id]);
		await expect(recent.resolve(first.id)).rejects.toThrow('RECENT_NOT_FOUND');
		expect(await fs.readdir(path.dirname(store))).toEqual(['recent.json']);
	});

	it('evicts only the oldest entries at the 20-item MRU bound', async () => {
		const selections = await Promise.all(Array.from({ length: 25 }, (_, index) => tex('item-' + index)));
		const entries = await Promise.all(selections.map((selected) => recent.remember(selected, 'file')));
		expect((await recent.list()).map((entry) => entry.id)).toEqual(entries.slice(-20).reverse().map((entry) => entry.id));
		await expect(recent.resolve(entries[0]!.id)).rejects.toThrow('RECENT_NOT_FOUND');
		expect((await new FrontendRecent(store).list())).toHaveLength(20);
	});

	it('publishes complete atomic JSON while real readers overlap queued mutations', async () => {
		await recent.remember(await tex('seed'), 'file');
		const selections = await Promise.all(Array.from({ length: 15 }, (_, index) => tex('atomic-' + index)));
		const writes = Promise.allSettled(selections.map((selected) => recent.remember(selected, 'file')));
		for (let index = 0; index < 40; index++) {
			const value = JSON.parse(await fs.readFile(store, 'utf8'));
			expect(value.version).toBe(1); expect(Array.isArray(value.entries)).toBe(true);
			expect(value.entries.length).toBeLessThanOrEqual(20);
		}
		const results = await writes;
		for (const result of results) if (result.status === 'rejected') throw result.reason;
		expect(await recent.list()).toHaveLength(16);
		expect(await fs.readdir(path.dirname(store))).toEqual(['recent.json']);
	});

	it('retains missing documents until explicit removal and delegates missing-path validation to the file service', async () => {
		const selected = await tex('missing');
		const entry = await recent.remember(selected, 'file');
		await fs.unlink(selected);
		expect(await new FrontendRecent(store).list()).toEqual([entry]);
		const resolved = await recent.resolve(entry.id);
		expect(resolved).toEqual({ selected, kind: 'file' });
		const files = new FrontendFiles();
		try { await expect(files.open(resolved.selected, resolved.kind)).rejects.toMatchObject({ code: 'ENOENT' }); }
		finally { files.close(); }
		expect(await recent.list()).toEqual([entry]);
		await recent.remove(entry.id); expect(await recent.list()).toEqual([]);
	});

	it('rejects unknown IDs and renderer path-shaped payloads without granting path authority or losing the queue', async () => {
		const selected = await tex('safe');
		const entry = await recent.remember(selected, 'file');
		for (const value of [randomUUID(), entry.id.toUpperCase(), selected, '../safe.tex', '', { id: entry.id, selected }, null] as unknown[]) {
			await expect(recent.resolve(value as string)).rejects.toThrow('RECENT_NOT_FOUND');
			await expect(recent.remove(value as string)).rejects.toThrow('RECENT_NOT_FOUND');
		}
		expect(await recent.list()).toEqual([entry]);
		await recent.remove(entry.id); expect(await recent.list()).toEqual([]);
	});

	it('rejects non-absolute, oversized, NUL and non-TeX selections before persisting them', async () => {
		await fs.writeFile(path.join(directory, 'script.js'), 'not TeX');
		for (const selected of ['relative.tex', path.join(directory, 'script.js'), directory + '\0bad.tex', 'x'.repeat(4097)]) {
			await expect(recent.remember(selected, 'file')).rejects.toThrow('BAD_SELECTION');
		}
		expect(() => new FrontendRecent('relative.json')).toThrow('BAD_RECENT_STORE');
		expect(await recent.list()).toEqual([]);
		await expect(fs.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('rejects corrupted and malicious bounded records without replacing them on mutation', async () => {
		const selected = await tex('valid');
		const valid = { id: randomUUID(), selected, kind: 'file', openedAt: 1 };
		for (const value of [null, { version: 2, entries: [] }, { version: 1, entries: {} },
			{ version: 1, entries: Array.from({ length: 21 }, (_, index) => ({ ...valid, id: randomUUID(), selected: path.join(directory, index + '.tex') })) },
			...[{ id: 'not-a-uuid' }, { selected: '../outside.tex' }, { selected: 'x'.repeat(4097) }, { selected: directory + '\0bad.tex' },
				{ kind: 'shell' }, { openedAt: -1 }, { openedAt: Number.MAX_SAFE_INTEGER + 1 }, { selected: path.join(directory, 'script.js') }].map((change) => ({ version: 1, entries: [{ ...valid, ...change }] })),
			{ version: 1, entries: [valid, { ...valid }] },
			{ version: 1, entries: [valid, { ...valid, id: randomUUID() }] }
		]) {
			await stored(value);
			const original = await fs.readFile(store);
			await expect(recent.list()).rejects.toThrow('RECENT_CORRUPT');
			await expect(recent.remember(selected, 'file')).rejects.toThrow('RECENT_CORRUPT');
			expect(await fs.readFile(store)).toEqual(original);
		}
		await stored({ version: 1, entries: [] });
		expect((await recent.remember(selected, 'file')).entryPath).toBe('valid.tex');
	});

	it('rejects oversized raw JSON, broken JSON and a real directory junction used as the storage file', async () => {
		await fs.mkdir(path.dirname(store), { recursive: true });
		for (const raw of ['{broken', ' '.repeat(256 * 1024 + 1)]) {
			await fs.writeFile(store, raw);
			await expect(recent.list()).rejects.toThrow('RECENT_CORRUPT');
		}
		await fs.unlink(store);
		await fs.mkdir(path.join(directory, 'linked-target'));
		await fs.symlink(path.join(directory, 'linked-target'), store, process.platform === 'win32' ? 'junction' : 'dir');
		await expect(recent.list()).rejects.toThrow('RECENT_CORRUPT');
		expect(await fs.readdir(path.join(directory, 'linked-target'))).toEqual([]);
	});
});
