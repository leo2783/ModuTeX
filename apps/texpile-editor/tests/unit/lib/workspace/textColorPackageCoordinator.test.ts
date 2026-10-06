// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { TextColorPackageCoordinator } from '$lib/workspace/text-color-package-context';

const source = '\\documentclass{article}\r\n% keep preamble bytes\r\n\\begin{document}\r\nSelected text.\r\n\\end{document}\r\n';
const views: EditorView[] = [];

function harness(initialSource = source) {
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor: () => {}
	};
	const documentBuffer = new DocumentBuffer(deps);
	documentBuffer.openTex('/ws/main.tex', initialSource, '\r\n');
	documentBuffer.adoptParsed(parseLatexFile(initialSource));
	const view = new EditorView(globalThis.document.body.appendChild(globalThis.document.createElement('div')), {
		state: EditorState.create({ schema, doc: documentBuffer.visualDoc! })
	});
	views.push(view);
	const packagePrompt = new PackagePromptController();
	const hostState = {
		activePath: '/ws/main.tex' as string | null,
		kind: 'tex' as const,
		viewMode: 'visual' as 'visual' | 'source' | 'diff'
	};
	const afterPackageChange = vi.fn(async () => true);
	const coordinator = new TextColorPackageCoordinator(documentBuffer, packagePrompt, {
		getActivePath: () => hostState.activePath,
		getKind: () => hostState.kind,
		getView: () => view,
		getViewMode: () => hostState.viewMode,
		afterPackageChange,
		onPackageError: vi.fn()
	});
	return { document: documentBuffer, view, packagePrompt, hostState, coordinator, scheduled, afterPackageChange };
}

afterEach(() => {
	for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const element of [...document.body.children]) element.remove();
	vi.restoreAllMocks();
});

describe('TextColorPackageCoordinator xcolor consent', () => {
	it('adds xcolor through the authoritative DocumentBuffer and returns a current lease', async () => {
		const h = harness();
		const pending = h.coordinator.ensureXcolor(new AbortController().signal, () => true);
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'xcolor', canAdd: true });
		h.packagePrompt.resolve(request!.id, 'add-and-insert');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.document.docMeta).not.toBeNull();
		expect(h.document.texSource).toBe(
			'\\documentclass{article}\r\n% keep preamble bytes\r\n\\usepackage{xcolor}\r\n\\begin{document}\r\nSelected text.\r\n\\end{document}\r\n'
		);
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.document.texSource }]);
		expect(h.afterPackageChange).toHaveBeenCalledOnce();
	});

	it('offers continue-without-package without source mutation', async () => {
		const h = harness();
		const pending = h.coordinator.ensureXcolor(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'insert-without-package');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.afterPackageChange).not.toHaveBeenCalled();
	});

	it('cancels the color change without source mutation when consent is declined', async () => {
		const h = harness();
		const pending = h.coordinator.ensureXcolor(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'cancel');

		expect(await pending).toBeNull();
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.afterPackageChange).not.toHaveBeenCalled();
	});

	it('does not mutate for a stale selection target', async () => {
		const h = harness();
		let targetCurrent = true;
		const pending = h.coordinator.ensureXcolor(new AbortController().signal, () => targetCurrent);
		const request = h.packagePrompt.active!;
		targetCurrent = false;
		h.packagePrompt.resolve(request.id, 'add-and-insert');

		expect(await pending).toBeNull();
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('skips the dialog for an already loaded xcolor package', async () => {
		const loaded = source.replace('\\begin{document}', '\\usepackage{xcolor}\r\n\\begin{document}');
		const h = harness(loaded);
		const lease = await h.coordinator.ensureXcolor(new AbortController().signal, () => true);

		expect(lease?.isCurrent()).toBe(true);
		expect(h.packagePrompt.active).toBeNull();
		expect(h.scheduled).toEqual([]);
	});
});
