import type { EditorView } from 'prosemirror-view';
import { samePath } from '$lib/workspace/fileSystem';
import { addLatexPackage, hasLatexPackage } from '$lib/workspace/packagePatch';
import type { DocumentBuffer, FileKind } from '$lib/workspace/documentBuffer.svelte';
import type { PackagePromptController } from '$lib/diagram/package-prompt.svelte';

export interface MathPackageRequester {
	ensureAmsmath(signal: AbortSignal, targetIsCurrent: () => boolean): Promise<MathPackageGateLease | null>;
}

/** Revalidate immediately before insertion, including after a caller has awaited focus restoration. */
export interface MathPackageGateLease {
	isCurrent(): boolean;
}

export const MATH_PACKAGE_CONTEXT = Symbol('modutex.math-package-requester');

export interface MathPackageCoordinatorHost {
	getActivePath(): string | null;
	getKind(): FileKind;
	getView(): EditorView | null;
	getViewMode(): 'visual' | 'source' | 'diff';
	/** Let CodeMirror reconcile the package-only buffer splice before source insertion resumes. */
	afterPackageChange(): Promise<boolean>;
	onPackageError?(error: unknown): void;
}

/** The amsmath prompt and real DocumentBuffer insertion shared by every matrix entry point. */
export class MathPackageCoordinator implements MathPackageRequester {
	constructor(
		private readonly document: DocumentBuffer,
		private readonly packagePrompt: PackagePromptController,
		private readonly host: MathPackageCoordinatorHost
	) {}

	async ensureAmsmath(signal: AbortSignal, targetIsCurrent: () => boolean): Promise<MathPackageGateLease | null> {
		const path = this.document.path;
		const kind = this.host.getKind();
		const activePath = this.host.getActivePath();
		const viewMode = this.host.getViewMode();
		const view = this.host.getView();
		const viewDoc = view?.state.doc ?? null;
		const sourceBefore = this.document.texSource;
		let expectedSource = sourceBefore;
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
			this.document.path === path &&
			samePath(this.host.getActivePath() ?? '', path) &&
			this.host.getKind() === kind &&
			this.host.getViewMode() === viewMode &&
			this.host.getView() === view &&
			(!view || view.state.doc === viewDoc) &&
			this.document.texSource === expectedSource &&
			targetIsCurrent();

		const lease: MathPackageGateLease = { isCurrent };
		if (hasLatexPackage(sourceBefore, 'amsmath')) return isCurrent() ? lease : null;

		let canAdd = !this.document.docMeta || this.document.docMeta.hadDocumentEnv;
		if (canAdd) {
			try {
				// The dialog reflects the same conservative literal-preamble validation that the
				// eventual DocumentBuffer splice will use. In particular, parsed metadata alone is
				// not enough to claim that an unfamiliar source preamble can be edited safely.
				addLatexPackage(sourceBefore, 'amsmath');
			} catch {
				canAdd = false;
			}
		}
		const choice = await this.packagePrompt.ask('amsmath', canAdd, signal);
		if (!isCurrent() || choice === null || choice === 'cancel') return null;
		if (choice === 'add-and-insert' && !canAdd) return null;

		try {
			if (this.document.resolvePackageInsertion('amsmath', choice) !== 'insert') return null;
			const sourceAfter = this.document.texSource;
			expectedSource = sourceAfter;
			if (sourceAfter !== sourceBefore && !(await this.host.afterPackageChange())) return null;
			return isCurrent() ? lease : null;
		} catch (error) {
			this.host.onPackageError?.(error);
			return null;
		}
	}
}
