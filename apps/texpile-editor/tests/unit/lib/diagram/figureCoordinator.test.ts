// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';
import { FigureCoordinator, type FigureCoordinatorSnapshot } from '$lib/diagram/figure-coordinator';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import PackagePrompt from '$lib/diagram/PackagePrompt.svelte';
import { isDirty } from '$lib/workspace/workspaceStore';

const source = '\\documentclass{article}\r\n\\usepackage{booktabs}\r\n\\begin{document}\r\nBody text.\r\n\\end{document}\r\n';
const FIGURE_ID = '123e4567-e89b-42d3-a456-426614174000';
const RELINK_ID = '550e8400-e29b-41d4-a716-446655440000';
const originalNativeBridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'texpileNative');
const liveViews: EditorView[] = [];

function makeHarness(initialSource = source) {
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor: () => {}
	};
	const buffer = new DocumentBuffer(deps);
	buffer.openTex('/ws/main.tex', initialSource, '\r\n');
	const parsed = parseLatexFile(initialSource);
	buffer.adoptParsed(parsed);
	const view = new EditorView(document.body.appendChild(document.createElement('div')), {
		state: EditorState.create({ schema, doc: parsed.doc })
	});
	liveViews.push(view);
	const hostState = {
		activePath: '/ws/main.tex' as string | null,
		kind: 'tex' as const,
		viewMode: 'visual' as const,
		view: view as EditorView | null
	};
	const packagePrompt = new PackagePromptController();
	const coordinator = new FigureCoordinator(buffer, packagePrompt, {
		getActivePath: () => hostState.activePath,
		getKind: () => hostState.kind,
		getView: () => hostState.view,
		getViewMode: () => hostState.viewMode
	});
	const snapshot = (): FigureCoordinatorSnapshot => ({
		path: buffer.path,
		kind: buffer.kind,
		activePath: hostState.activePath,
		view: hostState.view,
		viewMode: hostState.viewMode,
		source: buffer.texSource,
		visualDoc: buffer.visualDoc
	});
	coordinator.observe(snapshot());
	const abortController = new AbortController();
	const target = buffer.visualDoc!.nodeAt(0);
	expect(target).toBeTruthy();
	const context = coordinator.begin('drawio', view, abortController.signal, { pos: 0, intent: 'insert' });
	expect(context).toBeTruthy();
	return { document: buffer, scheduled, view, hostState, packagePrompt, coordinator, snapshot, context: context!, abortController };
}

afterEach(() => {
	for (const view of liveViews.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const element of [...document.body.children]) element.remove();
	if (originalNativeBridgeDescriptor) Object.defineProperty(window, 'texpileNative', originalNativeBridgeDescriptor);
	else Reflect.deleteProperty(window, 'texpileNative');
	isDirty.set(false);
});

function installMockDiagramBridge(sourcePath: string) {
	const sourceHash = 'a'.repeat(64);
	const artifactHash = 'b'.repeat(64);
	let content = '';
	const bridge = {
		diagramWrite: vi.fn(async ({ content: next }: { relativePath: string; content: string }) => {
			content = next;
			return { sha256: sourceHash, size: new TextEncoder().encode(next).byteLength };
		}),
		diagramRead: vi.fn(async () => ({
			content,
			mtimeMs: 1,
			sha256: sourceHash,
			size: new TextEncoder().encode(content).byteLength
		})),
		diagramRenderPdf: vi.fn(async () => ({
			ok: true as const,
			outputRelPath: sourcePath.replace(/\.drawio$/, '.pdf'),
			svgRelPath: sourcePath.replace(/\.drawio$/, '.svg'),
			sourceSha256: sourceHash,
			svgSha256: artifactHash,
			pdfSha256: artifactHash
		})),
		diagramCancelPdf: vi.fn(async () => ({ cancelled: true }))
	};
	Object.defineProperty(window, 'texpileNative', { configurable: true, value: bridge });
	return bridge;
}

function beginExistingDiagram(h: ReturnType<typeof makeHarness>, attrs: Record<string, unknown>) {
	const image = schema.nodes.image.create(attrs);
	h.view.updateState(EditorState.create({ schema, doc: schema.nodes.doc.create(null, [image]) }));
	const controller = new AbortController();
	const context = h.coordinator.begin('drawio', h.view, controller.signal, { pos: 0, intent: 'edit', placement: 'replace' });
	return { image, controller, context };
}

function drawioFigureAttrs(id = FIGURE_ID, sourceId = id, type: 'drawio' | 'mermaid' = 'drawio'): Record<string, unknown> {
	return {
		src: `assets/diagrams/flow-${sourceId}.pdf`,
		diagramType: type,
		diagramId: id,
		diagramSource: `assets/diagrams/flow-${sourceId}.${type === 'drawio' ? 'drawio' : 'mmd'}`
	};
}

describe('FigureCoordinator package gate', () => {
	it('keeps its own synchronous preamble patch current, preserves CRLF, then refreshes only that source snapshot', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'graphicx', canAdd: true });

		h.packagePrompt.resolve(request!.id, 'add-and-insert');
		await expect(pending).resolves.toBe(true);
		expect(h.document.texSource).toBe(
			'\\documentclass{article}\r\n\\usepackage{booktabs}\r\n\\usepackage{graphicx}\r\n\\begin{document}\r\nBody text.\r\n\\end{document}\r\n'
		);
		expect(h.document.texSource.replaceAll('\r\n', '')).not.toContain('\n');
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.document.texSource }]);

		// This models WorkspaceView's reactive observation after DocumentBuffer's authorized own patch.
		// It must not invalidate the prompt's operation as if an external source edit had raced it.
		h.coordinator.observe(h.snapshot());
		const refreshed = h.coordinator.refreshAfterPackage(h.context);
		expect(refreshed).toBeTruthy();
		expect(refreshed!.originalSource).toBe(h.document.texSource);
		expect(refreshed!.originalDoc).toBe(h.context.originalDoc);
		expect(refreshed!.view).toBe(h.view);
		expect(refreshed!.target?.node).toBe(h.context.target?.node);
		expect(h.coordinator.isCurrent(refreshed!)).toBe(true);
		h.coordinator.release(refreshed!);
		h.view.destroy();
	});

	it('authorizes insert-without-package without mutating or invalidating the source snapshot', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'insert-without-package');
		await expect(pending).resolves.toBe(true);
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.coordinator.isCurrent(h.context)).toBe(true);
		const refreshed = h.coordinator.refreshAfterPackage(h.context);
		expect(refreshed).toBeTruthy();
		expect(h.coordinator.isCurrent(refreshed!)).toBe(true);
		h.coordinator.release(refreshed!);
		h.view.destroy();
	});

	it('cancel leaves the real document source and save queue untouched', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'cancel');
		await expect(pending).resolves.toBe(false);
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.coordinator.isCurrent(h.context)).toBe(true);
		h.coordinator.release(h.context);
		h.view.destroy();
	});

	it('does not prompt or duplicate an already active graphicx declaration', async () => {
		const activeSource = source.replace('\\usepackage{booktabs}', '\\usepackage{booktabs,graphicx}');
		const h = makeHarness(activeSource);
		await expect(h.coordinator.requestPackage(h.context, 'graphicx')).resolves.toBe(true);
		expect(h.packagePrompt.active).toBeNull();
		expect(h.document.texSource).toBe(activeSource);
		expect(h.scheduled).toEqual([]);
		h.coordinator.release(h.context);
		h.view.destroy();
	});

	it('cancels after an externally observed source edit and preserves the newer bytes', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		const newer = source.replace('Body text.', 'Externally changed body.');
		h.document.onTexInput(newer);
		h.coordinator.observe(h.snapshot());
		await expect(pending).resolves.toBe(false);
		expect(h.packagePrompt.active).toBeNull();
		expect(h.document.texSource).toBe(newer);
		expect(h.scheduled.at(-1)).toEqual({ path: '/ws/main.tex', content: newer });
		expect(h.coordinator.refreshAfterPackage(h.context)).toBeNull();
		h.view.destroy();
	});

	it('cancels when the active tab changes while a package choice is pending', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		h.hostState.activePath = '/ws/other.tex';
		h.coordinator.observe(h.snapshot());
		await expect(pending).resolves.toBe(false);
		expect(h.document.texSource).toBe(source);
		expect(h.packagePrompt.active).toBeNull();
		h.view.destroy();
	});

	it('rejects a prompt resolution if the captured ProseMirror document object was replaced', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		const request = h.packagePrompt.active!;
		const replacement = h.context.originalDoc.type.create(
			h.context.originalDoc.attrs,
			h.context.originalDoc.content,
			h.context.originalDoc.marks
		);
		expect(replacement).not.toBe(h.context.originalDoc);
		expect(replacement.eq(h.context.originalDoc)).toBe(true);
		h.view.updateState(EditorState.create({ schema, doc: replacement }));
		h.packagePrompt.resolve(request.id, 'add-and-insert');
		await expect(pending).resolves.toBe(false);
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		h.view.destroy();
	});

	it('aborts the pending provider request when the captured document closes', async () => {
		const h = makeHarness();
		const pending = h.coordinator.requestPackage(h.context, 'graphicx');
		h.document.close();
		h.coordinator.invalidate();
		await expect(pending).resolves.toBe(false);
		expect(h.packagePrompt.active).toBeNull();
		expect(h.coordinator.refreshAfterPackage(h.context)).toBeNull();
		h.view.destroy();
	});
});

describe('Draw.io existing figure identity and relink gates', () => {
	it('rejects a marker id that does not match its UUID source path', () => {
		const h = makeHarness();
		const { context } = beginExistingDiagram(h, drawioFigureAttrs(FIGURE_ID, RELINK_ID));
		expect(context).toBeTruthy();
		expect(h.coordinator.existing(context!)).toBeNull();
		h.coordinator.release(context!);
	});

	it('rejects a different diagram type and non-UUID source paths when reopening', () => {
		const wrongTypeHarness = makeHarness();
		const wrongType = beginExistingDiagram(wrongTypeHarness, drawioFigureAttrs(FIGURE_ID, FIGURE_ID, 'mermaid'));
		expect(wrongType.context).toBeNull();

		const invalidPathHarness = makeHarness();
		const invalidPath = beginExistingDiagram(invalidPathHarness, {
			...drawioFigureAttrs(),
			diagramSource: 'assets/diagrams/flow-not-a-uuid.drawio'
		});
		expect(invalidPath.context).toBeTruthy();
		expect(invalidPathHarness.coordinator.existing(invalidPath.context!)).toBeNull();
		invalidPathHarness.coordinator.release(invalidPath.context!);
	});

	it('rejects structurally equal replacement nodes before a pending edit can publish', async () => {
		const h = makeHarness();
		const { image, context } = beginExistingDiagram(h, drawioFigureAttrs());
		expect(context).toBeTruthy();
		const replacement = schema.nodes.image.create(drawioFigureAttrs());
		expect(replacement.eq(image)).toBe(true);
		expect(replacement).not.toBe(image);
		h.view.updateState(EditorState.create({ schema, doc: schema.nodes.doc.create(null, [replacement]) }));
		expect(h.coordinator.existing(context!)).toBeNull();
		await expect(
			h.coordinator.publishAndInsert(context!, {
				sourcePath: `assets/diagrams/flow-${FIGURE_ID}.drawio`,
				source: '<mxfile/>',
				svg: '<svg/>',
				caption: '',
				label: null,
				widthPercent: 80
			})
		).resolves.toBe(false);
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		h.coordinator.release(context!);
	});

	it('allows a source change only after explicit relink and still requires a real PDF producer', async () => {
		const h = makeHarness();
		const { context } = beginExistingDiagram(h, drawioFigureAttrs());
		expect(context).toBeTruthy();
		const input = {
			sourcePath: `assets/diagrams/flow-${RELINK_ID}.drawio`,
			source: '<mxfile/>',
			svg: '<svg/>',
			caption: '',
			label: null,
			widthPercent: 80
		};
		await expect(h.coordinator.publishAndInsert(context!, input)).resolves.toBe(false);
		expect(h.coordinator.authorizeRelink(context!, input.sourcePath)).toBe(true);
		await expect(h.coordinator.publishAndInsert(context!, input)).rejects.toThrow('DIAGRAM_WRITE_UNAVAILABLE');
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		h.coordinator.release(context!);
	});
});

describe('Draw.io publish package gate', () => {
	const input = {
		sourcePath: `assets/diagrams/flow-${FIGURE_ID}.drawio`,
		source: '<mxfile/>',
		svg: '<svg/>',
		caption: 'A diagram',
		label: 'fig:diagram',
		widthPercent: 80
	};

	it('inserts after the user authorizes graphicx; the bridge is a test double, not native acceptance', async () => {
		const h = makeHarness();
		const bridge = installMockDiagramBridge(input.sourcePath);
		const pending = h.coordinator.publishAndInsert(h.context, input);
		await vi.waitFor(() => expect(h.packagePrompt.active).not.toBeNull());
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'add-and-insert');

		await expect(pending).resolves.toBe(true);
		expect(bridge.diagramWrite).toHaveBeenCalledOnce();
		expect(bridge.diagramRenderPdf).toHaveBeenCalledOnce();
		expect(h.document.texSource).toContain('\\usepackage{graphicx}');
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.document.texSource }]);
		let inserted: typeof h.view.state.doc.firstChild | null = null;
		h.view.state.doc.descendants((node) => {
			if (node.type.name === 'image') inserted = node as typeof inserted;
		});
		expect(inserted).toBeTruthy();
		expect(inserted!.attrs).toMatchObject({
			src: input.sourcePath.replace(/\.drawio$/, '.pdf'),
			diagramType: 'drawio',
			diagramId: FIGURE_ID,
			diagramSource: input.sourcePath,
			label: 'fig:diagram'
		});
		expect(inserted!.attrs.options).toContain('0.8\\linewidth');
	});

	it('does not insert or mutate the document after cancel or an observed foreign-source change', async () => {
		const cancelled = makeHarness();
		installMockDiagramBridge(input.sourcePath);
		const cancelledPending = cancelled.coordinator.publishAndInsert(cancelled.context, input);
		await vi.waitFor(() => expect(cancelled.packagePrompt.active).not.toBeNull());
		cancelled.packagePrompt.resolve(cancelled.packagePrompt.active!.id, 'cancel');
		await expect(cancelledPending).resolves.toBe(false);
		expect(cancelled.document.texSource).toBe(source);
		expect(cancelled.scheduled).toEqual([]);
		expect(cancelled.view.state.doc.textContent).not.toContain('A diagram');

		const changed = makeHarness();
		installMockDiagramBridge(input.sourcePath);
		const changedPending = changed.coordinator.publishAndInsert(changed.context, input);
		await vi.waitFor(() => expect(changed.packagePrompt.active).not.toBeNull());
		const requestId = changed.packagePrompt.active!.id;
		const newerSource = source.replace('Body text.', 'External edit.');
		changed.document.onTexInput(newerSource);
		changed.coordinator.observe(changed.snapshot());
		changed.packagePrompt.resolve(requestId, 'add-and-insert');
		await expect(changedPending).resolves.toBe(false);
		expect(changed.document.texSource).toBe(newerSource);
		expect(changed.scheduled).toEqual([{ path: '/ws/main.tex', content: newerSource }]);
		expect(changed.view.state.doc.textContent).not.toContain('A diagram');
	});
});

describe('PackagePrompt mounted accessibility behavior', () => {
	it('focuses the first enabled decision when Add is disabled, traps Tab, cancels on Escape, and restores focus', async () => {
		const trigger = document.body.appendChild(document.createElement('button'));
		trigger.textContent = 'Open prompt';
		trigger.focus();
		const promptController = new PackagePromptController();
		const abortController = new AbortController();
		const pending = promptController.ask('graphicx', false, abortController.signal);
		const promptId = promptController.active!.id;
		const onResolve = vi.fn((id: number, choice: 'add-and-insert' | 'insert-without-package' | 'cancel') =>
			promptController.resolve(id, choice)
		);
		const host = document.body.appendChild(document.createElement('div'));
		const props = {
			get request() {
				return promptController.active;
			},
			onResolve
		};
		const component = mount(PackagePrompt, { target: host, props });
		flushSync();
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		const addButton = host.querySelector<HTMLButtonElement>('[data-dialog-action][disabled]');
		const firstDecision = host.querySelector<HTMLButtonElement>('[data-dialog-action]:not([disabled])');
		expect(addButton).not.toBeNull();
		expect(document.activeElement).toBe(firstDecision);
		expect(firstDecision).not.toBe(addButton);

		const focusable = [...dialog!.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
		const first = focusable[0];
		const last = focusable.at(-1)!;
		last.focus();
		last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(first);
		first.focus();
		first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(last);

		firstDecision!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		flushSync();
		await expect(pending).resolves.toBe('cancel');
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(onResolve).toHaveBeenCalledWith(promptId, 'cancel');
		expect(host.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);

		await unmount(component);
	});
});
