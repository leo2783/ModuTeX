// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { MathPackageCoordinator } from '$lib/workspace/math-package-context';

const source = '\\documentclass{article}\r\n% keep this preamble byte-for-byte\r\n\\begin{document}\r\nBody.\r\n\\end{document}\r\n';
const liveViews: EditorView[] = [];

function makeHarness(options: { source?: string; viewMode?: 'visual' | 'source'; adoptParsed?: boolean } = {}) {
	const initialSource = options.source ?? source;
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => options.viewMode !== 'source',
		clearPendingAnchor: () => {}
	};
	const documentBuffer = new DocumentBuffer(deps);
	documentBuffer.openTex('/ws/main.tex', initialSource, '\r\n');
	if (options.adoptParsed !== false) documentBuffer.adoptParsed(parseLatexFile(initialSource));
	const view =
		options.viewMode === 'source'
			? null
			: new EditorView(document.body.appendChild(document.createElement('div')), {
					state: EditorState.create({ schema, doc: documentBuffer.visualDoc! })
				});
	if (view) liveViews.push(view);
	const packagePrompt = new PackagePromptController();
	const hostState = { viewMode: options.viewMode ?? ('visual' as 'visual' | 'source'), activePath: '/ws/main.tex' as string | null };
	const afterPackageChange = vi.fn(async () => true);
	const coordinator = new MathPackageCoordinator(documentBuffer, packagePrompt, {
		getActivePath: () => hostState.activePath,
		getKind: () => 'tex',
		getView: () => view,
		getViewMode: () => hostState.viewMode,
		afterPackageChange,
		onPackageError: vi.fn()
	});
	return { documentBuffer, scheduled, view, packagePrompt, hostState, coordinator, afterPackageChange };
}

afterEach(() => {
	for (const view of liveViews.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const element of [...document.body.children]) element.remove();
});

describe('MathPackageCoordinator amsmath gate', () => {
	it('patches the real TeX preamble through DocumentBuffer before allowing insertion', async () => {
		const h = makeHarness();
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'amsmath', canAdd: true });
		h.packagePrompt.resolve(request!.id, 'add-and-insert');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.documentBuffer.texSource).toBe(
			'\\documentclass{article}\r\n% keep this preamble byte-for-byte\r\n\\usepackage{amsmath}\r\n\\begin{document}\r\nBody.\r\n\\end{document}\r\n'
		);
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.documentBuffer.texSource }]);
		expect(h.afterPackageChange).toHaveBeenCalledOnce();
	});

	it('supports the explicit continue-without-package choice without source mutation', async () => {
		const h = makeHarness();
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'insert-without-package');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('cancels when the captured tab changes before the package decision', async () => {
		const h = makeHarness();
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.hostState.activePath = '/ws/other.tex';
		h.packagePrompt.resolve(request.id, 'add-and-insert');

		expect(await pending).toBeNull();
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('does not patch if the visual ProseMirror document was replaced during the prompt', async () => {
		const h = makeHarness();
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.view!.updateState(EditorState.create({ schema, doc: schema.topNodeType.createAndFill()! }));
		h.packagePrompt.resolve(request.id, 'add-and-insert');

		expect(await pending).toBeNull();
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('does not prompt when amsmath is already declared', async () => {
		const alreadyInstalled = source.replace('\\begin{document}', '\\usepackage{amsmath}\r\n\\begin{document}');
		const h = makeHarness({ source: alreadyInstalled, viewMode: 'source' });

		const lease = await h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		expect(lease?.isCurrent()).toBe(true);
		expect(h.packagePrompt.active).toBeNull();
		expect(h.scheduled).toEqual([]);
	});

	it('aborts the pending choice and makes no package mutation', async () => {
		const h = makeHarness({ viewMode: 'source' });
		const controller = new AbortController();
		const pending = h.coordinator.ensureAmsmath(controller.signal, () => true);
		controller.abort();

		await expect(pending).resolves.toBeNull();
		expect(h.packagePrompt.active).toBeNull();
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('supports a source-first Add choice without adopting parsed metadata or rewriting body bytes', async () => {
		const h = makeHarness({ viewMode: 'source', adoptParsed: false });
		expect(h.documentBuffer.docMeta).toBeNull();
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'amsmath', canAdd: true });
		h.packagePrompt.resolve(request!.id, 'add-and-insert');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.documentBuffer.docMeta).toBeNull();
		expect(h.documentBuffer.texSource).toBe(
			'\\documentclass{article}\r\n% keep this preamble byte-for-byte\r\n\\usepackage{amsmath}\r\n\\begin{document}\r\nBody.\r\n\\end{document}\r\n'
		);
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.documentBuffer.texSource }]);
	});

	it('supports source-first Continue without amsmath without mutation', async () => {
		const h = makeHarness({ viewMode: 'source', adoptParsed: false });
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'insert-without-package');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.documentBuffer.docMeta).toBeNull();
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('supports source-first Cancel without mutation', async () => {
		const h = makeHarness({ viewMode: 'source', adoptParsed: false });
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'cancel');

		expect(await pending).toBeNull();
		expect(h.documentBuffer.docMeta).toBeNull();
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('does not add to a source-first buffer when its exact captured target is invalidated before the choice resolves', async () => {
		const h = makeHarness({ viewMode: 'source', adoptParsed: false });
		let targetCurrent = true;
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => targetCurrent);
		const request = h.packagePrompt.active!;
		targetCurrent = false;
		h.packagePrompt.resolve(request.id, 'add-and-insert');

		expect(await pending).toBeNull();
		expect(h.documentBuffer.docMeta).toBeNull();
		expect(h.documentBuffer.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
	});

	it('offers without-package and cancel when source-first preamble syntax is not safely patchable', async () => {
		const unsafeSource = source.replace('\\begin{document}', '\\input{local-config}\r\n\\begin{document}');
		const h = makeHarness({ source: unsafeSource, viewMode: 'source', adoptParsed: false });
		const pending = h.coordinator.ensureAmsmath(new AbortController().signal, () => true);
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'amsmath', canAdd: false });
		h.packagePrompt.resolve(request!.id, 'insert-without-package');

		const lease = await pending;
		expect(lease?.isCurrent()).toBe(true);
		expect(h.documentBuffer.docMeta).toBeNull();
		expect(h.documentBuffer.texSource).toBe(unsafeSource);
		expect(h.scheduled).toEqual([]);
	});
});
