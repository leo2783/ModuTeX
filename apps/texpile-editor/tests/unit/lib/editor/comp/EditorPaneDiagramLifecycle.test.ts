// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { get } from 'svelte/store';
import { EditorState } from 'prosemirror-state';
import { EditorView as ProseMirrorEditorView } from 'prosemirror-view';

vi.mock('$lib/editor/EditorView.svelte', async () => ({
	default: (await import('../../../../fixtures/DiagramEditorReady.svelte')).default
}));
vi.mock('$lib/editor/comp/toolbar/Toolbar.svelte', async () => ({
	default: (await import('../../../../fixtures/EmptyEditorToolbar.svelte')).default
}));

import EditorPane from '$lib/editor/comp/EditorPane.svelte';
import { editorViewStore } from '$lib/stores/editorStore';
import { schema } from '$lib/schema/schema';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';
import { FigureCoordinator, FIGURE_COORDINATOR_CONTEXT, type FigureCoordinatorSnapshot } from '$lib/diagram/figure-coordinator';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { m } from '$lib/paraglide/messages';

const path = '/ws/main.tex';
const source = '\\documentclass{article}\r\n\\begin{document}\r\nBody text.\r\n\\end{document}\r\n';
let mounted: ReturnType<typeof mount> | null = null;
let pmView: ProseMirrorEditorView | null = null;
let nativeBridgeDescriptor: PropertyDescriptor | undefined;

afterEach(async () => {
	if (mounted) await unmount(mounted);
	mounted = null;
	if (pmView && !pmView.isDestroyed) pmView.destroy();
	pmView = null;
	editorViewStore.set(null);
	for (const element of [...document.body.children]) element.remove();
	if (nativeBridgeDescriptor) Object.defineProperty(window, 'texpileNative', nativeBridgeDescriptor);
	else Reflect.deleteProperty(window, 'texpileNative');
});

function makeBuffer() {
	const queued: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (savePath, content) => queued.push({ path: savePath, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor: () => {}
	};
	const buffer = new DocumentBuffer(deps);
	buffer.openTex(path, source, '\r\n');
	buffer.adoptParsed(parseLatexFile(source));
	return { buffer, queued };
}

function paneProps(visualDoc: ComponentProps<typeof EditorPane>['visualDoc']): ComponentProps<typeof EditorPane> {
	return {
		loadedPath: path,
		openTabs: [path],
		onActivateTab: () => {},
		onCloseTab: () => {},
		kind: 'tex',
		viewMode: 'visual',
		folderEmpty: false,
		loadError: null,
		applyingStarter: false,
		texSource: source,
		rawContent: '',
		visualDoc,
		docMeta: null,
		allReferences: [],
		sourceGotoLine: undefined,
		sourceScrollAnchor: null,
		sourceDiagnostics: [],
		diffOriginal: '',
		diffModified: '',
		diffLayout: 'unified',
		diffLoading: false,
		diffError: null,
		diffHasHead: false,
		fileUrl: (file) => file,
		onPickStarter: () => {},
		onBlankStarter: () => {},
		onImportStarter: () => {},
		onTexInput: () => {},
		onRawInput: () => {},
		onVisualChange: () => {},
		onEditFrontmatter: () => {},
		onAddTitle: vi.fn(),
		onSyncToPdf: () => {},
		onHistoryBoundary: () => false,
		onJumpToFile: () => {},
		onOpenFileAt: () => {},
		onToggleDiffLayout: () => {},
		onRefreshDiff: () => {},
		onExitDiff: () => {}
	};
}

describe('EditorPane diagram capability lifecycle', () => {
	it('passes the exact live coordinator context into the mounted modal and cancels without source mutation', async () => {
		nativeBridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'texpileNative');
		Reflect.deleteProperty(window, 'texpileNative');
		const { buffer, queued } = makeBuffer();
		const hostState = { activePath: path, kind: 'tex' as const, viewMode: 'visual' as const };
		const snapshot = (): FigureCoordinatorSnapshot => ({
			path: buffer.path,
			kind: buffer.kind,
			activePath: hostState.activePath,
			view: get(editorViewStore),
			viewMode: hostState.viewMode,
			source: buffer.texSource,
			visualDoc: buffer.visualDoc
		});
		const coordinator = new FigureCoordinator(buffer, new PackagePromptController(), {
			getActivePath: () => hostState.activePath,
			getKind: () => hostState.kind,
			getView: () => get(editorViewStore),
			getViewMode: () => hostState.viewMode
		});
		coordinator.observe(snapshot());
		const parsed = parseLatexFile(source);
		pmView = new ProseMirrorEditorView(document.body.appendChild(document.createElement('div')), {
			state: EditorState.create({ schema, doc: parsed.doc })
		});
		editorViewStore.set(pmView);
		const isCurrent = vi.spyOn(coordinator, 'isCurrent');
		const begin = vi.spyOn(coordinator, 'begin');
		const host = document.body.appendChild(document.createElement('div'));
		mounted = mount(EditorPane, {
			target: host,
			context: new Map([[FIGURE_COORDINATOR_CONTEXT, coordinator]]),
			props: paneProps(parsed.doc)
		});

		// Mount the real EditorPane and real ProseMirror view. Only its heavyweight EditorView shell
		// is replaced with a test seam that fires the same ready callback; the Draw.io modal and native
		// bridge boundary remain real, and this test intentionally provides no native bridge.
		flushSync();
		const toolbarButton = host.querySelector<HTMLButtonElement>(`button[aria-label="${m.blockmenu_drawio_diagram()}"]`);
		expect(toolbarButton).toBeTruthy();
		toolbarButton!.click();
		flushSync();

		const context = begin.mock.results.at(-1)?.value;
		expect(context).toBeTruthy();
		const mountedChecks = isCurrent.mock.calls.slice(-4).map(([checked]) => checked);
		expect(mountedChecks.length).toBeGreaterThan(1);
		expect(mountedChecks.at(-1)).toBe(context);
		expect(host.querySelector('iframe[src="drawio://bundle/relay.html"]')).toBeTruthy();
		const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === m.comments_save());
		expect(save?.disabled).toBe(true);
		expect(host.textContent).not.toContain(m.diagram_operation_cancelled());
		expect(buffer.texSource).toBe(source);
		expect(queued).toEqual([]);

		const cancel = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === m.comments_cancel());
		expect(cancel).toBeTruthy();
		cancel!.click();
		flushSync();
		expect(host.querySelector('iframe[src="drawio://bundle/relay.html"]')).toBeNull();
		expect(coordinator.isCurrent(context!)).toBe(false);
		expect(buffer.texSource).toBe(source);
		expect(queued).toEqual([]);
		expect(Reflect.get(window, 'texpileNative')).toBeUndefined();
	});
});
