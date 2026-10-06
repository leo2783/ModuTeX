// Reports what this window is showing to the Electron main process, for the MCP get_editor_state
// tool. Push, not pull: main caches the last payload, so a tool call answers instantly even while
// this renderer is blocked building a large ProseMirror document.
//
// Called from a $effect in WorkspaceView. Every store below is read with get(), which does NOT
// register a dependency - so that effect names them itself. Adding a store-backed field here means
// adding it there too, or the cache silently stops reflecting it.
import { get } from 'svelte/store';
import { browser } from '$lib/runtime';
import { workspaceRoot, mainFile, activeFilePath, isDirty } from './workspaceStore';
import { settings } from '$lib/settings';
import { tabs } from './tabs.svelte';
import { sourceCmView } from '$lib/stores/editorStore';
import { relativeTo } from './fileSystem';

export type ViewMode = 'visual' | 'source' | 'diff';

interface TabPayload {
	path: string;
	dirty: boolean;
	active: boolean;
}

export interface WindowStatePayload {
	mainFile: string | null;
	activeFile: string | null;
	viewMode: ViewMode | null;
	tabs: TabPayload[];
	cursor: { line: number; column: number } | null;
	selection: { text: string } | null;
	/** live preview instead of the shell compile. Changes what compile does, which PDF exists, and
	 *  where diagnostics come from, so it belongs in the state an agent reads BEFORE any of that. */
	livePreview: boolean;
}

interface NativeMcp {
	mcpPublishState?: (state: WindowStatePayload) => void;
}
function native(): NativeMcp | undefined {
	if (!browser) return undefined;
	return (window as unknown as { texpileNative?: NativeMcp }).texpileNative;
}

/** paths cross the boundary workspace-relative: an agent thinks in project paths, and absolute
 *  ones would leak the user's home directory for no benefit */
function rel(path: string | null, root: string | null): string | null {
	if (!path) return null;
	if (!root) return path;
	return relativeTo(root, path);
}

/** longer than this and it is not a selection an agent needs verbatim */
const MAX_SELECTION = 2000;

function readCursorAndSelection(view: ViewMode | null): Pick<WindowStatePayload, 'cursor' | 'selection'> {
	// Source mode only. In visual mode the caret is a ProseMirror position, which does not map to a
	// source line without the SyncTeX-style mapping in syncTexNav, and a position an agent cannot
	// interpret is worse than an honest null.
	if (view !== 'source') return { cursor: null, selection: null };
	const cm = get(sourceCmView);
	if (!cm || !cm.dom.isConnected) return { cursor: null, selection: null };
	const { from, to } = cm.state.selection.main;
	const line = cm.state.doc.lineAt(from);
	const text = to > from ? cm.state.sliceDoc(from, Math.min(to, from + MAX_SELECTION)) : '';
	return {
		cursor: { line: line.number, column: from - line.from + 1 },
		selection: text ? { text } : null
	};
}

export function buildWindowState(viewMode: ViewMode | null): WindowStatePayload {
	const root = get(workspaceRoot);
	const active = get(activeFilePath);
	// Only the active file has a buffer, so it is the only one that can be dirty: `isDirty` is a
	// single store and TabBar already paints it on the active tab alone.
	const dirty = get(isDirty);
	const list = tabs.list;
	return {
		mainFile: rel(get(mainFile), root),
		activeFile: rel(active, root),
		viewMode,
		tabs: list.map((p) => ({
			path: rel(p, root) ?? p,
			dirty: dirty && !!active && p === active,
			active: !!active && p === active
		})),
		livePreview: get(settings).draftMode === true,
		...readCursorAndSelection(viewMode)
	};
}

let last = '';

/** Publishes only on change. The effect driving this re-runs on any tracked read, including ones
 *  that leave the payload identical (a keystroke marks the doc dirty every time), and the IPC is
 *  not worth paying for those. */
export function publishWindowState(viewMode: ViewMode | null): void {
	const api = native();
	if (!api?.mcpPublishState) return;
	const payload = buildWindowState(viewMode);
	const key = JSON.stringify(payload);
	if (key === last) return;
	last = key;
	api.mcpPublishState(payload);
}
