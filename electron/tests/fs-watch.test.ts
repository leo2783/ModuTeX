import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, rm, readFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceFsChange } from 'modutex-contracts';
import { startWorkspaceWatch, stopWorkspaceWatch } from '../src/fs-watch';
import type { FSWatcher } from 'chokidar';

function ready(watcher: FSWatcher): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (error?: unknown) => {
			clearTimeout(timer);
			watcher.off('ready', onReady);
			watcher.off('error', onError);
			if (error) reject(error);
			else resolve();
		};
		const onReady = () => finish();
		const onError = (error: unknown) => finish(error);
		const timer = setTimeout(() => finish(new Error('bounded watcher ready wait')), 4000);
		watcher.once('ready', onReady);
		watcher.once('error', onError);
	});
}

const owned: { key: string; root: string }[] = [];
const aliases: string[] = [];
afterEach(async () => {
	for (const item of owned.splice(0)) {
		await stopWorkspaceWatch(item.key);
		for (const alias of aliases.splice(0)) await rm(alias, { recursive: true, force: true });
		await rm(item.root, { recursive: true, force: true });
	}
});
async function fixture(aliased = false) {
	const root = await mkdtemp(join(tmpdir(), 'modutex-watch-test-'));
	const key = root;
	owned.push({ key, root });
	await mkdir(join(root, '.texpile'));
	await writeFile(join(root, '.texpile', 'config.json'), '{"main":"main.tex"}');
	await writeFile(join(root, '.texpile', 'comments.jsonl'), '[]');
	await writeFile(join(root, 'main.tex'), 'before');
	const events: WorkspaceFsChange[] = [];
	let awaiting: ((change: WorkspaceFsChange) => void) | undefined;
	let watchRoot = root;
	if (aliased) {
		watchRoot = `${root}-alias`;
		await symlink(root, watchRoot, process.platform === 'win32' ? 'junction' : 'dir');
		aliases.push(watchRoot);
	}
	const watcher = startWorkspaceWatch(key, watchRoot, (change) => {
		events.push(change);
		awaiting?.(change);
		awaiting = undefined;
	});
	expect(watcher).toBeDefined();
	await ready(watcher!);
	const next = () =>
		new Promise<WorkspaceFsChange>((resolve, reject) => {
			const timer = setTimeout(() => {
				awaiting = undefined;
				reject(new Error('bounded real watcher callback wait'));
			}, 4000);
			awaiting = (change) => {
				clearTimeout(timer);
				resolve(change);
			};
		});
	return { root, key, events, watcher: watcher!, next };
}
describe('real chokidar metadata batch routing', () => {
	it('canonicalizes a real aliased watch root before native atomic-change events', async () => {
		const f = await fixture(true);
		const canonical = await realpath(f.root);
		expect(Object.keys(f.watcher.getWatched())).toContain(canonical);
		const next = f.next();
		await writeFile(join(f.root, '.texpile', '.config.tmp'), '{"main":"alias-atomic.tex"}');
		await rename(join(f.root, '.texpile', '.config.tmp'), join(f.root, '.texpile', 'config.json'));
		expect(await next).toEqual({ kind: 'project-state', changedPaths: ['.texpile/config.json'] });
	});
	it('observes external config/comments updates without hiding either path', async () => {
		const f = await fixture();
		const next = f.next();
		await Promise.all([
			writeFile(join(f.root, '.texpile', 'config.json'), '{"main":"other.tex"}'),
			writeFile(join(f.root, '.texpile', 'comments.jsonl'), '["external"]')
		]);
		expect(await next).toEqual({ kind: 'project-state', changedPaths: ['.texpile/comments.jsonl', '.texpile/config.json'] });
		expect(await readFile(join(f.root, '.texpile', 'config.json'), 'utf8')).toContain('other.tex');
	});
	it('normalizes real atomic replacement into metadata while mixed batches stay workspace', async () => {
		const f = await fixture();
		let next = f.next();
		await writeFile(join(f.root, '.texpile', '.config.tmp'), '{"main":"atomic.tex"}');
		await rename(join(f.root, '.texpile', '.config.tmp'), join(f.root, '.texpile', 'config.json'));
		expect(await next).toEqual({ kind: 'project-state', changedPaths: ['.texpile/config.json'] });
		next = f.next();
		await Promise.all([
			writeFile(join(f.root, '.texpile', 'comments.jsonl'), '["mixed"]'),
			writeFile(join(f.root, 'main.tex'), 'mixed body')
		]);
		expect(await next).toEqual({ kind: 'workspace' });
	});
	it('treats unknown/outside filenames conservatively and rejects stopped/replaced watcher events', async () => {
		const f = await fixture();
		for (const filename of [undefined, join(f.root, '..', 'outside.tex'), f.root]) {
			const next = f.next();
			// Native negative event fault, through the real ready chokidar instance.
			f.watcher.emit('all', 'change', filename);
			expect(await next).toEqual({ kind: 'workspace' });
		}
		const unknownEvent = f.next();
		f.watcher.emit('all', 'unknown', join(f.root, '.texpile', 'config.json'));
		expect(await unknownEvent).toEqual({ kind: 'workspace' });
		f.watcher.emit('all', 'change', join(f.root, '.texpile', 'config.json'));
		await stopWorkspaceWatch(f.key);
		const staleCount = f.events.length;
		f.watcher.emit('all', 'change', join(f.root, 'main.tex'));
		let received!: (change: WorkspaceFsChange) => void;
		const replacement = startWorkspaceWatch(f.key, f.root, (change) => received(change));
		await ready(replacement!);
		const next = new Promise<WorkspaceFsChange>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('replacement callback wait')), 4000);
			received = (change) => {
				clearTimeout(timer);
				resolve(change);
			};
		});
		await writeFile(join(f.root, '.texpile', 'config.json'), '{"main":"replacement.tex"}');
		expect(await next).toEqual({ kind: 'project-state', changedPaths: ['.texpile/config.json'] });
		expect(f.events).toHaveLength(staleCount);
	});
});
