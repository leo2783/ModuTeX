// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachWindowListeners } from '$lib/workspace/workspaceMount';
import { ProjectConfigSync } from '$lib/workspace/projectConfigSync.svelte';
import { mainFile } from '$lib/workspace/workspaceStore';
import { get } from 'svelte/store';

let detach: (() => void) | undefined;
afterEach(() => {
	detach?.();
	detach = undefined;
	delete (window as unknown as { texpileNative?: unknown }).texpileNative;
});
function fixture() {
	let callback!: (change?: unknown) => void;
	const off = vi.fn();
	(window as unknown as { texpileNative: unknown }).texpileNative = {
		onWorkspaceFsChanged: (cb: typeof callback) => {
			callback = cb;
			return off;
		}
	};
	const deps = {
		refreshTree: vi.fn(),
		reloadReferences: vi.fn(),
		isHost: () => true,
		checkExternalChange: vi.fn(),
		runCompile: vi.fn(),
		onWindowResize: vi.fn(),
		reloadProjectState: vi.fn()
	};
	detach = attachWindowListeners(deps);
	return { deps, callback, off };
}
describe('production workspace native watch callbacks', () => {
	it('metadata reloads project state without tree, refs or active document conflict refresh', () => {
		const f = fixture();
		f.callback({ kind: 'project-state', changedPaths: ['.texpile/config.json', '.texpile/comments.jsonl'] });
		expect(f.deps.reloadProjectState).toHaveBeenCalledOnce();
		expect(f.deps.refreshTree).not.toHaveBeenCalled();
		expect(f.deps.reloadReferences).not.toHaveBeenCalled();
		expect(f.deps.checkExternalChange).not.toHaveBeenCalled();
	});
	it('config main changes still propagate through the production config controller and main-file store', async () => {
		const f = fixture();
		const bridge = (window as unknown as { texpileNative: Record<string, unknown> }).texpileNative;
		bridge.fsStat = async () => ({ exists: true, mtimeMs: 1, size: 37 });
		bridge.fsRead = async () => ({ content: '{"v":1,"main":"other.tex"}' });
		const controller = new ProjectConfigSync();
		const changes: (string | null)[] = [];
		const off = mainFile.subscribe((value) => changes.push(value));
		let reload!: Promise<void>;
		f.deps.reloadProjectState.mockImplementation(() => {
			reload = controller.refresh('C:/metadata-test');
		});
		try {
			f.callback({ kind: 'project-state', changedPaths: ['.texpile/config.json'] });
			await reload;
			expect(get(mainFile)).toBe('C:/metadata-test/other.tex');
			expect(changes).toContain('C:/metadata-test/other.tex');
			expect(f.deps.refreshTree).not.toHaveBeenCalled();
			expect(f.deps.reloadReferences).not.toHaveBeenCalled();
		} finally {
			off();
			mainFile.set(null);
		}
	});
	it.each([
		undefined,
		null,
		{ kind: 'workspace' },
		{ kind: 'project-state', changedPaths: [] },
		{ kind: 'project-state', changedPaths: ['main.tex'] },
		{ kind: 'project-state', changedPaths: ['.texpile/../main.tex'] },
		{ kind: 'project-state', changedPaths: ['.texpile\\config.json'] },
		{ kind: 'project-state', changedPaths: [`.texpile/config${String.fromCharCode(0)}.json`] },
		{ kind: 'project-state', changedPaths: [`.texpile/config${String.fromCharCode(31)}.json`] },
		{ kind: 'project-state', changedPaths: ['/.texpile/config.json'] },
		{ kind: 'project-state', changedPaths: ['.texpile/config.json'], extra: true },
		{ kind: 'project-state', changedPaths: 'config.json' }
	])('legacy/workspace/malformed payload preserves full refresh: %j', (change) => {
		const f = fixture();
		f.callback(change);
		expect(f.deps.refreshTree).toHaveBeenCalledOnce();
		expect(f.deps.reloadReferences).toHaveBeenCalledOnce();
		expect(f.deps.checkExternalChange).toHaveBeenCalledOnce();
		expect(f.deps.reloadProjectState).toHaveBeenCalledOnce();
	});
	it('focus/local writes remain full and detach removes the production listeners', () => {
		const f = fixture();
		window.dispatchEvent(new Event('focus'));
		window.dispatchEvent(new Event('texpile:fs-changed'));
		expect(f.deps.refreshTree).toHaveBeenCalledTimes(2);
		expect(f.deps.reloadReferences).toHaveBeenCalledTimes(2);
		detach!();
		detach = undefined;
		window.dispatchEvent(new Event('focus'));
		expect(f.deps.refreshTree).toHaveBeenCalledTimes(2);
		expect(f.off).toHaveBeenCalledOnce();
	});
});
