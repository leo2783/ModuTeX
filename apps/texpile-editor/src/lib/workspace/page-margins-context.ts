import type { EditorView } from 'prosemirror-view';
import { get } from 'svelte/store';
import type { DocumentBuffer, FileKind } from './documentBuffer.svelte';
import { samePath } from './fileSystem';
import type { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { isReadOnly } from '$lib/stores/permissionStore';
import { inspectPageMargins, patchPageMargins, type PageMargins } from './geometryPatch';

export const PAGE_MARGINS_CONTEXT = Symbol('modutex.page-margins-coordinator');

export type PageMarginsDialogSnapshot = { kind: 'ready'; source: string; values: PageMargins } | { kind: 'blocked'; reason: string };

export type PageMarginsApplyResult = 'applied' | 'cancelled' | 'stale' | 'blocked' | 'invalid' | 'sync-failed';

export interface PageMarginsHost {
	getActivePath(): string | null;
	getKind(): FileKind;
	getView(): EditorView | null;
	getViewMode(): 'visual' | 'source' | 'diff';
	afterPreambleChange(): Promise<boolean>;
	onError?(error: unknown): void;
}

/** Applies only an exact, parser-verified preamble splice to the currently open TeX source. */
export class PageMarginsCoordinator {
	constructor(
		private readonly document: DocumentBuffer,
		private readonly packagePrompt: PackagePromptController,
		private readonly host: PageMarginsHost
	) {}

	inspect(): PageMarginsDialogSnapshot {
		const path = this.document.path;
		const viewMode = this.host.getViewMode();
		const view = this.host.getView();
		if (
			!path ||
			!samePath(this.host.getActivePath() ?? '', path) ||
			this.host.getKind() !== 'tex' ||
			viewMode === 'diff' ||
			(viewMode === 'visual' && (!view || !view.dom.isConnected)) ||
			get(isReadOnly)
		) {
			return { kind: 'blocked', reason: 'not-editable' };
		}
		const result = inspectPageMargins(this.document.texSource);
		return result.kind === 'ready'
			? { kind: 'ready', source: this.document.texSource, values: result.values }
			: { kind: 'blocked', reason: result.reason };
	}

	async apply(values: PageMargins, expectedSource: string, signal: AbortSignal): Promise<PageMarginsApplyResult> {
		if (signal.aborted) return 'cancelled';
		const path = this.document.path;
		const kind = this.host.getKind();
		const activePath = this.host.getActivePath();
		const viewMode = this.host.getViewMode();
		const view = this.host.getView();
		const viewDoc = view?.state.doc ?? null;
		if (!path || !activePath || !samePath(path, activePath) || kind !== 'tex' || viewMode === 'diff' || get(isReadOnly)) return 'blocked';
		if ((viewMode === 'visual' && !view) || (view && !view.dom.isConnected) || this.document.texSource !== expectedSource) return 'stale';

		let expected = expectedSource;
		const isCurrent = (): boolean =>
			!signal.aborted &&
			!get(isReadOnly) &&
			this.document.path === path &&
			samePath(this.host.getActivePath() ?? '', path) &&
			this.host.getKind() === kind &&
			this.host.getViewMode() === viewMode &&
			this.host.getView() === view &&
			(!view || (view.dom.isConnected && view.state.doc === viewDoc)) &&
			this.document.texSource === expected;

		let plan = patchPageMargins(expected, values);
		if (plan.kind === 'invalid-values') return 'invalid';
		if (plan.kind === 'blocked') return 'blocked';
		if (plan.kind === 'needs-package') {
			const consentPlan = patchPageMargins(expected, values, true);
			if (consentPlan.kind !== 'ready' || !consentPlan.addedGeometryPackage) return 'blocked';
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal.addEventListener('abort', abort, { once: true });
			try {
				const choice = await this.packagePrompt.ask('geometry', true, controller.signal);
				if (!isCurrent()) return 'stale';
				if (choice === null || choice === 'cancel') return 'cancelled';
				if (choice !== 'add-and-insert') return 'cancelled';
				plan = consentPlan;
			} finally {
				signal.removeEventListener('abort', abort);
			}
		}

		if (!isCurrent()) return 'stale';
		if (plan.kind !== 'ready') return 'blocked';
		if (!this.document.applyPreamblePatch(expected, plan.originalPreamble, plan.source, plan.preamble)) return 'stale';
		expected = plan.source;
		if (!isCurrent()) return 'stale';
		try {
			return (await this.host.afterPreambleChange()) ? 'applied' : 'sync-failed';
		} catch (error) {
			this.host.onError?.(error);
			return 'sync-failed';
		}
	}
}
