import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { TablePackageCoordinator } from '$lib/workspace/table-package-context';

const source = '\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n';

function harness(initialSource = source) {
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => false,
		clearPendingAnchor: () => {}
	};
	const document = new DocumentBuffer(deps);
	document.openTex('/ws/main.tex', initialSource, '\n');
	const packagePrompt = new PackagePromptController();
	const afterPackageChange = vi.fn(async () => true);
	const coordinator = new TablePackageCoordinator(document, packagePrompt, {
		getActivePath: () => '/ws/main.tex',
		getKind: () => 'tex',
		getView: () => null,
		getViewMode: () => 'source',
		afterPackageChange,
		onPackageError: vi.fn()
	});
	return { document, packagePrompt, coordinator, scheduled, afterPackageChange };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('table booktabs package coordinator', () => {
	it('patches the source-first DocumentBuffer and returns a current booktabs lease', async () => {
		const h = harness();
		const receipts: Array<{ offset: number; insertedLength: number } | undefined> = [];
		const pending = h.coordinator.ensureBooktabs(new AbortController().signal, (patch) => {
			receipts.push(patch);
			return true;
		});
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'booktabs', canAdd: true });
		h.packagePrompt.resolve(request!.id, 'add-and-insert');

		const lease = await pending;
		expect(lease?.preset).toBe('booktabs');
		expect(lease?.isCurrent()).toBe(true);
		expect(h.document.docMeta).toBeNull();
		expect(h.document.texSource).toBe('\\documentclass{article}\n\\usepackage{booktabs}\n\\begin{document}\nBody.\n\\end{document}\n');
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.document.texSource }]);
		expect(h.afterPackageChange).toHaveBeenCalledOnce();
		expect(receipts.at(-1)).toMatchObject({ insertedLength: '\\usepackage{booktabs}\n'.length });
	});

	it('maps a declined package to the visibly distinct equal-weight three-line preset without mutation', async () => {
		const h = harness();
		const pending = h.coordinator.ensureBooktabs(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'insert-without-package');

		const lease = await pending;
		expect(lease?.preset).toBe('three-line');
		expect(lease?.isCurrent()).toBe(true);
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.afterPackageChange).not.toHaveBeenCalled();
	});

	it('offers the three-line option but does not mutate an unknown preamble or stale target', async () => {
		const unsafe = source.replace('\\begin{document}', '\\input{local-config}\n\\begin{document}');
		const h = harness(unsafe);
		let current = true;
		const pending = h.coordinator.ensureBooktabs(new AbortController().signal, () => current);
		const request = h.packagePrompt.active!;
		expect(request.canAdd).toBe(false);
		current = false;
		h.packagePrompt.resolve(request.id, 'insert-without-package');

		expect(await pending).toBeNull();
		expect(h.document.texSource).toBe(unsafe);
		expect(h.scheduled).toEqual([]);
	});

	it('adds arydshln only after explicit consent and returns a current dashed-style lease', async () => {
		const h = harness();
		const receipts: Array<{ offset: number; insertedLength: number } | undefined> = [];
		const pending = h.coordinator.ensureArydshln(new AbortController().signal, (patch) => {
			receipts.push(patch);
			return true;
		});
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'arydshln', canAdd: true });
		h.packagePrompt.resolve(request!.id, 'add-and-insert');

		const lease = await pending;
		expect(lease?.preset).toBe('arydshln');
		expect(lease?.isCurrent()).toBe(true);
		expect(h.document.texSource).toBe('\\documentclass{article}\n\\usepackage{arydshln}\n\\begin{document}\nBody.\n\\end{document}\n');
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.document.texSource }]);
		expect(h.afterPackageChange).toHaveBeenCalledOnce();
		expect(receipts.at(-1)).toMatchObject({ insertedLength: '\\usepackage{arydshln}\n'.length });
	});

	it('never applies dashed rules without the required package, even if a no-package choice is requested', async () => {
		const h = harness();
		const pending = h.coordinator.ensureArydshln(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		expect(request.packageName).toBe('arydshln');
		h.packagePrompt.resolve(request.id, 'insert-without-package');

		expect(await pending).toBeNull();
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.afterPackageChange).not.toHaveBeenCalled();
	});

	it('fails closed when the preamble is unknown or the target becomes stale before consent', async () => {
		const unsafe = source.replace('\\begin{document}', '\\input{local-config}\n\\begin{document}');
		const h = harness(unsafe);
		let current = true;
		const pending = h.coordinator.ensureArydshln(new AbortController().signal, () => current);
		const request = h.packagePrompt.active!;
		expect(request).toMatchObject({ packageName: 'arydshln', canAdd: false });
		current = false;
		h.packagePrompt.resolve(request.id, 'cancel');

		expect(await pending).toBeNull();
		expect(h.document.texSource).toBe(unsafe);
		expect(h.scheduled).toEqual([]);
	});
});
