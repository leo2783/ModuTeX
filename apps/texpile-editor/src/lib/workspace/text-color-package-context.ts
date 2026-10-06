import type { EditorView } from 'prosemirror-view';
import { get } from 'svelte/store';
import type { DocumentBuffer, FileKind } from '$lib/workspace/documentBuffer.svelte';
import { samePath } from '$lib/workspace/fileSystem';
import { addLatexPackage, hasLatexPackage } from '$lib/workspace/packagePatch';
import { isReadOnly } from '$lib/stores/permissionStore';
import type { PackagePromptController } from '$lib/diagram/package-prompt.svelte';

export interface TextColorGateLease {
	isCurrent(): boolean;
}

export interface TextColorPackageRequester {
	ensureXcolor(signal: AbortSignal, targetIsCurrent: () => boolean): Promise<TextColorGateLease | null>;
}

export const TEXT_COLOR_PACKAGE_CONTEXT = Symbol('modutex.text-color-package-requester');

export interface TextColorPackageCoordinatorHost {
	getActivePath(): string | null;
	getKind(): FileKind;
	getView(): EditorView | null;
	getViewMode(): 'visual' | 'source' | 'diff';
	afterPackageChange(): Promise<boolean>;
	onPackageError?(error: unknown): void;
}

/** One explicit xcolor decision for the visual text-color command. */
export class TextColorPackageCoordinator implements TextColorPackageRequester {
	constructor(
		private readonly document: DocumentBuffer,
		private readonly packagePrompt: PackagePromptController,
		private readonly host: TextColorPackageCoordinatorHost
	) {}

	async ensureXcolor(signal: AbortSignal, targetIsCurrent: () => boolean): Promise<TextColorGateLease | null> {
		if (get(isReadOnly) || signal.aborted) return null;
		const path = this.document.path;
		const activePath = this.host.getActivePath();
		const kind = this.host.getKind();
		const viewMode = this.host.getViewMode();
		const view = this.host.getView();
		const viewDoc = view?.state.doc ?? null;
		const sourceBefore = this.document.texSource;
		let expectedSource = sourceBefore;

		if (!path || !activePath || !samePath(path, activePath) || kind !== 'tex' || viewMode !== 'visual' || !view || !targetIsCurrent()) {
			return null;
		}

		const isCurrent = (): boolean =>
			!signal.aborted &&
			!get(isReadOnly) &&
			this.document.path === path &&
			samePath(this.host.getActivePath() ?? '', path) &&
			this.host.getKind() === kind &&
			this.host.getViewMode() === viewMode &&
			this.host.getView() === view &&
			view.state.doc === viewDoc &&
			this.document.texSource === expectedSource &&
			targetIsCurrent();

		const lease: TextColorGateLease = { isCurrent };
		if (hasLatexPackage(sourceBefore, 'xcolor')) return isCurrent() ? lease : null;

		let canAdd = false;
		try {
			// Use the exact same conservative preamble validation as the eventual authoritative splice.
			addLatexPackage(sourceBefore, 'xcolor');
			canAdd = true;
		} catch {
			// The user can still choose to proceed without changing an unfamiliar preamble.
		}

		const choice = await this.packagePrompt.ask('xcolor', canAdd, signal);
		if (!isCurrent() || choice === null || choice === 'cancel') return null;
		if (choice === 'add-and-insert' && !canAdd) return null;

		try {
			if (this.document.resolvePackageInsertion('xcolor', choice) !== 'insert') return null;
			expectedSource = this.document.texSource;
			if (expectedSource !== sourceBefore && !(await this.host.afterPackageChange())) return null;
			return isCurrent() ? lease : null;
		} catch (error) {
			this.host.onPackageError?.(error);
			return null;
		}
	}
}
