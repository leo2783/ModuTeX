import type { EditorView } from 'prosemirror-view';
import { get } from 'svelte/store';
import type { DocumentBuffer, FileKind } from '$lib/workspace/documentBuffer.svelte';
import { samePath } from '$lib/workspace/fileSystem';
import { addLatexPackage, hasLatexPackage } from '$lib/workspace/packagePatch';
import { isReadOnly } from '$lib/stores/permissionStore';
import type { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import type { TablePreset } from '$lib/editor/comp/toolbar/table-preset-commands';

export interface TablePackagePatchReceipt {
	offset: number;
	insertedLength: number;
}

export interface TablePackageGateLease {
	preset: Extract<TablePreset, 'booktabs' | 'three-line' | 'arydshln'>;
	isCurrent(): boolean;
}

export interface TablePackageRequester {
	ensureBooktabs(
		signal: AbortSignal,
		targetIsCurrent: (patch?: TablePackagePatchReceipt) => boolean
	): Promise<TablePackageGateLease | null>;
	ensureArydshln(
		signal: AbortSignal,
		targetIsCurrent: (patch?: TablePackagePatchReceipt) => boolean
	): Promise<TablePackageGateLease | null>;
}

export const TABLE_PACKAGE_CONTEXT = Symbol('modutex.table-package-requester');

export interface TablePackageCoordinatorHost {
	getActivePath(): string | null;
	getKind(): FileKind;
	getView(): EditorView | null;
	getViewMode(): 'visual' | 'source' | 'diff';
	afterPackageChange(): Promise<boolean>;
	onPackageError?(error: unknown): void;
}

/** One safe package decision shared by visual and source table insertion controls. */
export class TablePackageCoordinator implements TablePackageRequester {
	constructor(
		private readonly document: DocumentBuffer,
		private readonly packagePrompt: PackagePromptController,
		private readonly host: TablePackageCoordinatorHost
	) {}

	async ensureBooktabs(
		signal: AbortSignal,
		targetIsCurrent: (patch?: TablePackagePatchReceipt) => boolean
	): Promise<TablePackageGateLease | null> {
		if (get(isReadOnly) || signal.aborted) return null;
		const path = this.document.path;
		const kind = this.host.getKind();
		const activePath = this.host.getActivePath();
		const viewMode = this.host.getViewMode();
		const view = this.host.getView();
		const viewDoc = view?.state.doc ?? null;
		const sourceBefore = this.document.texSource;
		let expectedSource = sourceBefore;
		let patchReceipt: TablePackagePatchReceipt | undefined;
		if (
			!path ||
			!activePath ||
			!samePath(path, activePath) ||
			kind !== 'tex' ||
			viewMode === 'diff' ||
			(viewMode === 'visual' && !view) ||
			!targetIsCurrent()
		) {
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
			(!view || view.state.doc === viewDoc) &&
			this.document.texSource === expectedSource &&
			targetIsCurrent(patchReceipt);

		if (hasLatexPackage(sourceBefore, 'booktabs')) {
			return isCurrent() ? { preset: 'booktabs', isCurrent } : null;
		}

		let canAdd = false;
		let insertion: ReturnType<typeof addLatexPackage> | null = null;
		try {
			insertion = addLatexPackage(sourceBefore, 'booktabs');
			canAdd = true;
		} catch {
			// Keep the equal-weight three-rule path available when the source preamble is unknown.
		}
		const choice = await this.packagePrompt.ask('booktabs', canAdd, signal);
		if (!isCurrent() || choice === null || choice === 'cancel') return null;
		if (choice === 'add-and-insert' && !canAdd) return null;

		try {
			if (choice === 'add-and-insert') {
				if (!insertion) return null;
				patchReceipt = insertion.kind === 'insert' ? { offset: insertion.offset, insertedLength: insertion.text.length } : undefined;
			}
			if (this.document.resolvePackageInsertion('booktabs', choice) !== 'insert') return null;
			expectedSource = this.document.texSource;
			if (expectedSource !== sourceBefore && !(await this.host.afterPackageChange())) return null;
			if (!isCurrent()) return null;
			return { preset: choice === 'add-and-insert' ? 'booktabs' : 'three-line', isCurrent };
		} catch (error) {
			this.host.onPackageError?.(error);
			return null;
		}
	}

	async ensureArydshln(
		signal: AbortSignal,
		targetIsCurrent: (patch?: TablePackagePatchReceipt) => boolean
	): Promise<TablePackageGateLease | null> {
		if (get(isReadOnly) || signal.aborted) return null;
		const path = this.document.path;
		const kind = this.host.getKind();
		const activePath = this.host.getActivePath();
		const viewMode = this.host.getViewMode();
		const view = this.host.getView();
		const viewDoc = view?.state.doc ?? null;
		const sourceBefore = this.document.texSource;
		let expectedSource = sourceBefore;
		let patchReceipt: TablePackagePatchReceipt | undefined;
		if (
			!path ||
			!activePath ||
			!samePath(path, activePath) ||
			kind !== 'tex' ||
			viewMode === 'diff' ||
			(viewMode === 'visual' && !view) ||
			!targetIsCurrent()
		) {
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
			(!view || view.state.doc === viewDoc) &&
			this.document.texSource === expectedSource &&
			targetIsCurrent(patchReceipt);

		if (hasLatexPackage(sourceBefore, 'arydshln')) {
			return isCurrent() ? { preset: 'arydshln', isCurrent } : null;
		}

		let insertion: ReturnType<typeof addLatexPackage> | null = null;
		try {
			insertion = addLatexPackage(sourceBefore, 'arydshln');
		} catch {
			// The dialog explains that no safe preamble insertion point is available.
		}
		const canAdd = insertion !== null;
		const choice = await this.packagePrompt.ask('arydshln', canAdd, signal);
		if (!isCurrent() || choice !== 'add-and-insert' || !canAdd || !insertion) return null;

		try {
			patchReceipt = insertion.kind === 'insert' ? { offset: insertion.offset, insertedLength: insertion.text.length } : undefined;
			if (this.document.resolvePackageInsertion('arydshln', choice) !== 'insert') return null;
			expectedSource = this.document.texSource;
			if (expectedSource !== sourceBefore && !(await this.host.afterPackageChange())) return null;
			if (!isCurrent()) return null;
			return { preset: 'arydshln', isCurrent };
		} catch (error) {
			this.host.onPackageError?.(error);
			return null;
		}
	}
}

let activeRequester: TablePackageRequester | null = null;

/** NodeViews are mounted outside Svelte's component context; keep their optional requester scoped to the live workspace. */
export function setActiveTablePackageRequester(requester: TablePackageRequester | null): void {
	activeRequester = requester;
}

export function getActiveTablePackageRequester(): TablePackageRequester | null {
	return activeRequester;
}
