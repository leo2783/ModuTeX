import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { desktopFiles } from '../../src/features/files/desktop.ts';

test('renderer lifetime revokes late results backed by the actual host filesystem', { timeout: 15000 }, async (t) => {
	const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'error' });
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const directory = await mkdtemp(join(tmpdir(), 'modutex-lifetime-'));
	const { FrontendFiles } = await server.ssrLoadModule(fileURLToPath(new URL('../../../../electron/src/frontend-files.ts', import.meta.url)));
	const files = new FrontendFiles();
	try {
		const path = join(directory, 'main.tex'); await writeFile(path, 'original');
		const recentId = '123e4567-e89b-42d3-a456-426614174000';
		for (const operation of ['open', 'recent', 'read', 'write', 'saveAs'] as const) await t.test(operation, async () => {
			const owner = await files.open(path, 'file');
			const ref = { workspaceId: owner.id, path: 'main.tex' };
			let entered!: () => void, resume!: () => void;
			const waiting = new Promise<void>((resolve) => { entered = resolve; });
			const barrier = new Promise<void>((resolve) => { resume = resolve; });
			// Only delay delivery; bytes and revisions come from actual host operations.
			const delay = async <T>(value: T): Promise<T> => { entered(); await barrier; return value; };
			const native = {
				openWorkspace: async () => delay(await files.open(path, 'file')),
				// This maps one fixture ID to the actual host open operation; it does not assert native recent IPC.
				openRecent: async (id: string) => {
					assert.equal(id, recentId);
					return delay(await files.open(path, 'file'));
				},
				readFile: async (ref: unknown) => delay(await files.read(ref)),
				writeFile: async (request: unknown) => delay(await files.write(request)),
				saveAs: async (request: unknown) => delay(await files.saveAs(join(directory, 'copied.tex'), request)),
				closeWorkspace: async (id: string) => files.close(id)
			};
			Object.defineProperty(globalThis, 'window', { configurable: true, value: { modutexFiles: native } });
			const controller = new AbortController(), port = desktopFiles(controller.signal)!;
			const receipt = await files.read(ref);
			const pending = operation === 'open' ? port.openWorkspace('file')
				: operation === 'recent' ? port.openRecent(recentId)
				: operation === 'read' ? port.readFile(ref) : operation === 'saveAs' ? port.saveAs({ workspaceId: owner.id,
					bytes: new TextEncoder().encode('copied'), documentId: 'original', documentVersion: 1 }) : port.writeFile({ ...ref,
				bytes: new TextEncoder().encode('saved'), expectedRevision: receipt.revision, documentId: 'original', documentVersion: 1 });
			try {
				await waiting; controller.abort(); resume();
				await assert.rejects(pending, /STALE_WORKSPACE/);
				if (operation === 'open' || operation === 'recent') assert.throws(() => files.compileOwner(), /STALE_WORKSPACE/);
				if (operation === 'saveAs') {
					assert.throws(() => files.compileOwner(), /STALE_WORKSPACE/);
					assert.equal(await readFile(join(directory, 'copied.tex'), 'utf8'), 'copied');
				}
				if (operation === 'write') assert.equal(await readFile(path, 'utf8'), 'saved'); // Abort cannot undo an already committed disk write.
				await assert.rejects(port.readFile(ref), /STALE_WORKSPACE/);
			} finally { resume(); await pending.catch(() => {}); files.close(); }
		});

		await t.test('a committed DesktopPort write supplies the revision for the next read', async () => {
			const owner = await files.open(path, 'file');
			const ref = { workspaceId: owner.id, path: 'main.tex' };
			const native = {
				readFile: async (file: unknown) => files.read(file),
				writeFile: async (request: unknown) => files.write(request)
			};
			Object.defineProperty(globalThis, 'window', {
				configurable: true,
				writable: true,
				value: { modutexFiles: native }
			});
			const port = desktopFiles()!;
			try {
				const before = await port.readFile(ref);
				const bytes = new TextEncoder().encode('committed through DesktopPort');
				const saved = await port.writeFile({
					...ref,
					bytes,
					expectedRevision: before.revision,
					documentId: 'original',
					documentVersion: 2
				});
				const reopened = await port.readFile(ref);

				assert.equal(reopened.revision, saved.revision,
					'A successful write receipt must become the next disk checkpoint');
				assert.deepEqual(Array.from(reopened.bytes), Array.from(bytes));
			} finally {
				files.close();
			}
		});
	} finally {
		files.close(); await server.close();
		if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
		if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('modutex-lifetime-')) throw new Error('Unsafe cleanup');
		await rm(directory, { recursive: true, force: true });
	}
});
