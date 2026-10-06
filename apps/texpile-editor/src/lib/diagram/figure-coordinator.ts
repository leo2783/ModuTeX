import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';
import type { DiagramType } from 'modutex-contracts';
import type { DocumentBuffer, FileKind } from '$lib/workspace/documentBuffer.svelte';
import { samePath } from '$lib/workspace/fileSystem';
import { hasLatexPackage } from '$lib/workspace/packagePatch';
import type { ExistingDiagram } from './events';
import { PackagePromptController } from './package-prompt.svelte';
import { diagramIdFromSource, saveDiagramBundle } from './client';
import { sanitizeLabel } from '$lib/editor/utils/label';

export type FigureIntent = 'insert' | 'edit';

export interface FigureOperationContext {
	readonly type: DiagramType;
	readonly path: string;
	readonly kind: 'tex';
	readonly originalSource: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	readonly view: EditorView;
	/** Exact ProseMirror document object captured before async work starts. */
	readonly originalDoc: PMNode;
	readonly target: {
		readonly pos: number;
		readonly node: PMNode;
		readonly intent: FigureIntent;
		readonly placement: 'after' | 'replace';
	} | null;
}

export interface FigureCommitInput {
	sourcePath: string;
	source: string;
	svg: string;
	caption: string;
	label: string | null;
	widthPercent: number;
}

export interface FigureCoordinatorSnapshot {
	path: string | null;
	kind: FileKind;
	activePath: string | null;
	view: EditorView | null;
	viewMode: 'visual' | 'source' | 'diff';
	source: string;
	visualDoc: PMNode | null;
}

export interface FigureCoordinatorHost {
	getActivePath: () => string | null;
	getKind: () => FileKind;
	getView: () => EditorView | null;
	getViewMode: () => 'visual' | 'source' | 'diff';
	onPackageError?: (error: unknown) => void;
}

interface ActiveOperation {
	context: FigureOperationContext;
	controller: AbortController;
	detachExternalAbort: () => void;
}

/**
 * Renderer-side lifecycle gate shared by the editor-owned diagram panels. It owns the real
 * DocumentBuffer instance passed by WorkspaceView and rechecks exact document/target identity
 * around native publication and package-prompt awaits.
 */
export class FigureCoordinator {
	private generation = 0;
	private lastSnapshot: FigureCoordinatorSnapshot | null = null;
	private expectedPackagePatch: { context: FigureOperationContext; source: string } | null = null;
	private knownPackagePatches = new Map<FigureOperationContext, { before: string; after: string }>();
	private relinkedSources = new Map<FigureOperationContext, string>();
	private operations = new Map<FigureOperationContext, ActiveOperation>();

	constructor(
		private readonly document: DocumentBuffer,
		readonly packagePrompt: PackagePromptController,
		private readonly host: FigureCoordinatorHost
	) {}

	observe(snapshot: FigureCoordinatorSnapshot): void {
		const previous = this.lastSnapshot;
		this.lastSnapshot = snapshot;
		if (!previous) return;

		const sourceChanged = previous.source !== snapshot.source;
		const expectedPackagePatch = sourceChanged && snapshot.source === this.expectedPackagePatch?.source;
		if (expectedPackagePatch) this.expectedPackagePatch = null;

		if (
			previous.path !== snapshot.path ||
			previous.kind !== snapshot.kind ||
			previous.activePath !== snapshot.activePath ||
			previous.view !== snapshot.view ||
			previous.viewMode !== snapshot.viewMode ||
			previous.visualDoc !== snapshot.visualDoc ||
			(sourceChanged && !expectedPackagePatch)
		) {
			this.invalidate();
		}
	}

	/** Invalidate pending package prompts and async work when the document lifecycle changes. */
	invalidate(): void {
		this.generation += 1;
		this.packagePrompt.cancel();
		for (const operation of this.operations.values()) {
			operation.controller.abort();
			operation.detachExternalAbort();
		}
		this.operations.clear();
		this.knownPackagePatches.clear();
		this.relinkedSources.clear();
		this.expectedPackagePatch = null;
	}

	begin(
		type: DiagramType,
		view: EditorView,
		externalSignal: AbortSignal,
		target: { pos: number; intent: FigureIntent; placement?: 'after' | 'replace' } | null = null
	): FigureOperationContext | null {
		if (externalSignal.aborted || !this.canStart(type, view)) return null;
		const path = this.document.path;
		if (!path) return null;

		const originalDoc = view.state.doc;
		let capturedTarget: FigureOperationContext['target'] = null;
		if (target) {
			if (!Number.isSafeInteger(target.pos) || target.pos < 0) return null;
			const node = originalDoc.nodeAt(target.pos);
			if (!node) return null;
			if (target.intent === 'edit' && (node.type.name !== 'image' || node.attrs.diagramType !== type)) return null;
			capturedTarget = { pos: target.pos, node, intent: target.intent, placement: target.placement ?? 'after' };
		}

		const controller = new AbortController();
		const relayAbort = () => controller.abort(externalSignal.reason);
		externalSignal.addEventListener('abort', relayAbort, { once: true });
		const context: FigureOperationContext = Object.freeze({
			type,
			path,
			kind: 'tex',
			originalSource: this.document.texSource,
			generation: this.generation,
			signal: controller.signal,
			view,
			originalDoc,
			target: capturedTarget
		});
		const operation: ActiveOperation = {
			context,
			controller,
			detachExternalAbort: () => externalSignal.removeEventListener('abort', relayAbort)
		};
		this.operations.set(context, operation);
		if (externalSignal.aborted || !this.isCurrent(context)) {
			this.abort(context);
			return null;
		}
		return context;
	}

	isCurrent(context: FigureOperationContext): boolean {
		if (!this.operations.has(context) || context.signal.aborted || context.generation !== this.generation) return false;
		if (context.kind !== 'tex' || this.document.kind !== 'tex' || this.host.getKind() !== 'tex') return false;
		if (!this.document.path || !samePath(this.document.path, context.path)) return false;
		if (this.document.texSource !== context.originalSource) return false;
		const activePath = this.host.getActivePath();
		if (!activePath || !samePath(activePath, context.path)) return false;
		if (this.host.getViewMode() !== 'visual' || this.host.getView() !== context.view) return false;
		if (context.view.isDestroyed || !context.view.dom.isConnected || context.view.state.doc !== context.originalDoc) return false;
		if (context.target && context.view.state.doc.nodeAt(context.target.pos) !== context.target.node) return false;
		return true;
	}

	/** Existing figure metadata is read only from the exact image node captured for this operation. */
	existing(context: FigureOperationContext): ExistingDiagram | null {
		if (!this.isCurrent(context) || context.target?.intent !== 'edit') return null;
		const node = context.target.node;
		const id = node.attrs.diagramId;
		const sourcePath = node.attrs.diagramSource;
		if (node.type.name !== 'image' || node.attrs.diagramType !== context.type || typeof id !== 'string' || typeof sourcePath !== 'string')
			return null;
		try {
			if (diagramIdFromSource(sourcePath, context.type === 'mermaid' ? 'mmd' : 'drawio') !== id) return null;
		} catch {
			return null;
		}
		return {
			id,
			sourcePath,
			caption: node.textContent,
			label: typeof node.attrs.label === 'string' ? node.attrs.label : null,
			widthPercent: figureWidthPercent(node)
		};
	}

	/** Record only a source path returned by the validated native relink picker for this operation. */
	authorizeRelink(context: FigureOperationContext, sourcePath: string): boolean {
		if (!this.isCurrent(context) || context.target?.intent !== 'edit') return false;
		try {
			diagramIdFromSource(sourcePath, context.type === 'mermaid' ? 'mmd' : 'drawio');
		} catch {
			return false;
		}
		this.relinkedSources.set(context, sourcePath);
		return true;
	}

	/** Package gate only. Figure insertion remains unavailable until a real PDF producer is integrated. */
	async requestPackage(context: FigureOperationContext, packageName: 'graphicx'): Promise<boolean> {
		if (!this.isCurrent(context)) return false;
		if (hasLatexPackage(this.document.texSource, packageName)) return this.isCurrent(context);

		const canAdd = this.document.docMeta?.hadDocumentEnv === true;
		const choice = await this.packagePrompt.ask(packageName, canAdd, context.signal);
		if (!this.isCurrent(context) || choice === null || choice === 'cancel') return false;
		if (choice === 'add-and-insert' && !canAdd) return false;
		if (!this.isCurrent(context)) return false;

		const sourceBefore = this.document.texSource;
		try {
			const result = this.document.resolvePackageInsertion(packageName, choice);
			if (result !== 'insert') return false;
			if (this.document.texSource !== sourceBefore) {
				const sourceAfter = this.document.texSource;
				this.expectedPackagePatch = { context, source: sourceAfter };
				this.knownPackagePatches.set(context, { before: sourceBefore, after: sourceAfter });
			}
			return true;
		} catch (error) {
			this.host.onPackageError?.(error);
			return false;
		}
	}

	/**
	 * Publish an actual SVG-derived PDF, then pass the package gate, then synchronously patch the
	 * exact captured figure target. A failed/cancelled producer never changes the TeX document.
	 */
	async publishAndInsert(context: FigureOperationContext, input: FigureCommitInput): Promise<boolean> {
		if (!this.isCurrent(context) || !context.target) return false;
		if (context.target.intent === 'edit') {
			const existing = this.existing(context);
			const authorizedRelink = this.relinkedSources.get(context);
			if (!existing || (input.sourcePath !== existing.sourcePath && authorizedRelink !== input.sourcePath)) return false;
		} else if (this.relinkedSources.has(context)) {
			return false;
		}
		if (input.sourcePath.split('.').at(-1) !== (context.type === 'mermaid' ? 'mmd' : 'drawio')) return false;
		if (!Number.isFinite(input.widthPercent) || input.widthPercent < 10 || input.widthPercent > 100) return false;
		const id = diagramIdFromSource(input.sourcePath, context.type === 'mermaid' ? 'mmd' : 'drawio');

		const receipt = await saveDiagramBundle(input.sourcePath, input.source, input.svg, { signal: context.signal });
		if (!this.isCurrent(context)) return false;

		if (!(await this.requestPackage(context, 'graphicx'))) return false;
		const current = this.refreshAfterPackage(context);
		if (!current || !this.isCurrent(current)) return false;
		const target = current.target;
		if (!target || target.node !== current.view.state.doc.nodeAt(target.pos)) return false;

		const imageType = current.view.state.schema.nodes.image;
		if (!imageType) throw new Error('FIGURE_IMAGE_NODE_UNAVAILABLE');
		const imageAttrs = updatedFigureAttrs(
			target.intent === 'edit' ? target.node.attrs : {},
			receipt.outputRelPath,
			context.type,
			id,
			input
		);
		const text = input.caption ? current.view.state.schema.text(input.caption) : undefined;
		const nextNode = imageType.create(imageAttrs, text);
		const state = current.view.state;
		const tr = state.tr;
		let selectionPos = target.pos;

		if (target.intent === 'edit') {
			if (target.node.type !== imageType || target.node.attrs.diagramType !== context.type) return false;
			tr.replaceWith(target.pos, target.pos + target.node.nodeSize, nextNode);
		} else if (target.placement === 'replace') {
			const $target = state.doc.resolve(target.pos);
			if (!$target.parent.canReplaceWith($target.index(), $target.index() + 1, imageType)) return false;
			tr.replaceWith(target.pos, target.pos + target.node.nodeSize, nextNode);
		} else {
			selectionPos = insertAfterCompatibleParent(state, target.pos, target.node, imageType);
			if (selectionPos < 0) return false;
			tr.insert(selectionPos, nextNode);
		}
		if (!this.isCurrent(current)) return false;
		current.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, selectionPos)).scrollIntoView());
		this.release(current);
		return true;
	}

	/**
	 * Refresh only the preamble-source snapshot after a successful package gate. The view, body,
	 * target-node identity, path, kind, active tab, generation and abort signal must still match.
	 */
	refreshAfterPackage(context: FigureOperationContext): FigureOperationContext | null {
		const operation = this.operations.get(context);
		if (!operation || !this.isBaseCurrent(context)) return null;
		const source = this.document.texSource;
		if (source !== context.originalSource) {
			const patch = this.knownPackagePatches.get(context);
			if (!patch || patch.before !== context.originalSource || patch.after !== source) return null;
		}
		const refreshed: FigureOperationContext = Object.freeze({ ...context, originalSource: source });
		this.operations.delete(context);
		this.knownPackagePatches.delete(context);
		const relinkedSource = this.relinkedSources.get(context);
		this.relinkedSources.delete(context);
		if (relinkedSource) this.relinkedSources.set(refreshed, relinkedSource);
		if (this.expectedPackagePatch?.context === context) {
			this.expectedPackagePatch = { context: refreshed, source: this.expectedPackagePatch.source };
		}
		operation.context = refreshed;
		this.operations.set(refreshed, operation);
		return refreshed;
	}

	abort(context: FigureOperationContext): void {
		const operation = this.operations.get(context);
		if (!operation) return;
		operation.controller.abort();
		operation.detachExternalAbort();
		this.operations.delete(context);
		this.clearPackagePatch(context);
		this.relinkedSources.delete(context);
	}

	release(context: FigureOperationContext): void {
		const operation = this.operations.get(context);
		if (!operation) return;
		operation.detachExternalAbort();
		this.operations.delete(context);
		this.clearPackagePatch(context);
		this.relinkedSources.delete(context);
	}

	private canStart(type: DiagramType, view: EditorView): boolean {
		return (
			(type === 'mermaid' || type === 'drawio') &&
			this.document.kind === 'tex' &&
			this.host.getKind() === 'tex' &&
			this.document.path !== null &&
			this.host.getActivePath() !== null &&
			samePath(this.document.path, this.host.getActivePath()!) &&
			this.host.getViewMode() === 'visual' &&
			this.host.getView() === view &&
			!view.isDestroyed &&
			view.dom.isConnected
		);
	}

	private isBaseCurrent(context: FigureOperationContext): boolean {
		if (!this.operations.has(context) || context.signal.aborted || context.generation !== this.generation) return false;
		if (context.kind !== 'tex' || this.document.kind !== 'tex' || this.host.getKind() !== 'tex') return false;
		if (!this.document.path || !samePath(this.document.path, context.path)) return false;
		const activePath = this.host.getActivePath();
		if (!activePath || !samePath(activePath, context.path)) return false;
		if (this.host.getViewMode() !== 'visual' || this.host.getView() !== context.view) return false;
		if (context.view.isDestroyed || !context.view.dom.isConnected || context.view.state.doc !== context.originalDoc) return false;
		if (context.target && context.view.state.doc.nodeAt(context.target.pos) !== context.target.node) return false;
		return true;
	}

	private clearPackagePatch(context: FigureOperationContext): void {
		this.knownPackagePatches.delete(context);
		if (this.expectedPackagePatch?.context === context) this.expectedPackagePatch = null;
	}
}

function figureWidthPercent(node: PMNode): number {
	const width = Number(node.attrs.width);
	const maxWidth = Number(node.attrs.maxWidth);
	if (Number.isFinite(width) && Number.isFinite(maxWidth) && maxWidth > 0) {
		return clampPercent(Math.round((width / maxWidth) * 100));
	}
	const options = String(node.attrs.options ?? '');
	const match = options.match(/(?:^|,)\s*width\s*=\s*([0-9]*\.?[0-9]+)\s*\\(?:text|line|column)width/i);
	return match ? clampPercent(Math.round(Number(match[1]) * 100)) : 100;
}

function clampPercent(value: number): number {
	return Math.max(1, Math.min(100, value));
}

function updatedFigureAttrs(
	previousAttrs: Record<string, unknown>,
	src: string,
	type: DiagramType,
	id: string,
	input: FigureCommitInput
): Record<string, unknown> {
	const attrs: Record<string, unknown> = {
		...previousAttrs,
		src,
		diagramType: type,
		diagramId: id,
		diagramSource: input.sourcePath,
		label: input.label ? sanitizeLabel(input.label) || null : null,
		showCaption: Boolean(input.caption.trim()),
		width: null,
		height: null,
		maxWidth: null,
		options: withFigureWidth(previousAttrs.options, input.widthPercent)
	};
	return attrs;
}

function withFigureWidth(optionsValue: unknown, widthPercent: number): string {
	const width = `${(widthPercent / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}\\linewidth`;
	const options = typeof optionsValue === 'string' ? optionsValue.trim() : '';
	if (!options) return `width=${width}`;
	const entries = options
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	let replaced = false;
	for (let index = 0; index < entries.length; index++) {
		if (/^width\s*=/.test(entries[index]!)) {
			entries[index] = `width=${width}`;
			replaced = true;
		}
	}
	if (!replaced) entries.unshift(`width=${width}`);
	return entries.join(', ');
}

function insertAfterCompatibleParent(state: EditorView['state'], pos: number, node: PMNode, imageType: PMNode['type']): number {
	let at = pos + node.nodeSize;
	let $at = state.doc.resolve(at);
	while ($at.depth > 0 && !$at.parent.canReplaceWith($at.index(), $at.index(), imageType)) {
		at = $at.after();
		$at = state.doc.resolve(at);
	}
	return $at.parent.canReplaceWith($at.index(), $at.index(), imageType) ? at : -1;
}

export const FIGURE_COORDINATOR_CONTEXT = Symbol('modutex.figure-coordinator');
