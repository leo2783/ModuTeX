import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FileEvent } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };
import { FrontendWatch } from '../src/frontend-watch';

const workspaceId = '123e4567-e89b-42d3-a456-426614174000';

async function writeFixtureFiles(directory: string, count: number, extension: string): Promise<void> {
	// Exercise the full resource boundary without flooding the host's I/O queue.
	for (let start = 0; start < count; start += 32) {
		await Promise.all(Array.from({ length: Math.min(32, count - start) }, (_, offset) =>
			fs.writeFile(path.join(directory, `entry-${start + offset}.${extension}`), 'x')));
	}
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('Timed out waiting for filesystem watch result');
}

describe('real frontend workspace watch', () => {
	let directory: string;
	let root: string;
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-frontend-watch-'));
		root = path.join(directory, 'workspace');
		await fs.mkdir(root);
	});
	afterEach(async () => {
		if (!path.basename(directory).startsWith('modutex-frontend-watch-') || path.dirname(directory) !== os.tmpdir()) {
			throw new Error('Unsafe cleanup');
		}
		await fs.rm(directory, { recursive: true, force: true });
	});

	it('observes real root and newly nested TeX creation, changes, and removals', async () => {
		const events: FileEvent[] = [];
		const failures: string[] = [];
		const watcher = new FrontendWatch({
			root,
			workspaceId,
			assertCurrent() {},
			emit: (event) => events.push(event),
			onError: (error) => failures.push(error)
		});
		try {
			await watcher.start();
			const rootFile = path.join(root, 'root.tex');
			await fs.writeFile(rootFile, 'one');
			await waitFor(() => events.find((event) => event.path === 'root.tex' && event.kind === 'changed'));

			events.length = 0;
			await fs.writeFile(rootFile, 'two and changed');
			await waitFor(() => events.find((event) => event.path === 'root.tex' && event.kind === 'changed'));

			events.length = 0;
			await fs.unlink(rootFile);
			await waitFor(() => events.find((event) => event.path === 'root.tex' && event.kind === 'removed'));

			const nested = path.join(root, 'chapters');
			const nestedFile = path.join(nested, 'chapter.tex');
			await fs.mkdir(nested);
			await fs.writeFile(nestedFile, 'new nested document');
			await waitFor(() => events.find((event) => event.path === 'chapters/chapter.tex' && event.kind === 'changed'));

			events.length = 0;
			await fs.writeFile(nestedFile, 'updated nested document');
			await waitFor(() => events.find((event) => event.path === 'chapters/chapter.tex' && event.kind === 'changed'));

			events.length = 0;
			await fs.unlink(nestedFile);
			await waitFor(() => events.find((event) => event.path === 'chapters/chapter.tex' && event.kind === 'removed'));
			expect(failures).toEqual([]);
		} finally {
			watcher.stop();
		}
	}, 20000);

	it('terminates rather than following a nested junction replacement', async () => {
		const nested = path.join(root, 'nested');
		const outside = path.join(directory, 'outside');
		await fs.mkdir(nested);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(nested, 'inside.tex'), 'inside');
		await fs.writeFile(path.join(outside, 'private.tex'), 'private');
		const events: FileEvent[] = [];
		const failures: string[] = [];
		const watcher = new FrontendWatch({
			root,
			workspaceId,
			assertCurrent() {},
			emit: (event) => events.push(event),
			onError: (error) => failures.push(error)
		});
		try {
			await watcher.start();
			await fs.rename(nested, path.join(directory, 'moved-nested'));
			await fs.symlink(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
			await waitFor(() => failures.find((failure) => failure === 'LINK_NOT_ALLOWED'));
			await fs.writeFile(path.join(outside, 'private.tex'), 'changed outside');
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(events.some((event) => event.path.startsWith('nested/'))).toBe(false);
			expect(failures).toEqual(['LINK_NOT_ALLOWED']);
		} finally {
			watcher.stop();
		}
	}, 15000);

	it('detects replacement of the captured root identity', async () => {
		const outside = path.join(directory, 'outside');
		await fs.mkdir(outside);
		const events: FileEvent[] = [];
		const failures: string[] = [];
		const watcher = new FrontendWatch({
			root,
			workspaceId,
			assertCurrent() {},
			emit: (event) => events.push(event),
			onError: (error) => failures.push(error)
		});
		try {
			await watcher.start();
			await fs.rename(root, path.join(directory, 'moved-root'));
			await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
			await waitFor(() => failures.find((failure) => failure === 'LINK_NOT_ALLOWED' || failure === 'STALE_WORKSPACE'));
			await fs.writeFile(path.join(outside, 'private.tex'), 'outside');
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(events).toEqual([]);
			expect(failures).toHaveLength(1);
		} finally {
			watcher.stop();
		}
	}, 15000);

	it('enforces the workspace entry limit and closes its partial watcher set', async () => {
		await writeFixtureFiles(root, 4097, 'txt');
		const events: FileEvent[] = [];
		const failures: string[] = [];
		const watcher = new FrontendWatch({
			root,
			workspaceId,
			assertCurrent() {},
			emit: (event) => events.push(event),
			onError: (error) => failures.push(error)
		});
		const starting = watcher.start();
		try {
			await expect(starting).rejects.toThrow('TREE_TOO_LARGE');
			await fs.writeFile(path.join(root, 'after.tex'), 'after');
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(events).toEqual([]);
			expect(failures).toEqual([]);
		} finally {
			watcher.stop();
		}
	}, 25000);

	it('reports pending-event overflow through one terminal contract error', async () => {
		const staged = path.join(directory, 'staged');
		const published = path.join(root, 'many');
		await fs.mkdir(staged);
		await writeFixtureFiles(staged, 2049, 'tex');
		const events: FileEvent[] = [];
		const failures: string[] = [];
		const watcher = new FrontendWatch({
			root,
			workspaceId,
			assertCurrent() {},
			emit: (event) => events.push(event),
			onError: (error) => failures.push(error)
		});
		try {
			await watcher.start();
			await fs.rename(staged, published);
			await waitFor(() => failures.find((failure) => failure === 'TREE_TOO_LARGE'));
			expect(events).toEqual([]);
			await fs.writeFile(path.join(published, 'after.tex'), 'after');
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(failures).toEqual(['TREE_TOO_LARGE']);
			expect(events).toEqual([]);
		} finally {
			watcher.stop();
		}
	}, 25000);
});
