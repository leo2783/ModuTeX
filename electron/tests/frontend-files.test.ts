import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FrontendFiles, SOURCE_BYTES_LIMIT } from '../src/frontend-files';

describe('real frontend workspace filesystem', () => {
	let directory: string;
	let files: FrontendFiles;
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-frontend-files-'));
		files = new FrontendFiles();
	});
	afterEach(async () => {
		files.close();
		if (!path.basename(directory).startsWith('modutex-frontend-files-') || path.dirname(directory) !== os.tmpdir()) throw new Error('Unsafe cleanup');
		await fs.rm(directory, { recursive: true, force: true });
	});
	it('reads real UTF-8 BOM and mixed EOL bytes without normalization', async () => {
		const original = Buffer.from('\uFEFF% note\r\n雪\nlast\r');
		await fs.writeFile(path.join(directory, 'main.tex'), original);
		const workspace = await files.open(path.join(directory, 'main.tex'), 'file');
		expect(workspace.entryPath).toBe('main.tex');
		const result = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		expect(Buffer.from(result.bytes)).toEqual(original);
		expect(result.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
	});
	it('creates complete new bytes exclusively and never overwrites an existing destination', async () => {
		const workspace = await files.open(directory, 'folder');
		const request = { workspaceId: workspace.id, path: 'new.tex', bytes: Buffer.from('\uFEFF雪\r\n'), expectedRevision: null, documentId: 'original', documentVersion: 2 };
		const receipt = await files.write(request);
		expect(receipt.documentVersion).toBe(2);
		expect(await fs.readFile(path.join(directory, 'new.tex'))).toEqual(request.bytes);
		await expect(files.write({ ...request, bytes: Buffer.from('overwrite') })).rejects.toThrow('FILE_CONFLICT');
		expect(await fs.readFile(path.join(directory, 'new.tex'))).toEqual(request.bytes);
		expect((await fs.readdir(directory)).some(name => name.startsWith('.modutex-save-'))).toBe(false);
	});
	it('save-as publishes a new native-selected workspace only after real disk save', async () => {
		await fs.writeFile(path.join(directory, 'old.tex'), 'old');
		const previous = await files.open(path.join(directory, 'old.tex'), 'file');
		await fs.mkdir(path.join(directory, 'target'));
		const request = { workspaceId: previous.id, bytes: Buffer.from('\uFEFFnew\r\n'), documentId: 'same-document', documentVersion: 9 };
		const result = await files.saveAs(path.join(directory, 'target', 'saved.tex'), request);
		expect(result.workspace.entryPath).toBe('saved.tex');
		expect(result.write.documentId).toBe(request.documentId);
		expect(result.write.documentVersion).toBe(9);
		expect((await files.read({ workspaceId: result.workspace.id, path: 'saved.tex' })).bytes).toEqual(new Uint8Array(request.bytes));
		expect(await fs.readFile(path.join(directory, 'old.tex'), 'utf8')).toBe('old');
		await expect(files.list(previous.id)).rejects.toThrow('STALE_WORKSPACE');
	});
	it('revoked save-as rejects before creating a file and retains current workspace on invalid selection', async () => {
		const owner = await files.open(directory, 'folder');
		const request = { workspaceId: owner.id, bytes: Buffer.from('x'), documentId: 'd', documentVersion: 0 };
		await expect(files.saveAs(path.join(directory, 'bad.js'), request)).rejects.toThrow('BAD_SELECTION');
		expect(await files.list(owner.id)).toEqual([]);
		files.close(owner.id);
		await expect(files.saveAs(path.join(directory, 'saved.tex'), request)).rejects.toThrow('STALE_WORKSPACE');
		expect(await fs.readdir(directory)).toEqual([]);
	});
	it('save-as replaces an existing destination and binds its real bytes to the original document', async () => {
		const destination = path.join(directory, 'existing.tex');
		await fs.writeFile(destination, 'previous disk version');
		const workspace = await files.open(directory, 'folder');
		const request = { workspaceId: workspace.id, bytes: Buffer.from('\uFEFF% 原創\r\n雪\nlast\r'), documentId: 'unchanged-document', documentVersion: 17 };
		const result = await files.saveAs(destination, request);
		expect(await fs.readFile(destination)).toEqual(request.bytes);
		expect(result.write).toMatchObject({ workspaceId: result.workspace.id, path: 'existing.tex', documentId: request.documentId, documentVersion: 17 });
		const reopened = await files.read({ workspaceId: result.workspace.id, path: 'existing.tex' });
		expect(reopened.revision).toBe(result.write.revision);
		expect(Buffer.from(reopened.bytes)).toEqual(request.bytes);
		expect(await fs.readdir(directory)).toEqual(['existing.tex']);
	});
	it('save-as from an unsaved document creates real bytes and a readable workspace', async () => {
		const bytes = Buffer.from('\uFEFFnew\r\n雪\n');
		const result = await files.saveAs(path.join(directory, 'new.tex'), { workspaceId: null, bytes, documentId: 'draft', documentVersion: 0 });
		expect(result.workspace.entryPath).toBe('new.tex');
		expect(result.write.documentId).toBe('draft');
		expect(result.write.documentVersion).toBe(0);
		expect(await fs.readFile(path.join(directory, 'new.tex'))).toEqual(bytes);
		expect(await files.list(result.workspace.id)).toEqual([{ path: 'new.tex', kind: 'file' }]);
	});
	it.each([false, true])('close overtakes real pending save-as without publishing bytes (unsaved=%s)', async (unsaved) => {
		const workspace = unsaved ? null : await files.open(directory, 'folder');
		const pending = files.saveAs(path.join(directory, 'late.tex'), { workspaceId: workspace?.id ?? null, bytes: Buffer.from('late'), documentId: 'd', documentVersion: 1 });
		files.close();
		await expect(pending).rejects.toThrow('STALE_WORKSPACE');
		expect(() => files.compileOwner()).toThrow('STALE_WORKSPACE');
		expect(await fs.readdir(directory)).toEqual([]);
	});
	it.each([false, true])('new open overtakes real pending save-as and retains new authority (unsaved=%s)', async (unsaved) => {
		const next = path.join(directory, 'next');
		await fs.mkdir(next);
		await fs.writeFile(path.join(next, 'next.tex'), 'next');
		const workspace = unsaved ? null : await files.open(directory, 'folder');
		const pending = files.saveAs(path.join(directory, 'late.tex'), { workspaceId: workspace?.id ?? null, bytes: Buffer.from('late'), documentId: 'd', documentVersion: 1 });
		const opening = files.open(next, 'folder');
		await expect(pending).rejects.toThrow('STALE_WORKSPACE');
		const published = await opening;
		expect(await files.list(published.id)).toEqual([{ path: 'next.tex', kind: 'file' }]);
		expect(await fs.readdir(directory)).toEqual(['next']);
	});
	it('failed real open releases its pending marker and permits saving the retained workspace', async () => {
		const workspace = await files.open(directory, 'folder');
		const staleOwner = files.saveAsOwner(workspace.id);
		await expect(files.open(path.join(directory, 'missing'), 'folder')).rejects.toMatchObject({ code: 'ENOENT' });
		expect(staleOwner).toThrow('STALE_WORKSPACE');
		expect(() => files.saveAsOwner(workspace.id)).not.toThrow();
		const result = await files.saveAs(path.join(directory, 'recovery.tex'), { workspaceId: workspace.id, bytes: Buffer.from('recovered'), documentId: 'retained', documentVersion: 1 });
		expect(await files.read({ workspaceId: result.workspace.id, path: 'recovery.tex' })).toMatchObject({ revision: result.write.revision });
	});
	it('rejects an unsaved native dialog result whose captured owner was revoked', async () => {
		const pickerOwner = files.saveAsOwner(null);
		files.close();
		await expect(files.saveAs(path.join(directory, 'late-dialog.tex'), { workspaceId: null, bytes: Buffer.from('late'), documentId: 'draft', documentVersion: 1 }, pickerOwner)).rejects.toThrow('STALE_WORKSPACE');
		expect(await fs.readdir(directory)).toEqual([]);
		expect(() => files.compileOwner()).toThrow('STALE_WORKSPACE');
	});
	it('save-as refuses native-selected junction parents and retains the previous workspace', async () => {
		const actual = path.join(directory, 'actual');
		const linked = path.join(directory, 'linked');
		await fs.mkdir(actual);
		await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
		const workspace = await files.open(directory, 'folder');
		await expect(files.saveAs(path.join(linked, 'unsafe.tex'), { workspaceId: workspace.id, bytes: Buffer.from('unsafe'), documentId: 'd', documentVersion: 1 })).rejects.toThrow('LINK_NOT_ALLOWED');
		expect(await fs.readdir(actual)).toEqual([]);
		expect(await files.list(workspace.id)).toEqual([{ path: 'actual', kind: 'directory' }]);
	});
	it('save-as respects a sibling compile reservation and releases after failure', async () => {
		const peer = new FrontendFiles();
		const workspace = await files.open(directory, 'folder');
		const reservation = files.reserveCompilation(workspace.id);
		const request = { workspaceId: null, bytes: Buffer.from('new'), documentId: 'd', documentVersion: 1 };
		try {
			await expect(peer.saveAs(path.join(directory, 'saved.tex'), request)).rejects.toThrow('BUSY');
			expect(await fs.readdir(directory)).toEqual([]);
			reservation();
			const saved = await peer.saveAs(path.join(directory, 'saved.tex'), request);
			expect(await peer.list(saved.workspace.id)).toEqual([{ path: 'saved.tex', kind: 'file' }]);
		} finally { reservation(); peer.close(); }
	});
	it('save-as and ordinary saves share one destination lock across real window owners', async () => {
		let entered!: () => void, resume!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const barrier = new Promise<void>((resolve) => { resume = resolve; });
		class PausedWriter extends FrontendFiles {
			pause = false;
			override async read(value: unknown) {
				if (this.pause) { this.pause = false; entered(); await barrier; }
				return super.read(value);
			}
		}
		const writer = new PausedWriter();
		const destination = path.join(directory, 'shared.tex');
		await fs.writeFile(destination, 'initial');
		const workspace = await writer.open(directory, 'folder');
		const old = await writer.read({ workspaceId: workspace.id, path: 'shared.tex' });
		writer.pause = true;
		const pending = writer.write({ workspaceId: workspace.id, path: 'shared.tex', bytes: Buffer.from('writer'), expectedRevision: old.revision, documentId: 'writer', documentVersion: 1 });
		try {
			await waiting;
			await expect(files.saveAs(destination, { workspaceId: null, bytes: Buffer.from('save-as'), documentId: 'draft', documentVersion: 2 })).rejects.toThrow('BUSY');
			expect(await fs.readFile(destination, 'utf8')).toBe('initial');
			resume(); await pending;
			const saved = await files.saveAs(destination, { workspaceId: null, bytes: Buffer.from('retry'), documentId: 'draft', documentVersion: 2 });
			expect(saved.write.documentId).toBe('draft');
			expect(await fs.readFile(destination, 'utf8')).toBe('retry');
			expect(await fs.readdir(directory)).toEqual(['shared.tex']);
		} finally { resume(); await pending; writer.close(); }
	});
	it('does not grant another workspace identity or ambiguous paths', async () => {
		const workspace = await files.open(directory, 'folder');
		await expect(files.read({ workspaceId: 'other', path: 'main.tex' })).rejects.toThrow('STALE_WORKSPACE');
		for (const candidate of ['../outside.tex', 'C:/outside.tex', '/outside.tex', 'sub/../main.tex', 'nul.tex', 'main.tex:stream']) {
			await expect(files.read({ workspaceId: workspace.id, path: candidate })).rejects.toThrow();
		}
	});
	it('revokes prior handles on workspace switch and close', async () => {
		const first = await files.open(directory, 'folder');
		const second = await files.open(directory, 'folder');
		await expect(files.list(first.id)).rejects.toThrow('STALE_WORKSPACE');
		files.close(second.id);
		await expect(files.list(second.id)).rejects.toThrow('STALE_WORKSPACE');
	});
	it('rejects oversized input before reading it', async () => {
		const handle = await fs.open(path.join(directory, 'large.tex'), 'w');
		await handle.truncate(SOURCE_BYTES_LIMIT + 1);
		await handle.close();
		const workspace = await files.open(directory, 'folder');
		await expect(files.read({ workspaceId: workspace.id, path: 'large.tex' })).rejects.toThrow('FILE_TOO_LARGE');
	});
	it('does not resurrect a workspace when close overtakes real pending open', async () => {
		const previous = await files.open(directory, 'folder');
		const pending = files.open(directory, 'folder');
		files.close(previous.id);
		await expect(pending).rejects.toThrow('STALE_WORKSPACE');
		expect(() => files.compileOwner()).toThrow('STALE_WORKSPACE');
		await expect(files.list(previous.id)).rejects.toThrow('STALE_WORKSPACE');
		const reopened = await files.open(directory, 'folder');
		expect(await files.list(reopened.id)).toEqual([]);
	});
	it('publishes only the latest of real competing workspace opens', async () => {
		const second = path.join(directory, 'second');
		await fs.mkdir(second);
		await fs.writeFile(path.join(second, 'new.tex'), 'new');
		const results = await Promise.allSettled([files.open(directory, 'folder'), files.open(second, 'folder')]);
		expect(results[0].status).toBe('rejected');
		if (results[0].status === 'rejected') expect(results[0].reason.message).toBe('STALE_WORKSPACE');
		expect(results[1].status).toBe('fulfilled');
		if (results[1].status !== 'fulfilled') throw results[1].reason;
		expect(await files.list(results[1].value.id)).toEqual([{ path: 'new.tex', kind: 'file' }]);
	});
	it('lists actual nested TeX and PDF paths without private build directories', async () => {
		await fs.mkdir(path.join(directory, 'chapters'));
		await fs.mkdir(path.join(directory, '.git'));
		await fs.writeFile(path.join(directory, 'chapters', 'one.tex'), 'one');
		await fs.writeFile(path.join(directory, '.git', 'secret.tex'), 'private');
		await fs.writeFile(path.join(directory, 'preview.pdf'), '%PDF-1.7');
		await fs.writeFile(path.join(directory, 'ignore.js'), 'x');
		const workspace = await files.open(directory, 'folder');
		expect(await files.list(workspace.id)).toEqual([
			{ path: 'chapters', kind: 'directory' }, { path: 'chapters/one.tex', kind: 'file' }, { path: 'preview.pdf', kind: 'file' }
		]);
	});
	it('rejects a real directory junction instead of following it', async () => {
		await fs.mkdir(path.join(directory, 'actual'));
		await fs.writeFile(path.join(directory, 'actual', 'main.tex'), 'content');
		await fs.symlink(path.join(directory, 'actual'), path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		const workspace = await files.open(directory, 'folder');
		await expect(files.read({ workspaceId: workspace.id, path: 'linked/main.tex' })).rejects.toThrow('LINK_NOT_ALLOWED');
		expect((await files.list(workspace.id)).some((entry) => entry.path.startsWith('linked'))).toBe(false);
	});
	it('rejects a real junction to a sibling outside the selected root', async () => {
		await fs.mkdir(path.join(directory, 'workspace'));
		await fs.mkdir(path.join(directory, 'outside'));
		await fs.writeFile(path.join(directory, 'outside', 'private.tex'), 'must not escape');
		await fs.symlink(path.join(directory, 'outside'), path.join(directory, 'workspace', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		const workspace = await files.open(path.join(directory, 'workspace'), 'folder');
		await expect(files.read({ workspaceId: workspace.id, path: 'linked/private.tex' })).rejects.toThrow('LINK_NOT_ALLOWED');
		expect(await files.list(workspace.id)).toEqual([]);
	});
	it('revokes access when the selected directory is replaced at the same path', async () => {
		const root = path.join(directory, 'workspace');
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, 'main.tex'), 'original');
		const workspace = await files.open(root, 'folder');
		await fs.rename(root, path.join(directory, 'previous'));
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, 'main.tex'), 'replacement');
		await expect(files.read({ workspaceId: workspace.id, path: 'main.tex' })).rejects.toThrow('STALE_WORKSPACE');
		await expect(files.list(workspace.id)).rejects.toThrow('STALE_WORKSPACE');
	});
	it('saves actual bytes atomically and reopens BOM/mixed EOL without normalization', async () => {
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, '\uFEFFa\r\n雪\n');
		const workspace = await files.open(file, 'file');
		const read = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		const content = Buffer.from('\uFEFFchanged\r\n雪\n');
		const saved = await files.write({ workspaceId: workspace.id, path: 'main.tex', bytes: content,
			expectedRevision: read.revision, documentId: 'test-document', documentVersion: 3 });
		expect(await fs.readFile(file)).toEqual(content);
		expect(saved.documentVersion).toBe(3);
		expect((await files.read({ workspaceId: workspace.id, path: 'main.tex' })).revision).toBe(saved.revision);
		expect(await fs.readdir(directory)).toEqual(['main.tex']);
	});
	it('rejects stale revision and preserves an external edit', async () => {
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, 'initial');
		const workspace = await files.open(file, 'file');
		const read = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		await fs.writeFile(file, 'external');
		await expect(files.write({ workspaceId: workspace.id, path: 'main.tex', bytes: Buffer.from('overwrite'),
			expectedRevision: read.revision, documentId: 'test-document', documentVersion: 1 })).rejects.toThrow('FILE_CONFLICT');
		expect(await fs.readFile(file, 'utf8')).toBe('external');
		expect(await fs.readdir(directory)).toEqual(['main.tex']);
	});
	it('serializes actual competing save requests without mixing their bytes', async () => {
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, 'initial');
		const workspace = await files.open(file, 'file');
		const read = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		const request = { workspaceId: workspace.id, path: 'main.tex', expectedRevision: read.revision,
			documentId: 'test-document', documentVersion: 1 };
		const results = await Promise.allSettled([
			files.write({ ...request, bytes: Buffer.from('first') }),
			files.write({ ...request, bytes: Buffer.from('second') })
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const rejected = results.find((result) => result.status === 'rejected');
		expect(rejected?.status === 'rejected' && rejected.reason.message).toBe('BUSY');
		expect(['first', 'second']).toContain(await fs.readFile(file, 'utf8'));
		expect(await fs.readdir(directory)).toEqual(['main.tex']);
	});
	it('revokes a save started before workspace close without changing disk', async () => {
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, 'initial');
		const workspace = await files.open(file, 'file');
		const read = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		const pending = files.write({ workspaceId: workspace.id, path: 'main.tex', bytes: Buffer.from('later'),
			expectedRevision: read.revision, documentId: 'test-document', documentVersion: 1 });
		files.close(workspace.id);
		await expect(pending).rejects.toThrow('STALE_WORKSPACE');
		expect(await fs.readFile(file, 'utf8')).toBe('initial');
	});
	it('protects one real destination shared by distinct window owners and releases its lock', async () => {
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, 'initial');
		const peer = new FrontendFiles();
		try {
			const first = await files.open(file, 'file');
			const second = await peer.open(directory, 'folder');
			const read = await files.read({ workspaceId: first.id, path: 'main.tex' });
			const common = { path: 'main.tex', expectedRevision: read.revision, documentId: 'test-document', documentVersion: 1 };
			const firstBytes = Buffer.from('first '.repeat(200000));
			const secondBytes = Buffer.from('second '.repeat(200000));
			const results = await Promise.allSettled([
				files.write({ ...common, workspaceId: first.id, bytes: firstBytes }),
				peer.write({ ...common, workspaceId: second.id, bytes: secondBytes })
			]);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			const rejected = results.find((result) => result.status === 'rejected');
			expect(rejected?.status === 'rejected' && rejected.reason.message).toBe('BUSY');
			const disk = await fs.readFile(file);
			expect(disk.equals(firstBytes) || disk.equals(secondBytes)).toBe(true);
			const latest = await peer.read({ workspaceId: second.id, path: 'main.tex' });
			await peer.write({ ...common, workspaceId: second.id, expectedRevision: latest.revision, bytes: Buffer.from('retry') });
			expect(await fs.readFile(file, 'utf8')).toBe('retry');
			expect(await fs.readdir(directory)).toEqual(['main.tex']);
		} finally { peer.close(); }
	});
	it('does not serialize different real files across window owners', async () => {
		await fs.writeFile(path.join(directory, 'first.tex'), 'first');
		await fs.writeFile(path.join(directory, 'second.tex'), 'second');
		const peer = new FrontendFiles();
		try {
			const first = await files.open(directory, 'folder');
			const second = await peer.open(directory, 'folder');
			const a = await files.read({ workspaceId: first.id, path: 'first.tex' });
			const b = await peer.read({ workspaceId: second.id, path: 'second.tex' });
			const common = { documentId: 'test-document', documentVersion: 1 };
			await Promise.all([
				files.write({ ...common, workspaceId: first.id, path: 'first.tex', expectedRevision: a.revision, bytes: Buffer.from('a') }),
				peer.write({ ...common, workspaceId: second.id, path: 'second.tex', expectedRevision: b.revision, bytes: Buffer.from('b') })
			]);
			expect(await fs.readFile(path.join(directory, 'first.tex'), 'utf8')).toBe('a');
			expect(await fs.readFile(path.join(directory, 'second.tex'), 'utf8')).toBe('b');
		} finally { peer.close(); }
	});
	it('releases shared destination ownership after revision conflict', async () => {
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, 'initial');
		const peer = new FrontendFiles();
		try {
			const first = await files.open(directory, 'folder');
			const second = await peer.open(directory, 'folder');
			const old = await files.read({ workspaceId: first.id, path: 'main.tex' });
			await fs.writeFile(file, 'external');
			const common = { path: 'main.tex', documentId: 'test-document', documentVersion: 1, bytes: Buffer.from('new') };
			await expect(files.write({ ...common, workspaceId: first.id, expectedRevision: old.revision })).rejects.toThrow('FILE_CONFLICT');
			const latest = await peer.read({ workspaceId: second.id, path: 'main.tex' });
			await peer.write({ ...common, workspaceId: second.id, expectedRevision: latest.revision });
			expect(await fs.readFile(file, 'utf8')).toBe('new');
		} finally { peer.close(); }
	});
	it('creates without revision but rejects a non-TeX destination without publishing bytes', async () => {
		const workspace = await files.open(directory, 'folder');
		const request = { workspaceId: workspace.id, path: 'new.tex', bytes: Buffer.from('x'),
			expectedRevision: null, documentId: 'test-document', documentVersion: 1 };
		const receipt = await files.write(request);
		expect(receipt.documentId).toBe(request.documentId);
		expect(await fs.readFile(path.join(directory, 'new.tex'))).toEqual(request.bytes);
		await expect(files.write({ ...request, path: 'script.js' })).rejects.toThrow('FILE_TYPE');
		expect(await fs.readdir(directory)).toEqual(['new.tex']);
	});
	it('rejects accessor and extra field inputs without executing accessors', async () => {
		let called = false;
		await expect(files.read({ get workspaceId() { called = true; return 'x'; }, path: 'a.tex' })).rejects.toThrow('BAD_FILE');
		expect(called).toBe(false);
		await expect(files.read({ workspaceId: 'x', path: 'a.tex', root: directory })).rejects.toThrow('BAD_FILE');
	});
	it('excludes sibling-window saves and overlapping compile roots until explicit release', async () => {
		const child = path.join(directory, 'chapter');
		await fs.mkdir(child);
		const file = path.join(child, 'main.tex');
		await fs.writeFile(file, 'initial');
		const peer = new FrontendFiles();
		let release: (() => void) | undefined;
		try {
			const workspace = await files.open(directory, 'folder');
			const nested = await peer.open(child, 'folder');
			const read = await peer.read({ workspaceId: nested.id, path: 'main.tex' });
			release = files.reserveCompilation(workspace.id);
			expect(() => peer.reserveCompilation(nested.id)).toThrow('BUSY');
			const request = { workspaceId: nested.id, path: 'main.tex', bytes: Buffer.from('new'),
				expectedRevision: read.revision, documentId: 'test', documentVersion: 1 };
			await expect(peer.write(request)).rejects.toThrow('BUSY');
			expect(await fs.readFile(file, 'utf8')).toBe('initial');
			files.close(workspace.id);
			await expect(peer.write(request)).rejects.toThrow('BUSY'); // Closing does not release an active engine's scope early.
			release(); release();
			await peer.write(request);
			expect(await fs.readFile(file, 'utf8')).toBe('new');
			const next = peer.reserveCompilation(nested.id);
			release(); // An old release cannot revoke the newer scope.
			expect(() => peer.reserveCompilation(nested.id)).toThrow('BUSY');
			next();
		} finally { release?.(); peer.close(); }
	});
	it('rejects compile acquisition during a real save and allows it after save completion', async () => {
		let entered!: () => void, resume!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const barrier = new Promise<void>((resolve) => { resume = resolve; });
		// Pause scheduling only; every read/write still executes on the actual filesystem.
		class PausedFiles extends FrontendFiles {
			pause = false;
			override async read(value: unknown) {
				if (this.pause) { this.pause = false; entered(); await barrier; }
				return super.read(value);
			}
		}
		const writer = new PausedFiles();
		const file = path.join(directory, 'main.tex');
		await fs.writeFile(file, 'initial');
		const workspace = await files.open(directory, 'folder');
		const other = await writer.open(directory, 'folder');
		const read = await writer.read({ workspaceId: other.id, path: 'main.tex' });
		writer.pause = true;
		const pending = writer.write({ workspaceId: other.id, path: 'main.tex', expectedRevision: read.revision,
			documentId: 'test', documentVersion: 1, bytes: Buffer.from('saved') });
		try {
			await waiting;
			expect(() => files.reserveCompilation(workspace.id)).toThrow('BUSY');
			resume(); await pending;
			expect(await fs.readFile(file, 'utf8')).toBe('saved');
			const release = files.reserveCompilation(workspace.id);
			release();
		} finally { resume(); await pending; writer.close(); }
	});
});
