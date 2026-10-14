import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FrontendFiles } from '../src/frontend-files';

class PausedReadFiles extends FrontendFiles {
	private pause: { remaining: number; entered: () => void; wait: Promise<void> } | null = null;

	pauseAfter(readsBeforePause: number, entered: () => void, wait: Promise<void>): void {
		this.pause = { remaining: readsBeforePause, entered, wait };
	}

	override async read(value: unknown) {
		const pause = this.pause;
		if (pause) {
			if (pause.remaining === 0) {
				this.pause = null;
				pause.entered();
				await pause.wait;
			} else {
				pause.remaining--;
			}
		}
		return super.read(value);
	}
}

function makeGate() {
	let signal!: () => void;
	let resume!: () => void;
	return {
		entered: new Promise<void>((resolve) => { signal = resolve; }),
		wait: new Promise<void>((resolve) => { resume = resolve; }),
		signal: () => signal(),
		resume: () => resume()
	};
}

async function onlyTemporary(directory: string): Promise<string> {
	const names = (await fs.readdir(directory)).filter((name) => name.startsWith('.modutex-save-'));
	expect(names).toHaveLength(1);
	if (names.length !== 1) throw new Error('Expected one pending temporary save');
	return path.join(directory, names[0]!);
}

describe('revoked workspace save temporary cleanup', () => {
	let directory: string;
	let files: PausedReadFiles;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-write-cleanup-'));
		files = new PausedReadFiles();
	});

	afterEach(async () => {
		files.close();
		if (!path.basename(directory).startsWith('modutex-write-cleanup-') || path.dirname(directory) !== os.tmpdir()) {
			throw new Error('Unsafe cleanup');
		}
		await fs.rm(directory, { recursive: true, force: true });
	});

	it('cleans its temporary after close and reopen without affecting the new workspace', async () => {
		const oldRoot = path.join(directory, 'old-workspace');
		const newRoot = path.join(directory, 'new-workspace');
		await fs.mkdir(oldRoot);
		await fs.mkdir(newRoot);
		await fs.writeFile(path.join(oldRoot, 'main.tex'), 'original');
		await fs.writeFile(path.join(newRoot, 'next.tex'), 'new workspace');
		const oldWorkspace = await files.open(oldRoot, 'folder');
		const snapshot = await files.read({ workspaceId: oldWorkspace.id, path: 'main.tex' });
		const bytes = Buffer.from('pending save bytes');
		const gate = makeGate();
		files.pauseAfter(1, gate.signal, gate.wait);
		const pending = files.write({ workspaceId: oldWorkspace.id, path: 'main.tex', bytes,
			expectedRevision: snapshot.revision, documentId: 'old-document', documentVersion: 1 });

		try {
			await gate.entered;
			const temporary = await onlyTemporary(oldRoot);
			expect(await fs.readFile(temporary)).toEqual(bytes);
			expect(await fs.readFile(path.join(oldRoot, 'main.tex'), 'utf8')).toBe('original');

			files.close(oldWorkspace.id);
			const newWorkspace = await files.open(newRoot, 'folder');
			gate.resume();
			await expect(pending).rejects.toThrow('STALE_WORKSPACE');

			expect(await fs.readdir(oldRoot)).toEqual(['main.tex']);
			expect(await fs.readFile(path.join(oldRoot, 'main.tex'), 'utf8')).toBe('original');
			await expect(files.list(oldWorkspace.id)).rejects.toThrow('STALE_WORKSPACE');
			expect(await files.list(newWorkspace.id)).toEqual([{ path: 'next.tex', kind: 'file' }]);
			expect(await files.read({ workspaceId: newWorkspace.id, path: 'next.tex' })).toMatchObject({
				bytes: new Uint8Array(Buffer.from('new workspace'))
			});
		} finally {
			gate.resume();
			await pending.catch(() => {});
		}
	});

	it('does not publish or unlink a different file substituted at the temporary path', async () => {
		const source = path.join(directory, 'main.tex');
		const foreign = path.join(directory, 'foreign.bin');
		const foreignBytes = Buffer.from('foreign file');
		await fs.writeFile(source, 'original');
		await fs.writeFile(foreign, foreignBytes);
		const workspace = await files.open(directory, 'folder');
		const snapshot = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		const bytes = Buffer.from('must not publish');
		const gate = makeGate();
		files.pauseAfter(1, gate.signal, gate.wait);
		const pending = files.write({ workspaceId: workspace.id, path: 'main.tex', bytes,
			expectedRevision: snapshot.revision, documentId: 'document', documentVersion: 2 });

		try {
			await gate.entered;
			const temporary = await onlyTemporary(directory);
			await fs.unlink(temporary);
			await fs.link(foreign, temporary);
			gate.resume();
			await expect(pending).rejects.toThrow('TEMP_CHANGED');

			expect(await fs.readFile(source, 'utf8')).toBe('original');
			expect(await fs.readFile(foreign)).toEqual(foreignBytes);
			expect(await fs.readFile(temporary)).toEqual(foreignBytes);
		} finally {
			gate.resume();
			await pending.catch(() => {});
		}
	});

	it('retains the orphan when the selected root is replaced before cleanup', async () => {
		const root = path.join(directory, 'workspace');
		const displaced = path.join(directory, 'displaced-workspace');
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, 'main.tex'), 'original root');
		const oldWorkspace = await files.open(root, 'folder');
		const snapshot = await files.read({ workspaceId: oldWorkspace.id, path: 'main.tex' });
		const bytes = Buffer.from('pending save bytes');
		const gate = makeGate();
		files.pauseAfter(1, gate.signal, gate.wait);
		const pending = files.write({ workspaceId: oldWorkspace.id, path: 'main.tex', bytes,
			expectedRevision: snapshot.revision, documentId: 'old-document', documentVersion: 1 });

		try {
			await gate.entered;
			const temporary = await onlyTemporary(root);
			files.close(oldWorkspace.id);
			await fs.rename(root, displaced);
			await fs.mkdir(root);
			await fs.writeFile(path.join(root, 'main.tex'), 'replacement root');
			const newWorkspace = await files.open(root, 'folder');
			gate.resume();
			await expect(pending).rejects.toThrow('STALE_WORKSPACE');

			expect(await fs.readFile(path.join(displaced, 'main.tex'), 'utf8')).toBe('original root');
			expect(await fs.readFile(path.join(displaced, path.basename(temporary)))).toEqual(bytes);
			expect(await fs.readdir(root)).toEqual(['main.tex']);
			expect(await fs.readFile(path.join(root, 'main.tex'), 'utf8')).toBe('replacement root');
			await expect(files.list(oldWorkspace.id)).rejects.toThrow('STALE_WORKSPACE');
			expect(await files.list(newWorkspace.id)).toEqual([{ path: 'main.tex', kind: 'file' }]);
		} finally {
			gate.resume();
			await pending.catch(() => {});
		}
	});

	it('retains the orphan rather than following a replaced parent junction', async () => {
		const root = path.join(directory, 'workspace');
		const parent = path.join(root, 'section');
		const heldParent = path.join(directory, 'held-section');
		const outside = path.join(directory, 'outside');
		await fs.mkdir(parent, { recursive: true });
		await fs.mkdir(outside);
		await fs.writeFile(path.join(parent, 'main.tex'), 'original section');
		await fs.writeFile(path.join(outside, 'main.tex'), 'outside file');
		const workspace = await files.open(root, 'folder');
		const snapshot = await files.read({ workspaceId: workspace.id, path: 'section/main.tex' });
		const bytes = Buffer.from('pending save bytes');
		const gate = makeGate();
		files.pauseAfter(1, gate.signal, gate.wait);
		const pending = files.write({ workspaceId: workspace.id, path: 'section/main.tex', bytes,
			expectedRevision: snapshot.revision, documentId: 'document', documentVersion: 3 });

		try {
			await gate.entered;
			const temporary = await onlyTemporary(parent);
			await fs.rename(parent, heldParent);
			await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
			gate.resume();
			await expect(pending).rejects.toThrow('LINK_NOT_ALLOWED');

			expect(await fs.readFile(path.join(heldParent, 'main.tex'), 'utf8')).toBe('original section');
			expect(await fs.readFile(path.join(heldParent, path.basename(temporary)))).toEqual(bytes);
			expect(await fs.readFile(path.join(outside, 'main.tex'), 'utf8')).toBe('outside file');
			expect(await fs.readdir(outside)).toEqual(['main.tex']);
		} finally {
			gate.resume();
			await pending.catch(() => {});
		}
	});
});
