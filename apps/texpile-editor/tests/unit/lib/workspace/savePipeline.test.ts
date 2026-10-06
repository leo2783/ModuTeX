// The external-write guard: an autosave must not overwrite a file someone else (VS Code, a git
// checkout, an AI agent) wrote since we last read or wrote it. Without the guard the sequence
// "user types -> agent writes -> 1.5s autosave" silently destroys the agent's edit; the window
// never lost focus, so the focus-driven conflict check never ran.
import { describe, it, expect, vi } from 'vitest';
import { SavePipeline, type SaveDeps } from '$lib/workspace/savePipeline.svelte';

function makePipeline(over: Partial<SaveDeps> = {}) {
	const writes: { path: string; content: string }[] = [];
	const deps: SaveDeps = {
		autosaveActive: () => true,
		writeText: async (path, content) => {
			writes.push({ path, content });
		},
		getEol: () => '\n',
		getLoadedPath: () => '/ws/main.tex',
		getLiveContent: () => 'live',
		setDiskBaseline: () => {},
		setDirty: () => {},
		diskChanged: async () => false,
		recordDiskStamp: async () => {},
		raiseConflict: () => {},
		...over
	};
	return { pipeline: new SavePipeline(deps), writes, deps };
}

describe('SavePipeline external-write guard', () => {
	it('persists local edits without a collaboration/session adapter', async () => {
		const { pipeline, writes } = makePipeline();
		await pipeline.enqueue('/ws/main.tex', 'local source', false);
		expect(writes).toEqual([{ path: '/ws/main.tex', content: 'local source' }]);
	});

	it('writes normally while disk is untouched', async () => {
		const { pipeline, writes } = makePipeline();
		await pipeline.enqueue('/ws/main.tex', 'mine', false);
		expect(writes).toEqual([{ path: '/ws/main.tex', content: 'mine' }]);
	});

	it('aborts the write and raises the conflict when disk changed underneath', async () => {
		const raiseConflict = vi.fn();
		const { pipeline, writes } = makePipeline({ diskChanged: async () => true, raiseConflict });
		await pipeline.enqueue('/ws/main.tex', 'mine', false);
		expect(writes).toEqual([]); // the external edit survived
		expect(raiseConflict).toHaveBeenCalledWith('/ws/main.tex');
	});

	it('force writes through the guard (the conflict modal\'s "keep mine")', async () => {
		const raiseConflict = vi.fn();
		const { pipeline, writes } = makePipeline({ diskChanged: async () => true, raiseConflict });
		await pipeline.enqueue('/ws/main.tex', 'mine', false, true);
		expect(writes).toEqual([{ path: '/ws/main.tex', content: 'mine' }]);
		expect(raiseConflict).not.toHaveBeenCalled();
	});

	it('re-stamps after its own write, so the next autosave is not seen as external', async () => {
		const recordDiskStamp = vi.fn(async () => {});
		const { pipeline } = makePipeline({ recordDiskStamp });
		await pipeline.enqueue('/ws/main.tex', 'mine', false);
		expect(recordDiskStamp).toHaveBeenCalledWith('/ws/main.tex');
	});

	it('does not re-stamp an aborted write, so the conflict stays detectable', async () => {
		const recordDiskStamp = vi.fn(async () => {});
		const { pipeline } = makePipeline({ diskChanged: async () => true, recordDiskStamp });
		await pipeline.enqueue('/ws/main.tex', 'mine', false);
		expect(recordDiskStamp).not.toHaveBeenCalled();
	});

	it('clears the saving flag after an aborted write', async () => {
		const { pipeline } = makePipeline({ diskChanged: async () => true });
		await pipeline.enqueue('/ws/main.tex', 'mine', false);
		expect(pipeline.saving).toBe(false);
	});

	it('an aborted write does not break the chain for later writes', async () => {
		let changed = true;
		const { pipeline, writes } = makePipeline({ diskChanged: async () => changed });
		await pipeline.enqueue('/ws/main.tex', 'first', false);
		changed = false; // conflict resolved (e.g. user reloaded, then typed again)
		await pipeline.enqueue('/ws/main.tex', 'second', false);
		expect(writes).toEqual([{ path: '/ws/main.tex', content: 'second' }]);
	});

	it('does not mark the buffer clean when the write was aborted', async () => {
		const setDirty = vi.fn();
		const { pipeline } = makePipeline({
			diskChanged: async () => true,
			setDirty,
			getLiveContent: () => 'mine'
		});
		await pipeline.enqueue('/ws/main.tex', 'mine', false);
		expect(setDirty).not.toHaveBeenCalled(); // still dirty: the user's edit has not landed anywhere
	});
});
