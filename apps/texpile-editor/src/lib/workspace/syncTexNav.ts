// SyncTeX navigation: source line <-> place in the locally compiled PDF.
//
// SyncTeX needs the document compiled with -synctex=1; the default compile command does it.
import { get } from 'svelte/store';
import { synctexForward, synctexInverse } from '$lib/workspace/synctex';
import { workspaceRoot, activeFilePath } from '$lib/workspace/workspaceStore';
import { samePath } from '$lib/workspace/fileSystem';
import { settings } from '$lib/settings';
import { sourceCmView } from '$lib/stores/editorStore';
import { toaster } from '$lib/modals/toaster-svelte';
import { m } from '$lib/paraglide/messages';

export interface SyncTexDeps {
	getLoadedPath(): string | null;
	/** only .tex files carry SyncTeX positions */
	isTex(): boolean;
	/** root of the draft-mode preview, whose reconcile PDF has the layout the canvases show */
	getDraftRoot(): string;
	expectedPdfPath(): string | null;
	setPdfPaneOpen(open: boolean): void;
	/** scroll the mounted PDF pane, retrying while it is still mounting */
	scrollPdfTo(page: number, x: number, y: number, w: number, h: number): void;
	/** draft mode highlights inside DraftView instead of the standalone pane */
	syncDraftTo(page: number, x: number, y: number, w: number, h: number): void;
	openFileAtLine(file: string, line: number, selectText?: string): void;
}

/** normalize a path out of synctex to the workspace separator so it matches the open file */
export function normSyncPath(p: string): string {
	const root = get(workspaceRoot) ?? '';
	const sep = root.includes('\\') ? '\\' : '/';
	return p.replace(/[\\/]+/g, sep);
}

export class SyncTexNav {
	constructor(private deps: SyncTexDeps) {}

	/** forward: a source line -> the matching place in the PDF (scroll + flash a highlight) */
	async forwardToLine(line: number): Promise<void> {
		const d = this.deps;
		const live = get(settings).draftMode;
		const pdf = live ? d.getDraftRoot() + '/_draft/draft.pdf' : d.expectedPdfPath();
		const path = d.getLoadedPath();
		if (!path || !d.isTex() || !pdf) return;
		const res = await synctexForward(pdf, path, line);
		console.debug('[synctex] forward', { tex: path, line, pdf, res });
		if (!res.ok) {
			toaster.error({ title: 'SyncTeX', description: res.error ?? m.wsview_toast_synctex_no_match() });
			return;
		}
		d.setPdfPaneOpen(true);
		// highlight the enclosing box: origin (h, v) = line-start + baseline, size (W, H). NOT (x, y),
		// the matched node's point: pairing that with W/H drew the box shifted and ~a line too low.
		if (live) d.syncDraftTo(res.page, res.h, res.v, res.width, res.height);
		else d.scrollPdfTo(res.page, res.h, res.v, res.width, res.height);
	}

	/** forward from the current cursor (the header "Sync to PDF" button) */
	async forwardFromCursor(): Promise<void> {
		const cm = get(sourceCmView);
		if (!cm || !cm.dom.isConnected) return;
		await this.forwardToLine(cm.state.doc.lineAt(cm.state.selection.main.head).number);
	}

	/** inverse: a double-click in the PDF opens the source at the matching line. selectText lets
	 * the editor snap to the real text even if the line drifted since the compile. */
	async inverseFromClick(page: number, x: number, y: number, selectText?: string): Promise<void> {
		const d = this.deps;
		const pdf = d.expectedPdfPath();
		if (!pdf) return;
		const res = await synctexInverse(pdf, page, x, y);
		console.debug('[synctex] inverse', { pdf, page, x, y, res, selectText });
		if (res.ok && res.input && res.line >= 1) d.openFileAtLine(normSyncPath(res.input), res.line, selectText);
	}
}

/** true when the target differs from what is already active and so needs an open */
export function needsActivate(target: string): boolean {
	return !samePath(get(activeFilePath) ?? '', target);
}
