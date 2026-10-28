import { EditorState, TextSelection, NodeSelection, Plugin, type Transaction } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { DOMSerializer, type Node as VisualNode } from 'prosemirror-model';
import { projectionIsCurrent, type SourceDocument, type SourcePatch, type SourceProjection, type SourceSpan } from '../document-core/core.ts';
import { parseTable, columnPercentages, type TableDraft } from '../tables/source.ts';
import type { EquationDraft } from '../math/source.ts';
import { parseCodeContent, codeLanguage } from '../code/source.ts';
import { cellDragHandle, disposeCellDragHandle } from './cell-drag.ts';
import { highlightCode } from '../code/highlight.ts';
import { imagePath } from '../images/store.ts';
import { imageCell, clipboardImage } from '../images/view.ts';
import { formatShortcut, type TextFormat } from '../source-editor/format.ts';
import type { StructureSelection } from '../source-editor/structure.ts';
import { advanceVisual, prepareVisualEdit, projectVisual, visualCaretAnchor, visualSchema, visualMarkName, createVisualMark, supportedVisualMark, type VisualProjection } from './schema.ts';
import { text, type Language } from '../../i18n/text.ts';
import { numericDatePreview } from '../compile/document-date.ts';

interface VisualOptions {
	source(): SourceDocument;
	apply(identity: { documentId: string; version: number }, patches: readonly SourcePatch[]): SourceDocument;
	/** Validate the prepared source receipt synchronously before publishing that same state. */
	applyValidated?(
		identity: { documentId: string; version: number },
		patches: readonly SourcePatch[],
		validateNextSource: (source: SourceDocument) => void
	): SourceDocument;
	history(direction: 'undo' | 'redo'): boolean;
	readOnly(): boolean;
	rejected(): void;
	status(value: 'ready' | 'updating'): void;
	locale?(): Language;
	image?(path: string): Promise<Blob>;
	pasteImage?(image: Blob): void;
	table?(draft: TableDraft, span: SourceSpan): void;
	equation?(draft: EquationDraft, span: SourceSpan): void;
	format?(format: TextFormat): void;
	raw?(source: string, span: SourceSpan): void;
	insertBlock?(kind: 'text' | 'equation' | 'matrix' | 'table' | 'code', span: SourceSpan, beforeText: boolean): void;
	cellAction?(action: 'delete' | 'move-up' | 'move-down', span: SourceSpan, adjacent?: SourceSpan): boolean | void;
	cellReorder?(cells: readonly SourceSpan[], index: number, boundary: number): boolean | void;
	cellSelected?(span: SourceSpan): void;
	cellDone?(): void;
	cellCancel?(span: SourceSpan, original: string): void;
	cellToolbar?(toolbar: HTMLElement | null): void;
}

let mathRendererPromise: Promise<typeof import('../math/render.ts')> | null = null;
let boundaryMenuId = 0;
function preloadMathRenderer(): Promise<typeof import('../math/render.ts')> {
	if (!mathRendererPromise) {
		mathRendererPromise = import('../math/render.ts');
	}
	return mathRendererPromise;
}

function changedSpansMatch(document: SourceDocument, source: SourceDocument, patches: readonly SourcePatch[]): boolean {
	let delta = 0;
	for (const patch of patches) {
		const from = patch.from + delta, to = from + patch.insert.length;
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > document.length ||
			document.read(from, to) !== patch.insert) return false;
		delta += patch.insert.length - (patch.to - patch.from);
	}
	return document.length === source.length + delta;
}
/** One actual view, one source authority, no second undo stack. */
export class VisualEditor {
	readonly view: EditorView;
	private label: string;
	private projection: VisualProjection | null = null;
	private applying = false;
	private disposed = false;
	private pendingFocus = false;
	private pendingMathDeletion: { documentId: string; version: number; position: number } | null = null;
	private pendingLineBreak: { documentId: string; version: number; position: number; marks: readonly string[]; text: string } | null = null;
	private refreshedEditable: boolean | undefined;
	private refreshedLabel: string | undefined;
	private selectedCellIndex: number | null = null;
	private cellOriginal: string | null = null;
	private readonly tableButtons = new Set<HTMLButtonElement>();
	private readonly imageCopies = new Map<() => number | undefined, (event: ClipboardEvent) => boolean>();
	private readonly equationButtons = new Set<HTMLButtonElement>();
	private readonly rawButtons = new Set<HTMLButtonElement>();
	private readonly inserterButtons = new Set<HTMLButtonElement>();
	private readonly cellActionButtons = new Set<HTMLButtonElement>();
	private cachedDecorations: DecorationSet | null = null;
	private cachedDoc: VisualNode | null = null;
	private cachedEditable: boolean | undefined = undefined;
	private cachedLocale: string | undefined = undefined;
	private cachedSelectedCell: number | null = null;
	private toolbarKey = '';
	private commandMode = false;
	private dragCleanup: (() => void) | null = null;
	private pendingMove: { documentId: string; version: number; index: number; bodyIndex?: number } | null = null;
	private createDragHandle(index: number): HTMLElement {
		const enabled = this.editable() && !!this.options.cellReorder && this.isBodyCell(index);
		return cellDragHandle(this.view.dom.ownerDocument, index, enabled, this.text('拖曳儲存格', 'Drag cell'), () => {
			this.dragCleanup?.(); this.selectCell(index); this.commandMode = true; this.view.focus(); const source = this.options.source(), order = this.bodyCellOrder();
			const cellIndex = order?.indices.indexOf(index) ?? -1;
			if (!order || cellIndex < 0) return null;
			return { cells: order.cells, current: () => !this.disposed && this.editable() && this.options.source() === source, commit: visualBoundary => {
				const boundary = order.indices.filter(value => value < visualBoundary).length;
				if (this.options.cellReorder?.(order.cells, cellIndex, boundary) === false) return;
				const next = this.options.source(); if (next.version === source.version) return;
				const destination = boundary > cellIndex ? boundary - 1 : boundary;
				const selectedIndex = order.indices[Math.min(destination, order.indices.length - 1)];
				this.cellOriginal = null; this.pendingMove = { documentId: next.documentId, version: next.version, index: selectedIndex ?? index, bodyIndex: destination };
				if (this.projection?.version === next.version) { const pending = this.pendingMove; this.pendingMove = null; this.navigateCell(pending.index); }
			} };
		}, cleanup => { this.dragCleanup = cleanup; });
	}
	private moveCell(index: number, next: number): void {
		if (this.options.cellReorder) {
			const order = this.bodyCellOrder(), cellIndex = order?.indices.indexOf(index) ?? -1;
			if (!order || cellIndex < 0) return;
			const visualBoundary = next < index ? next : index + 2;
			const boundary = order.indices.filter(value => value < visualBoundary).length;
			if (this.options.cellReorder(order.cells, cellIndex, boundary) === false) return;
			const source = this.options.source();
			if (source.version === order.cells[0]?.version) return;
			const destination = boundary > cellIndex ? boundary - 1 : boundary;
			const selectedIndex = order.indices[Math.min(destination, order.indices.length - 1)];
			this.cellOriginal = null;
			this.pendingMove = { documentId: source.documentId, version: source.version, index: selectedIndex ?? index, bodyIndex: destination };
			if (this.projection?.version === source.version) { this.pendingMove = null; this.navigateCell(selectedIndex ?? index); }
			return;
		}
		const span = this.cellSpan(index), adjacent = this.cellSpan(next);
		if (!span || !adjacent || !this.options.cellAction) return;
		if (this.options.cellAction(next < index ? 'move-up' : 'move-down', span, adjacent) === false) return;
		const source = this.options.source();
		if (source.version === span.version) return;
		this.cellOriginal = null;
		this.pendingMove = { documentId: source.documentId, version: source.version, index: next };
		if (this.projection?.version === source.version) { this.pendingMove = null; this.navigateCell(next); }
	}
	private navigateCell(index: number): void {
		if (index < 0 || index >= this.view.state.doc.childCount) return;
		let position = 0; for (let i = 0; i < index; i++) position += this.view.state.doc.child(i).nodeSize;
		const node = this.view.state.doc.child(index);
		this.view.dispatch(this.view.state.tr.setSelection(node.isAtom ? NodeSelection.create(this.view.state.doc, position) : TextSelection.create(this.view.state.doc, position + 1)).scrollIntoView());
		this.selectCell(index); this.view.focus();
	}
	private clickCell(view: EditorView, event: MouseEvent): void {
		const target = event.target as HTMLElement | null;
		if (target?.closest('.visual-cell-toolbar, .visual-cell-boundary, .inline-equation-draft, .cell-panel-draft, .visual-math, .visual-math-inline')) return;
		this.commandMode = false;
		const cell = target?.closest<HTMLElement>('[data-cell-index]');
		if (!cell || !view.dom.contains(cell)) return;
		const index = Number(cell.dataset.cellIndex);
		if (!Number.isInteger(index) || index < 0 || index >= view.state.doc.childCount) return;
		let position = 0; for (let i = 0; i < index; i++) position += view.state.doc.child(i).nodeSize;
		const node = view.state.doc.child(index);
		if (node.isAtom) { view.focus(); view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position))); view.focus(); }
		else {
			const clamp = (pos: number) => Math.max(position + 1, Math.min(pos, position + node.nodeSize - 1));
			const native = cell.ownerDocument.getSelection();
			let from = position + 1, to = from;
			if (native?.anchorNode && native.focusNode && cell.contains(native.anchorNode) && cell.contains(native.focusNode)) {
				from = clamp(view.posAtDOM(native.anchorNode, native.anchorOffset)); to = clamp(view.posAtDOM(native.focusNode, native.focusOffset));
			} else if (typeof cell.ownerDocument.elementFromPoint === 'function') {
				from = to = clamp(view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? from);
			}
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
		}
		this.selectCell(index);
	}
	private refreshCellToolbar(): void {
		if (!this.options.cellToolbar) return;
		const key = `${this.selectedCellIndex}:${this.projection?.version}:${this.editable()}:${this.options.locale?.()}`;
		if (key === this.toolbarKey) return;
		this.toolbarKey = key;
		this.options.cellToolbar(this.selectedCellIndex !== null && this.selectedCellIndex < this.view.state.doc.childCount
			? this.createCellToolbarElement(this.selectedCellIndex) : null);
	}
	private readonly options: VisualOptions;
	private equationDraft: { dom: HTMLElement; from: number; to: number; dispose?: () => void } | null = null;
	private placeDraft(span: SourceSpan, dom: HTMLElement, atCaret = false): boolean {
		if (this.disposed || !this.projection || span.documentId !== this.projection.documentId || span.version !== this.projection.version) return false;
		this.closeEquation();
		let from = this.view.state.selection.from, to = from, matched = false;
		this.view.state.doc.descendants((node, pos) => {
			if (matched || atCaret && span.from === span.to) return false;
			if (['math_inline', 'math_block', 'table_block', 'raw_block'].includes(node.type.name) && node.attrs.from === span.from && node.attrs.to === span.to) { from = pos; to = pos + node.nodeSize; matched = true; return false; }
			if (span.from === span.to && typeof node.attrs.to === 'number' && node.attrs.to === span.from) { from = pos + node.nodeSize; to = from; matched = true; return false; }
			if (span.from === span.to && typeof node.attrs.from === 'number' && span.from <= node.attrs.from) { from = pos; to = pos; matched = true; return false; }
		});
		const session = { dom, from, to, dispose: undefined as (() => void) | undefined }; this.equationDraft = session;
		this.view.updateState(this.view.state.apply(this.view.state.tr));
		return true;
	}
	/** Isolated draft; the caller keeps source authority and the shared undo history. */
	startEquation(draft: EquationDraft, span: SourceSpan, commit: (draft: EquationDraft) => void, cancel: () => void, atCaret = false): boolean {
		const dom = this.view.dom.ownerDocument.createElement('span'); dom.className = `inline-equation-draft${draft.inline ? ' is-inline' : ''}`; dom.contentEditable = 'false';
		if (!this.placeDraft(span, dom, draft.inline || atCaret)) return false;
		const session = this.equationDraft!;
		void import('../math/inline.ts').then(({ editInlineEquation }) => {
			if (this.disposed || this.equationDraft !== session) return;
			session.dispose = editInlineEquation(dom, draft, (zh, en) => this.text(zh, en), commit, cancel);
		}).catch(() => {
			if (this.disposed || this.equationDraft !== session) return;
			dom.textContent = this.text('公式工具無法載入。', 'Equation tools could not load.');
			const close = dom.ownerDocument.createElement('button'); close.type = 'button'; close.textContent = this.text('取消', 'Cancel'); close.addEventListener('click', cancel); dom.append(close);
		});
		return true;
	}
	startCellPanel(span: SourceSpan, panel: HTMLElement, atCaret = false): boolean {
		const parent = panel.parentNode, next = panel.nextSibling;
		if (!parent) return false;
		const dom = panel.ownerDocument.createElement('div'); dom.className = 'cell-panel-draft'; dom.contentEditable = 'false';
		if (!this.placeDraft(span, dom, atCaret)) return false;
		dom.append(panel);
		this.equationDraft!.dispose = () => parent.insertBefore(panel, next?.parentNode === parent ? next : null);
		return true;
	}
	closeEquation(): void {
		const session = this.equationDraft; if (!session) return;
		this.equationDraft = null; session.dispose?.();
		if (!this.disposed) {
			const node = this.view.state.doc.nodeAt(session.from);
			const transaction = this.view.state.tr;
			if (session.to > session.from && node?.isAtom) transaction.setSelection(NodeSelection.create(this.view.state.doc, session.from));
			this.view.updateState(this.view.state.apply(transaction));
			if (session.to > session.from && node?.isAtom) this.selectCell(this.view.state.doc.resolve(session.from).index(0));
		}
	}

	private selectCell(index: number | null): void {
		if (this.disposed || this.selectedCellIndex === index) return;
		this.selectedCellIndex = index;
		const span = index === null ? null : this.cellSpan(index);
		this.cellOriginal = span && this.view.state.doc.child(index!).type.name === 'source_block'
			? this.options.source().read(span.from, span.to) : null;
		if (span) this.options.cellSelected?.(span);
		this.cachedDecorations = null;
		if (this.view) {
			this.view.dispatch(this.view.state.tr);
		}
		this.refreshCellToolbar();
	}

	private cellSpan(index: number): SourceSpan | null {
		if (!this.projection) return null;
		const source = this.options.source();
		if (this.projection.documentId !== source.documentId || this.projection.version !== source.version) return null;
		if (index < 0 || index >= this.projection.document.childCount) return null;
		const child = this.projection.document.child(index);
		const from = child.attrs.from;
		const to = child.attrs.to;
		if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to > source.length || from > to) return null;
		return { documentId: this.projection.documentId, version: this.projection.version, from, to };
	}
	private isMaketitleField(node: VisualNode | null | undefined): boolean {
		return ['source_block', 'raw_block'].includes(node?.type.name ?? '') && ['title', 'author', 'date'].includes(node?.attrs.name);
	}
	private bodyCellOrder(): { readonly cells: SourceSpan[]; readonly indices: number[] } | null {
		const projection = this.projection, start = projection?.bodyStart, end = projection?.bodyEnd;
		if (!projection) return null;
		const source = this.options.source();
		if (projection.documentId !== source.documentId || projection.version !== source.version) return null;
		const fragment = start === undefined && end === undefined;
		const hasBodyBounds = typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && end <= source.length;
		if (!fragment && !hasBodyBounds) return null;
		const cells: SourceSpan[] = [], indices: number[] = [];
		for (let index = 0; index < projection.document.childCount; index++) {
			const span = this.cellSpan(index);
			if (!span) return null;
			if (fragment || span.from >= start! && span.to <= end!) {
				cells.push(span); indices.push(index);
			}
		}
		return cells.length ? { cells, indices } : null;
	}
	private isBodyCell(index: number): boolean {
		const projection = this.projection;
		if (!projection || index < 0 || index >= projection.document.childCount) return false;
		const source = this.options.source();
		if (projection.documentId !== source.documentId || projection.version !== source.version) return false;
		const child = projection.document.child(index), from = child.attrs.from, to = child.attrs.to;
		if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > source.length) return false;
		const start = projection.bodyStart, end = projection.bodyEnd;
		if (start === undefined && end === undefined) return true;
		return typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && end <= source.length && from >= start && to <= end;
	}
	private bodyInsertionSpan(): SourceSpan | null {
		const projection = this.projection;
		const position = projection?.bodyEnd;
		if (!projection || typeof position !== 'number' || !Number.isSafeInteger(position)) return null;
		const source = this.options.source();
		if (projection.documentId !== source.documentId || projection.version !== source.version || position < 0 || position > source.length) return null;
		return { documentId: projection.documentId, version: projection.version, from: position, to: position };
	}

	private text(traditionalChinese: string, english: string): string {
		return text(this.options.locale ? this.options.locale() : 'zh-Hant', traditionalChinese, english);
	}
	private boundarySpan(index: number): SourceSpan | null {
		if (!this.editable() || !this.projection) return null;
		const source = this.options.source();
		if (this.projection.documentId !== source.documentId || this.projection.version !== source.version) return null;
		const childCount = this.projection.document.childCount;
		if (this.isMaketitleField(this.projection.document.maybeChild(index - 1)) || this.isMaketitleField(this.projection.document.maybeChild(index))) {
			const body = this.bodyInsertionSpan();
			if (body) return body;
		}
		let offset: number;
		if (childCount === 0) {
			offset = 0;
		} else if (index <= 0) {
			const first = this.projection.document.child(0);
			offset = typeof first.attrs.from === 'number' ? first.attrs.from : 0;
		} else if (index >= childCount) {
			const last = this.projection.document.child(childCount - 1);
			offset = typeof last.attrs.to === 'number' ? last.attrs.to : source.length;
		} else {
			const prev = this.projection.document.child(index - 1);
			offset = typeof prev.attrs.to === 'number' ? prev.attrs.to : 0;
		}
		offset = Math.max(0, Math.min(source.length, offset));
		return { documentId: this.projection.documentId, version: this.projection.version, from: offset, to: offset };
	}
	/** Only unfenced body text needs a second marker to keep the following cell separate. */
	private boundaryBeforeText(index: number): boolean {
		const next = this.projection?.document.maybeChild(index);
		return next?.type.name === 'source_block' && !['heading', 'abstract'].includes(next.attrs.role) &&
			!['par', 'null'].includes(next.attrs.name) && !this.isMaketitleField(next);
	}
	private createBoundaryElement(boundaryIndex: number): HTMLElement {
		const doc = this.view?.dom.ownerDocument ?? document;
		const container = doc.createElement('div');
		container.className = 'visual-cell-boundary';
		container.dataset.boundaryIndex = String(boundaryIndex);
		container.contentEditable = 'false';
		container.setAttribute('role', 'presentation');
		const trigger = doc.createElement('button');
		trigger.type = 'button';
		trigger.className = 'boundary-trigger';
		const svgNamespace = 'http://www.w3.org/2000/svg';
		const icon = doc.createElementNS(svgNamespace, 'svg');
		icon.setAttribute('viewBox', '0 0 16 16');
		icon.setAttribute('aria-hidden', 'true');
		icon.setAttribute('focusable', 'false');
		const plus = doc.createElementNS(svgNamespace, 'path');
		plus.setAttribute('d', 'M8 3v10M3 8h10');
		plus.setAttribute('fill', 'none');
		plus.setAttribute('stroke', 'currentColor');
		plus.setAttribute('stroke-width', '1.75');
		plus.setAttribute('stroke-linecap', 'round');
		icon.append(plus);
		trigger.append(icon);
		trigger.title = this.text('在此處插入區塊', 'Insert block here');
		trigger.setAttribute('aria-label', this.text('在此處插入區塊', 'Insert block here'));
		trigger.setAttribute('aria-expanded', 'false');
		trigger.disabled = !this.editable() || !this.options.insertBlock;
		this.inserterButtons.add(trigger);
		trigger.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const opening = !container.classList.contains('open');
			if (opening && !trigger.hasAttribute('aria-controls')) {
				const menu = doc.createElement('div');
				menu.className = 'boundary-menu';
				menu.id = `visual-boundary-menu-${boundaryMenuId++}`;
				const makeItem = (kind: 'text' | 'equation' | 'matrix' | 'table' | 'code', label: string, title: string) => {
					const button = doc.createElement('button');
					button.type = 'button';
					button.className = 'boundary-btn';
					button.textContent = label;
					button.title = title;
					button.setAttribute('aria-label', title);
					button.disabled = !this.editable() || !this.options.insertBlock;
					this.inserterButtons.add(button);
					button.addEventListener('click', (event) => {
						event.preventDefault();
						event.stopPropagation();
						container.classList.remove('open');
						trigger.setAttribute('aria-expanded', 'false');
						if (!this.editable() || !this.options.insertBlock) return;
						const span = this.boundarySpan(boundaryIndex);
						if (!span) { this.options.rejected(); return; }
						this.options.insertBlock(kind, span, this.boundaryBeforeText(boundaryIndex));
					});
					return button;
				};
				menu.append(
					makeItem('text', this.text('文字', 'Text'), this.text('插入文字段落', 'Insert text paragraph')),
					makeItem('equation', this.text('公式', 'Equation'), this.text('插入公式', 'Insert equation')),
					makeItem('matrix', this.text('矩陣', 'Matrix'), this.text('插入矩陣', 'Insert matrix')),
					makeItem('table', this.text('表格', 'Table'), this.text('插入表格', 'Insert table')),
					makeItem('code', this.text('程式碼', 'Code'), this.text('插入程式碼區塊', 'Insert code block'))
				);
				container.append(menu);
				trigger.setAttribute('aria-controls', menu.id);
			}
			container.classList.toggle('open', opening);
			trigger.setAttribute('aria-expanded', String(opening));
		});
		container.append(trigger);
		return container;
	}

	private createCellToolbarElement(cellIndex: number): HTMLElement {
		const doc = this.view?.dom.ownerDocument ?? document;
		const childCount = this.view.state.doc.childCount;
		const node = this.view.state.doc.child(cellIndex);
		const bodyOrder = this.bodyCellOrder(), bodyIndex = bodyOrder?.indices.indexOf(cellIndex) ?? -1;
		const canMove = this.options.cellReorder ? bodyIndex >= 0 : !!this.options.cellAction;
		const container = doc.createElement('div');
		container.className = 'visual-cell-toolbar';
		container.addEventListener('pointerdown', event => event.preventDefault());
		container.contentEditable = 'false';
		container.setAttribute('role', 'toolbar');
		container.setAttribute('aria-label', this.text('儲存格操作列', 'Cell actions'));

		const typeBadge = doc.createElement('span');
		typeBadge.className = 'cell-badge';
		let typeName = this.text('文字', 'Text');
		if (node.type.name === 'math_block') typeName = this.text('公式', 'Equation');
		else if (node.type.name === 'table_block') typeName = this.text('表格', 'Table');
		else if (node.type.name === 'raw_block') typeName = ['verbatim', 'verbatim*'].includes(node.attrs.name) ? this.text('程式碼', 'Code') : this.text('原始碼', 'Raw LaTeX');
		typeBadge.textContent = typeName;

		const leftGroup = doc.createElement('div');
		leftGroup.className = 'cell-toolbar-group';
		leftGroup.append(typeBadge);

		const rightGroup = doc.createElement('div');
		rightGroup.className = 'cell-toolbar-group';

		const makeInsertMenu = (above: boolean) => {
			const wrap = doc.createElement('div');
			wrap.className = 'cell-insert-wrap';
			const trigger = doc.createElement('button');
			trigger.type = 'button';
			trigger.className = 'cell-tool-btn';
			trigger.textContent = above ? this.text('+ 上方', '+ Above') : this.text('+ 下方', '+ Below');
			trigger.title = above ? this.text('在上方插入', 'Insert above') : this.text('在下方插入', 'Insert below');
			trigger.disabled = !this.editable() || !this.options.insertBlock;
			this.cellActionButtons.add(trigger);
			const menu = doc.createElement('div');
			menu.className = 'cell-insert-menu';
			const makeItem = (kind: 'text' | 'equation' | 'matrix' | 'table' | 'code', label: string) => {
				const button = doc.createElement('button');
				button.type = 'button';
				button.className = 'cell-menu-btn';
				button.textContent = label;
				button.disabled = !this.editable() || !this.options.insertBlock;
				this.cellActionButtons.add(button);
				button.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					wrap.classList.remove('open');
					if (!this.editable() || !this.options.insertBlock) return;
					const boundary = above ? cellIndex : cellIndex + 1;
					const span = this.boundarySpan(boundary);
					if (!span) { this.options.rejected(); return; }
					this.options.insertBlock(kind, span, this.boundaryBeforeText(boundary));
				});
				return button;
			};
			trigger.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				wrap.classList.toggle('open');
			});
			menu.append(
				makeItem('text', this.text('文字', 'Text')),
				makeItem('equation', this.text('公式', 'Equation')),
				makeItem('matrix', this.text('矩陣', 'Matrix')),
				makeItem('table', this.text('表格', 'Table')),
				makeItem('code', this.text('程式碼', 'Code'))
			);
			wrap.append(trigger, menu);
			return wrap;
		};

		const moveUpBtn = doc.createElement('button');
		moveUpBtn.type = 'button';
		moveUpBtn.className = 'cell-tool-btn';
		moveUpBtn.textContent = '↑';
		moveUpBtn.title = this.text('上移儲存格', 'Move cell up');
		moveUpBtn.setAttribute('aria-label', this.text('上移儲存格', 'Move cell up'));
		moveUpBtn.disabled = !this.editable() || !canMove || (this.options.cellReorder ? bodyIndex <= 0 : cellIndex <= 0);
		moveUpBtn.dataset.atEdge = String(this.options.cellReorder ? bodyIndex <= 0 : cellIndex <= 0);
		this.cellActionButtons.add(moveUpBtn);
		moveUpBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.editable() || !canMove || (this.options.cellReorder ? bodyIndex <= 0 : cellIndex <= 0)) return;
			if (this.options.cellReorder) { this.moveCell(cellIndex, cellIndex - 1); return; }
			const span = this.cellSpan(cellIndex);
			const adjacent = this.cellSpan(cellIndex - 1);
			if (!span || !adjacent) { this.options.rejected(); return; }
			this.moveCell(cellIndex, cellIndex - 1);
		});

		const moveDownBtn = doc.createElement('button');
		moveDownBtn.type = 'button';
		moveDownBtn.className = 'cell-tool-btn';
		moveDownBtn.textContent = '↓';
		moveDownBtn.title = this.text('下移儲存格', 'Move cell down');
		moveDownBtn.setAttribute('aria-label', this.text('下移儲存格', 'Move cell down'));
		moveDownBtn.disabled = !this.editable() || !canMove || (this.options.cellReorder ? bodyIndex >= (bodyOrder?.indices.length ?? 0) - 1 : cellIndex >= childCount - 1);
		moveDownBtn.dataset.atEdge = String(this.options.cellReorder ? bodyIndex >= (bodyOrder?.indices.length ?? 0) - 1 : cellIndex >= childCount - 1);
		this.cellActionButtons.add(moveDownBtn);
		moveDownBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.editable() || !canMove || (this.options.cellReorder ? bodyIndex >= (bodyOrder?.indices.length ?? 0) - 1 : cellIndex >= childCount - 1)) return;
			if (this.options.cellReorder) { this.moveCell(cellIndex, cellIndex + 1); return; }
			const span = this.cellSpan(cellIndex);
			const adjacent = this.cellSpan(cellIndex + 1);
			if (!span || !adjacent) { this.options.rejected(); return; }
			this.moveCell(cellIndex, cellIndex + 1);
		});

		const deleteBtn = doc.createElement('button');
		deleteBtn.type = 'button';
		deleteBtn.className = 'cell-tool-btn cell-delete-btn';
		deleteBtn.textContent = this.text('刪除', 'Delete');
		deleteBtn.title = this.text('刪除此儲存格', 'Delete this cell');
		deleteBtn.setAttribute('aria-label', this.text('刪除此儲存格', 'Delete this cell'));
		deleteBtn.disabled = !this.editable() || !this.options.cellAction;
		this.cellActionButtons.add(deleteBtn);
		deleteBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.editable() || !this.options.cellAction) return;
			const span = this.cellSpan(cellIndex);
			if (!span) { this.options.rejected(); return; }
			if (this.options.cellAction('delete', span) !== false) {
				this.selectCell(null); this.options.cellDone?.(); this.view.dom.blur();
			}
		});

		const finishBtn = doc.createElement('button');
		finishBtn.type = 'button';
		finishBtn.className = 'cell-tool-btn';
		finishBtn.textContent = this.text('完成', 'Done');
		finishBtn.title = this.text('完成選取', 'Finish selection');
		finishBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.selectCell(null);
			this.options.cellDone?.();
			(this.view.dom.ownerDocument.activeElement as HTMLElement | null)?.blur();
		});

		rightGroup.append(
			makeInsertMenu(true),
			makeInsertMenu(false),
			moveUpBtn,
			moveDownBtn,
			deleteBtn,
			finishBtn
		);

		container.append(leftGroup, rightGroup);
		if (node.type.name === 'source_block' && this.options.cellCancel) {
			const cancelBtn = doc.createElement('button');
			cancelBtn.type = 'button';
			cancelBtn.className = 'cell-tool-btn';
			cancelBtn.textContent = this.text('取消編輯', 'Cancel editing');
			cancelBtn.addEventListener('click', event => {
				event.preventDefault(); event.stopPropagation();
				const span = this.cellSpan(cellIndex), original = this.cellOriginal;
				if (!span || original === null || !this.editable()) return;
				this.options.cellCancel!(span, original);
				this.selectCell(null);
				this.options.cellDone?.();
			});
			rightGroup.append(cancelBtn);
		}
		return container;
	}

	constructor(target: HTMLElement, label: string, options: VisualOptions) {
		this.label = label;
		this.options = options;
		const notebookPlugin = new Plugin({
			props: {
				decorations: (state) => {
					if (this.disposed || !this.projection) return DecorationSet.empty;
					const doc = state.doc;
					const editable = this.editable();
					const loc = this.options.locale ? this.options.locale() : 'zh-Hant';
					const selected = this.selectedCellIndex;
					if (this.cachedDecorations && this.cachedDoc === doc && this.cachedEditable === editable &&
						this.cachedLocale === loc && this.cachedSelectedCell === selected) {
						return this.cachedDecorations;
					}
					const decorations: Decoration[] = [];
					let currentPos = 0;
					const count = doc.childCount;
					for (let i = 0; i <= count; i++) {
						const boundaryIndex = i;
						const pos = currentPos;
						decorations.push(Decoration.widget(pos, () => this.createBoundaryElement(boundaryIndex), {
							side: i === 0 ? -1 : 1,
							stopEvent: () => true,
							key: `boundary-${loc}-${boundaryIndex}`
						}));
						if (i < count) {
							const child = doc.child(i);
							decorations.push(Decoration.widget(pos, () => this.createDragHandle(i), { side: 0, stopEvent: () => true, destroy: dom => disposeCellDragHandle(dom as HTMLElement), key: `cell-grip-${loc}-${i}-${editable}` }));
							const isSelected = i === selected;
							decorations.push(Decoration.node(pos, pos + child.nodeSize, {
								class: `notebook-cell${isSelected ? ' is-selected' : ''}`,
								'data-cell-index': String(i),
								'data-cell-type': child.type.name
							}));
							if (isSelected && !this.options.cellToolbar) {
								decorations.push(Decoration.widget(pos, () => this.createCellToolbarElement(i), {
									side: 1,
									stopEvent: () => true,
									key: `cell-toolbar-${loc}-${i}`
								}));
							}
							currentPos += child.nodeSize;
						}
					}
					this.cachedDoc = doc;
					this.cachedEditable = editable;
					this.cachedLocale = loc;
					this.cachedSelectedCell = selected;
					this.cachedDecorations = DecorationSet.create(doc, decorations);
					return this.cachedDecorations;
				},
				handleClick: (view, pos, event) => {
					const target = event.target as HTMLElement | null;
					if (target?.closest('.visual-cell-toolbar, .visual-cell-boundary, .inline-equation-draft, .cell-panel-draft')) return false;
					const cell = target?.closest<HTMLElement>('[data-cell-index]');
					// Blank space between cells must not select the nearest paragraph.
					if (!cell || !view.dom.contains(cell)) return false;
					const cellIndex = Number(cell.dataset.cellIndex);
					if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= view.state.doc.childCount) return false;
					let position = 0;
					for (let index = 0; index < cellIndex; index++) position += view.state.doc.child(index).nodeSize;
					const node = view.state.doc.child(cellIndex);
					// Publish the clicked caret before adding its toolbar, so widget redraws
					// cannot restore the previous cell's native selection.
					const selection = node.isAtom ? NodeSelection.create(view.state.doc, position)
						: TextSelection.create(view.state.doc, Math.max(position + 1, Math.min(pos, position + node.nodeSize - 1)));
					view.dispatch(view.state.tr.setSelection(selection));
					this.selectCell(cellIndex);
					return true;
				}
			}
		});
		const equationPlugin = new Plugin({ props: { decorations: state => {
			const draft = this.equationDraft;
			if (!draft || draft.from > state.doc.content.size || draft.to > state.doc.content.size) return DecorationSet.empty;
			const decorations = [Decoration.widget(draft.from, draft.dom, { side: -1, stopEvent: () => true })];
			if (draft.to > draft.from) decorations.push(Decoration.node(draft.from, draft.to, { class: 'equation-draft-original' }));
			return DecorationSet.create(state.doc, decorations);
		} } });
		this.view = new EditorView(target, { state: EditorState.create({ schema: visualSchema, plugins: [notebookPlugin, equationPlugin] }),
			handleDOMEvents: {
				beforeinput: (_view, event) => {
					const input = event as InputEvent;
					if (!this.awaitingLineBreak() || input.inputType !== 'insertText' || input.data === null) return false;
					this.pendingLineBreak!.text += input.data;
					event.preventDefault(); return true;
				},
				copy: (view, event) => { if (!(view.state.selection instanceof NodeSelection)) return false; for (const [position, copy] of this.imageCopies) if (position() === view.state.selection.from) return copy(event as ClipboardEvent); return false; },
				click: (view, event) => { this.clickCell(view, event as MouseEvent); return false; },
				mousedown: (view, event) => {
					const target = event.target as HTMLElement | null;
					if (target?.closest('button, input, textarea, .cell-panel-draft') || !target?.closest('[data-cell-type="table_block"]')) return false;
					this.clickCell(view, event as MouseEvent); event.preventDefault(); return true;
				}
			},
			attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label + this.text(' 視覺編輯', ' visual editor') },
			editable: () => this.editable() || this.awaitingLineBreak(),
			nodeViews: { source_block: initial => {
				const rendered = DOMSerializer.renderSpec(target.ownerDocument, initial.type.spec.toDOM!(initial));
				return { ...rendered, update: next => next.type === initial.type &&
					next.attrs.role === initial.attrs.role && next.attrs.name === initial.attrs.name && next.attrs.level === initial.attrs.level };
			}, raw_block: (initial, _view, getPos) => {
				if (initial.attrs.name === 'date' && numericDatePreview(String(initial.attrs.source)) !== null) {
					const dom = target.ownerDocument.createElement('p'); dom.className = 'document-date'; dom.contentEditable = 'false';
					dom.textContent = numericDatePreview(String(initial.attrs.source));
					return {dom, ignoreMutation:() => true, update:next => {
						const value = next.attrs.name === 'date' ? numericDatePreview(String(next.attrs.source)) : null;
						if (value === null) return false;
						dom.textContent = value; return true;
					}};
				}
				if (imagePath(String(initial.attrs.source)) && this.options.image) {
					let node = initial;
					const dom = target.ownerDocument.createElement('figure'); dom.contentEditable = 'false';
					const content = imageCell(dom, String(node.attrs.source), this.options.image, () => {
						const position = getPos(); if (typeof position !== 'number' || this.disposed) return;
						this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position))); this.selectCell(this.view.state.doc.resolve(position).index(0));
					}, (zh, en) => this.text(zh, en));
					this.imageCopies.set(getPos, content.copy);
					return { dom, stopEvent: () => true, ignoreMutation: () => true, update: next => { if (next.type !== node.type || !imagePath(String(next.attrs.source))) return false; node = next; content.update(String(node.attrs.source)); return true; }, destroy: () => { this.imageCopies.delete(getPos); content.dispose(); } };
				}
				let node = initial, destroyed = false;
				const document = target.ownerDocument;
				const dom = document.createElement('section'); dom.className = 'visual-raw'; dom.contentEditable = 'false';
				const readCode = () => parseCodeContent(String(node.attrs.source).replace(/^\\begin\{(?:verbatim\*?|lstlisting)\}/, '').replace(/\\end\{(?:verbatim\*?|lstlisting)\}$/, ''), node.attrs.name);
				const isCode = ['verbatim', 'verbatim*', 'lstlisting'].includes(node.attrs.name) && !!readCode();
				const code = document.createElement('pre'); code.className = isCode ? 'code-content' : 'raw-latex'; code.setAttribute('aria-label', isCode ? this.text('程式碼區塊', 'Code block') : 'Raw LaTeX');
				const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = isCode ? this.text('編輯程式碼', 'Edit code') : this.text('編輯原始碼', 'Edit source'); button.disabled = true;
				button.dataset.code = String(isCode);
				const language = document.createElement('span'); language.className = 'code-language';
				let releaseHighlight: (() => void) | null = null;
				const render = () => { releaseHighlight?.(); const draft = isCode ? readCode() : null; code.textContent = draft?.code ?? String(node.attrs.source); language.textContent = draft ? codeLanguage(draft.language)[2] : ''; if (draft) { code.classList.add('syntax-colored'); releaseHighlight = highlightCode(code, draft.code, draft.language ?? 'text'); } }; render();
				const edit = (event?: Event) => {
					event?.preventDefault(); event?.stopPropagation();
					if (destroyed || !this.editable() || !this.options.raw) return;
					const anchored = this.anchorAt(getPos(), node); if (!anchored) return;
					const source = this.options.source();
					if (source.read(anchored.attrs.from, anchored.attrs.to) !== anchored.attrs.source) { this.options.rejected(); return; }
					this.options.raw(String(anchored.attrs.source), { documentId: source.documentId, version: source.version, from: anchored.attrs.from, to: anchored.attrs.to });
				};
				this.rawButtons.add(button); button.addEventListener('click', edit); if (isCode) dom.append(language); dom.append(code, button);
				dom.addEventListener('click', () => {
					const pos = getPos();
					if (typeof pos === 'number' && !this.disposed) {
						const cellIndex = this.view.state.doc.resolve(pos).index(0);
						if (this.selectedCellIndex !== cellIndex) this.selectCell(cellIndex);
					}
				});
				return { dom, stopEvent: () => true, ignoreMutation: () => true,
					update: next => { if (next.type !== node.type || next.attrs.name !== node.attrs.name) return false; const changed = next.attrs.source !== node.attrs.source; node = next; if (changed) render(); return true; },
					destroy: () => { destroyed = true; releaseHighlight?.(); button.removeEventListener('click', edit); this.rawButtons.delete(button); }
				};
			}, table_block: (initial, _view, getPos) => {
				let node = initial, destroyed = false;
				const document = target.ownerDocument;
				const dom = document.createElement('figure'); dom.className = 'visual-table'; dom.contentEditable = 'false';
				const button = document.createElement('button'); button.type = 'button'; button.className = 'visual-table-content'; button.setAttribute('aria-label', this.text('編輯表格', 'Edit table'));
				this.tableButtons.add(button); button.disabled = true;
				const render = () => {
					const draft = parseTable(String(node.attrs.source));
					if (!draft) throw new Error('VISUAL_TABLE');
					const table = document.createElement('table'); table.className = draft.style + (draft.rules === 'booktabs' ? ' booktabs' : ''); table.style.width = `${draft.width}%`;
					if (draft.caption.position !== 'none') {
						const caption = document.createElement('caption'); caption.textContent = draft.caption.text;
						caption.style.captionSide = draft.caption.position === 'above' ? 'top' : 'bottom'; table.append(caption);
					}
					const columns = document.createElement('colgroup');
					for (const width of columnPercentages(draft)) { const col = document.createElement('col'); col.style.width = `${width}%`; columns.append(col); }
					table.append(columns);
					const head = document.createElement('thead'), body = document.createElement('tbody');
					for (let row = 0; row < draft.rows; row++) {
						const line = document.createElement('tr');
						for (let column = 0; column < draft.columns; column++) {
							const cell = document.createElement(draft.header && row === 0 ? 'th' : 'td');
							if (cell.tagName === 'TH') cell.setAttribute('scope', 'col');
							cell.textContent = draft.cells[row * draft.columns + column]!; line.append(cell);
						}
						(draft.header && row === 0 ? head : body).append(line);
					}
					if (draft.header) table.append(head); table.append(body); button.replaceChildren(table); dom.replaceChildren(button);
				};
				const edit = (event?: Event) => {
					event?.preventDefault(); event?.stopPropagation();
					if (destroyed || !this.editable() || !this.options.table) return;
					const anchored = this.anchorAt(getPos(), node); if (!anchored) return;
					const source = this.options.source();
					if (source.read(anchored.attrs.from, anchored.attrs.to) !== anchored.attrs.source) { this.options.rejected(); return; }
					const draft = parseTable(String(anchored.attrs.source));
					if (draft) {
						const position = getPos();
						if (typeof position === 'number') { this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position))); this.selectCell(this.view.state.doc.resolve(position).index(0)); this.view.focus(); }
						this.options.table(draft, { documentId: source.documentId, version: source.version, from: anchored.attrs.from, to: anchored.attrs.to });
					}
				};
				button.addEventListener('click', edit); render();
				dom.addEventListener('mousedown', event => { if (!button.contains(event.target as Node)) event.preventDefault(); });
				dom.addEventListener('click', () => {
					const pos = getPos();
					if (typeof pos === 'number' && !this.disposed) {
						const cellIndex = this.view.state.doc.resolve(pos).index(0);
						this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
						this.view.focus();
						if (this.selectedCellIndex !== cellIndex) this.selectCell(cellIndex);
					}
				});
				return { dom, stopEvent: () => true, ignoreMutation: () => true,
					update: (next) => { if (next.type !== node.type) return false; const changed = next.attrs.source !== node.attrs.source; node = next; if (changed) render(); return true; },
					destroy: () => { destroyed = true; button.removeEventListener('click', edit); this.tableButtons.delete(button); }
				};
			}, math_block: (initial, _view, getPos) => {
				let node = initial, destroyed = false, generation = 0;
				let release: ((() => void) & { update?(latex: string): void }) | null = null;
				const document = target.ownerDocument;
				const inline = initial.type.name === 'math_inline';
				const dom = document.createElement(inline ? 'span' : 'figure'); dom.className = inline ? 'visual-math visual-math-inline' : 'visual-math'; dom.contentEditable = 'false';
				const content = document.createElement('button'); content.type = 'button'; content.className = 'visual-math-content';
				const button = content; button.setAttribute('aria-label', this.text('編輯公式', 'Edit equation')); button.disabled = true;
				this.equationButtons.add(button); dom.append(content);
				const render = () => {
					const ticket = ++generation;
					if (release?.update) { release.update(String(node.attrs.latex)); return; }
					preloadMathRenderer().then(({ renderEquation }) => {
						if (destroyed || this.disposed || ticket !== generation) return;
						release?.(); release = null;
						content.textContent = '';
						release = renderEquation(content, String(node.attrs.latex));
					}).catch(() => { if (!destroyed && !this.disposed && ticket === generation) content.textContent = this.text('公式無法顯示，請使用「編輯公式」。', 'Unable to display the equation. Use “Edit equation”.'); });
				};
				const edit = (event?: Event) => {
					event?.preventDefault(); event?.stopPropagation();
					if (destroyed || !this.editable() || !this.options.equation) return;
					const anchored = this.anchorAt(getPos(), node); if (!anchored) return;
					const source = this.options.source();
					if (source.read(anchored.attrs.from, anchored.attrs.to) !== anchored.attrs.source) { this.options.rejected(); return; }
					this.options.equation({ latex: String(anchored.attrs.latex), inline: Boolean(anchored.attrs.inline) }, { documentId: source.documentId, version: source.version, from: anchored.attrs.from, to: anchored.attrs.to });
				};
				const editKey = (event: KeyboardEvent) => {
					if (event.isComposing || event.keyCode === 229) return;
					if (event.key === 'Backspace' || event.key === 'Delete') {
						const position = getPos();
						if (!this.editable() || typeof position !== 'number') return;
						this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)));
						if (this.deleteMath(event.key)) { event.preventDefault(); event.stopPropagation(); }
					} else if (event.key === 'Enter' || event.key === ' ') edit(event);
				};
				content.addEventListener('click', edit, true); content.addEventListener('keydown', editKey, true); render();
				dom.addEventListener('mousedown', event => { if (!content.contains(event.target as Node)) event.preventDefault(); });
				{
					dom.addEventListener('click', () => {
						const pos = getPos();
						if (typeof pos === 'number' && !this.disposed) {
							const cellIndex = this.view.state.doc.resolve(pos).index(0);
							this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
							if (this.selectedCellIndex !== cellIndex) this.selectCell(cellIndex);
							this.focus();
						}
					});
				}
				return { dom, stopEvent: () => true, ignoreMutation: () => true,
					update: next => { if (next.type !== node.type) return false; const changed = next.attrs.latex !== node.attrs.latex; node = next; if (changed) render(); return true; },
					destroy: () => { destroyed = true; generation++; release?.(); release = null; content.removeEventListener('click', edit, true); content.removeEventListener('keydown', editKey, true); this.equationButtons.delete(button); }
				};
			} },
			dispatchTransaction: (transaction) => this.dispatch(transaction),
			handleKeyDown: (_view, event) => {
				if (_view.composing || event.isComposing || event.keyCode === 229 || event.key === 'Process') return false;
				if (this.editable() && this.commandMode && this.selectedCellIndex !== null && this.options.cellAction &&
					!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['Backspace', 'Delete'].includes(event.key)) {
					const span = this.cellSpan(this.selectedCellIndex);
					if (span && this.options.cellAction('delete', span) !== false) {
						this.selectCell(null); this.commandMode = false; this.options.cellDone?.();
					}
					return true;
				}
				if (!event.ctrlKey && !event.metaKey && !event.altKey && ['Backspace', 'Delete'].includes(event.key) && this.deleteMath(event.key)) return true;
				if (event.key === 'Escape' && this.selectedCellIndex !== null) {
					this.commandMode = true; this.view.focus();
					return true;
				}
				if (this.editable() && this.selectedCellIndex !== null && !event.isComposing && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
					const index = this.selectedCellIndex, next = index + (event.key === 'ArrowUp' ? -1 : 1);
					if (event.altKey && !event.ctrlKey && !event.metaKey) {
						this.moveCell(index, next);
						return true;
					}
					if (this.commandMode || this.view.state.selection instanceof NodeSelection) { this.navigateCell(next); return true; }
				}
				if (event.key === 'Enter' && this.commandMode) { this.commandMode = false; return true; }
				const format = formatShortcut(event);
				if (format && this.options.format && this.editable()) { this.options.format(format); return true; }
				if (!event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat && !event.altKey &&
					event.ctrlKey !== event.metaKey && ['z', 'y'].includes(event.key.toLowerCase())) {
					if (!options.readOnly()) {
						if (this.view.state.storedMarks !== null) this.view.dispatch(this.view.state.tr.setStoredMarks(null));
						if (options.history(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo')) this.focus();
					}
					return true;
				}
				if (event.key === 'Enter' && this.editable()) {
					const selection = this.view.state.selection;
					if (!['paragraph', 'abstract', 'heading'].includes(selection.$from.parent.attrs.role) || !selection.$from.sameParent(selection.$to)) { options.rejected(); return true; }
					return this.insertLineBreak();
				}
				return false;
			},
			handlePaste: (_view, event) => {
				if (!this.editable()) return true;
				if (this.options.pasteImage) {
					try { const image = clipboardImage(event); if (image) { this.options.pasteImage(image); return true; } }
					catch { this.options.rejected(); return true; }
				}
				const text = event.clipboardData?.getData('text/plain');
				if (text !== undefined) this.view.dispatch(this.view.state.tr.insertText(text.replace(/\r\n|\r/g, '\n')));
				return true;
			}
		});
		// Both atom kinds share the real renderer, source authority and teardown.
		this.view.setProps({ nodeViews: { ...this.view.props.nodeViews, math_inline: this.view.props.nodeViews!.math_block! } });
	}
	private editable(): boolean {
		return !this.disposed && !this.options.readOnly() && this.projection?.documentId === this.options.source().documentId && this.projection.version === this.options.source().version;
	}
	private awaitingLineBreak(): boolean {
		if (this.disposed || this.options.readOnly() || !this.pendingLineBreak) return false;
		const source = this.options.source();
		return this.pendingLineBreak.documentId === source.documentId && this.pendingLineBreak.version === source.version;
	}
	private insertLineBreak(): boolean {
		if (!this.editable() || !this.projection) return false;
		const state = this.view.state, selection = state.selection;
		const span = this.formatSelection();
		if (!span || !(selection instanceof TextSelection)) return false;
		const index = selection.$from.index(0), block = this.projection.document.child(index);
		const context = state.storedMarks ?? selection.$from.marks();
		const anchor = visualCaretAnchor(this.projection, index, block, selection.$from.parentOffset, 'right', context.map(visualMarkName));
		const segment = anchor ? this.projection.segments?.[index]?.[anchor.segment] : null;
		if (segment && (!anchor?.safeToSplit || span.to > segment.editTo)) { this.options.rejected(); return true; }
		const wrappers = segment?.wrappers ?? [];
		const insert = [...wrappers].reverse().map(wrapper => wrapper.close).join('') + '\\\\' + wrappers.map(wrapper => wrapper.open).join('');
		const source = this.options.source();
		try {
			const next = this.options.apply(this.projection, [{from: span.from, to: span.to, expected: source.read(span.from, span.to), insert}]);
			this.pendingLineBreak = {documentId: next.documentId, version: next.version, position: selection.from + 1, marks: context.map(visualMarkName), text: ''};
			this.pendingFocus = true;
			this.refresh();
		} catch { this.options.rejected(); }
		return true;
	}
	/** Remove only a source-anchored math atom; never serialize its surrounding paragraph. */
	private deleteMath(key: string): boolean {
		if (!this.editable() || !this.projection) return false;
		const state = this.view.state, selection = state.selection;
		let position: number | null = null;
		if (selection instanceof NodeSelection) position = selection.from;
		else if (selection instanceof TextSelection && selection.empty) {
			const caret = selection.$from, backward = key === 'Backspace';
			const adjacent = backward ? caret.nodeBefore : caret.nodeAfter;
			if (adjacent?.type.name === 'math_inline') position = backward ? caret.pos - adjacent.nodeSize : caret.pos;
			else if (caret.depth === 1 && (backward ? caret.parentOffset === 0 : caret.parentOffset === caret.parent.content.size)) {
				const edge = backward ? caret.before(1) : caret.after(1);
				const neighbor = backward ? state.doc.resolve(edge).nodeBefore : state.doc.resolve(edge).nodeAfter;
				if (neighbor?.type.name === 'math_block') position = backward ? edge - neighbor.nodeSize : edge;
			}
		}
		if (position === null) return false;
		const node = this.projection.document.nodeAt(position);
		if (!node || !['math_inline', 'math_block'].includes(node.type.name)) return false;
		const source = this.options.source();
		try {
			const expected = source.read(node.attrs.from, node.attrs.to);
			if (expected !== node.attrs.source) throw new Error('STALE_VISUAL');
			const next = this.options.apply(this.projection, [{ from: node.attrs.from, to: node.attrs.to, expected, insert: '' }]);
			if (next !== this.options.source()) throw new Error('VISUAL_RECEIPT');
			this.selectedCellIndex = null; this.cellOriginal = null;
			this.pendingMathDeletion = { documentId: next.documentId, version: next.version, position };
			this.pendingFocus = true;
			this.refresh();
		} catch { this.options.rejected(); }
		return true;
	}
	private anchorAt(position: number | undefined, displayed: VisualNode): VisualNode | null {
		const anchored = typeof position === 'number' ? this.projection?.document.nodeAt(position) : null;
		if (!anchored || anchored.type !== displayed.type || anchored.attrs.source !== displayed.attrs.source) {
			this.options.rejected(); return null;
		}
		return anchored;
	}
	private clearStoredMarks(): void {
		if (this.view.state.storedMarks !== null) this.view.updateState(this.view.state.apply(this.view.state.tr.setStoredMarks(null)));
	}
	refresh(): void {
		this.refreshCellToolbar();
		if (this.disposed || this.applying) return;
		const editable = this.editable(), acceptsText = editable || this.awaitingLineBreak();
		if (!acceptsText) this.clearStoredMarks();
		const label = this.label + this.text(' 視覺編輯', ' visual editor');
		if (acceptsText !== this.refreshedEditable || label !== this.refreshedLabel) {
			this.view.setProps({
				editable: () => this.editable() || this.awaitingLineBreak(),
				attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label }
			});
			this.refreshedEditable = acceptsText;
			this.refreshedLabel = label;
		}
		const rawText = this.text('編輯原始碼', 'Edit source');
		for (const button of this.rawButtons) {
			const disabled = !editable || !this.options.raw;
			if (button.disabled !== disabled) button.disabled = disabled;
			const label = button.dataset.code === 'true' ? this.text('編輯程式碼', 'Edit code') : rawText;
			if (button.textContent !== label) button.textContent = label;
		}
		const tableText = this.text('編輯表格', 'Edit table');
		for (const button of this.tableButtons) {
			const disabled = !editable || !this.options.table;
			if (button.disabled !== disabled) button.disabled = disabled;
			if (button.getAttribute('aria-label') !== tableText) button.setAttribute('aria-label', tableText);
		}
		const equationText = this.text('編輯公式', 'Edit equation');
		for (const button of this.equationButtons) {
			const disabled = !editable || !this.options.equation;
			if (button.disabled !== disabled) button.disabled = disabled;
			if (button.getAttribute('aria-label') !== equationText) button.setAttribute('aria-label', equationText);
		}
		const inserterDisabled = !editable || !this.options.insertBlock;
		for (const button of this.inserterButtons) {
			if (!button.isConnected) { this.inserterButtons.delete(button); continue; }
			if (button.disabled !== inserterDisabled) button.disabled = inserterDisabled;
		}
		const actionDisabled = !editable || !this.options.cellAction;
		for (const button of this.cellActionButtons) {
			if (!button.isConnected) { this.cellActionButtons.delete(button); continue; }
			const disabled = actionDisabled || button.dataset.atEdge === 'true';
			if (button.disabled !== disabled) button.disabled = disabled;
		}
		this.options.status(this.projection?.version === this.options.source().version ? 'ready' : 'updating');
	}
	/** A collapsed visual caret changes real ProseMirror typing marks, never source bytes. */
	toggleFormat(format: TextFormat): boolean {
		if (!this.editable() || !this.projection) return false;
		const state = this.view.state, selection = state.selection;
		if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parent.type.name !== 'source_block') return false;
		const index = selection.$from.index(0), resolved = selection.$from;
		const side = resolved.nodeAfter?.isAtom ? 'atom' : resolved.nodeAfter?.isText ? 'right'
			: resolved.nodeBefore?.isText ? 'left' : 'atom';
		const anchor = visualCaretAnchor(this.projection, index, this.projection.document.child(index), resolved.parentOffset, side,
			resolved.marks().map(visualMarkName));
		if (!anchor) return false;
		const active = state.storedMarks === null ? [...anchor.marks] : state.storedMarks.map(visualMarkName);
		if (active.some(name => !supportedVisualMark(name))) return false;
		const next = new Set(active);
		if (next.has(format)) next.delete(format); else next.add(format);
		const nextNames = [...next];
		const changesSourceMarks = nextNames.length !== anchor.marks.length || nextNames.some(name => !anchor.marks.includes(name));
		if (changesSourceMarks && !anchor.safeToSplit) return false;
		this.view.dispatch(state.tr.setStoredMarks(nextNames.map(createVisualMark)));
		return true;
	}
	setLabel(label: string): void {
		if (this.disposed || this.label === label) return;
		this.label = label;
		this.refresh();
	}
	invalidate(): void {
		if (this.disposed) return;
		this.projection = null;
		this.pendingLineBreak = null;
		this.selectedCellIndex = null;
		this.cachedDecorations = null;
		this.refresh();
	}
	sync(parsed: SourceProjection): void {
		if (this.disposed) return;
		const source = this.options.source();
		if (!projectionIsCurrent(source, parsed)) return;
		if (this.projection?.documentId === source.documentId && this.projection.version === source.version) { this.refresh(); return; }
		this.projection = projectVisual(source, parsed);
		if (this.selectedCellIndex !== null) {
			if (this.selectedCellIndex >= this.projection.document.childCount) this.selectedCellIndex = null;
			else if (this.cellOriginal === null && this.projection.document.child(this.selectedCellIndex).type.name === 'source_block') {
				const span = this.cellSpan(this.selectedCellIndex);
				if (span) this.cellOriginal = source.read(span.from, span.to);
			}
		}
		this.cachedDecorations = null;
		const document = this.projection.document;
		const previousSelection = this.view.state.selection;
		const anchor = document.resolve(Math.min(previousSelection.anchor, document.content.size));
		const head = document.resolve(Math.min(previousSelection.head, document.content.size));
		const deletion = this.pendingMathDeletion;
		this.pendingMathDeletion = null;
		const lineBreak = this.pendingLineBreak;
		this.pendingLineBreak = null;
		const currentBreak = lineBreak?.documentId === source.documentId && lineBreak.version === source.version ? lineBreak : null;
		const selection = currentBreak ? TextSelection.near(document.resolve(Math.min(currentBreak.position, document.content.size)))
			: deletion?.documentId === source.documentId && deletion.version === source.version
			? TextSelection.near(document.resolve(Math.min(deletion.position, document.content.size)))
			: TextSelection.between(anchor, head);
		this.view.updateState(EditorState.create({ doc: document, plugins: this.view.state.plugins, selection, ...(currentBreak ? {storedMarks: currentBreak.marks.map(createVisualMark)} : {}) }));
		if (this.pendingMove) {
			const pending = this.pendingMove; this.pendingMove = null;
			if (pending.documentId === source.documentId && pending.version === source.version) {
				this.navigateCell(pending.bodyIndex === undefined ? pending.index : this.bodyCellOrder()?.indices[pending.bodyIndex] ?? pending.index);
			}
		}
		this.refresh();
		if (this.pendingFocus) {
			this.pendingFocus = false;
			const active = this.view.dom.ownerDocument.activeElement;
			if (this.editable() && (!active || active === this.view.dom.ownerDocument.body || this.view.dom.contains(active))) this.view.focus();
		}
		if (currentBreak?.text && this.editable()) this.view.dispatch(this.view.state.tr.insertText(currentBreak.text));
	}
	private dispatch(transaction: Transaction): void {
		if (this.disposed) return;
		// IME/native DOM input can arrive without beforeinput while the worker acknowledges Enter.
		if (transaction.docChanged && this.awaitingLineBreak() && transaction.before.eq(this.view.state.doc)) {
			const start = transaction.before.content.findDiffStart(transaction.doc.content);
			const end = transaction.before.content.findDiffEnd(transaction.doc.content);
			if (start !== null && end?.a === start) {
				const inserted = transaction.doc.slice(start, end.b);
				if (inserted.openStart === 0 && inserted.openEnd === 0 && inserted.content.childCount === 1 && inserted.content.firstChild?.isText) {
					this.pendingLineBreak!.text += inserted.content.firstChild.text!;
					return;
				}
			}
		}
		if (!transaction.docChanged) {
			this.view.updateState(this.view.state.apply(transaction));
			if (transaction.selectionSet && !this.disposed && !this.equationDraft) {
				const resolved = transaction.selection.$from;
				if (resolved.index(0) < this.view.state.doc.childCount) {
					const cellIndex = resolved.index(0);
					if (this.selectedCellIndex !== cellIndex) {
						this.selectCell(cellIndex);
					}
				}
			}
			return;
		}
		if (!this.editable() || !this.projection) { this.options.rejected(); return; }
		const source = this.options.source(), previous = this.projection, retainedMarks = this.view.state.storedMarks;
		// Typing can resume at an unchanged native caret without a selection event.
		// Start its cell session before committing the first change so Cancel keeps
		// the original bytes instead of a partially edited draft.
		if (this.selectedCellIndex === null) {
			const index = transaction.selection.$from.index(0), span = this.cellSpan(index);
			if (span && this.view.state.doc.child(index).type.name === 'source_block') {
				this.selectedCellIndex = index;
				this.cellOriginal = source.read(span.from, span.to);
			}
		}
		try {
			if (!transaction.before.eq(this.view.state.doc)) throw new Error('STALE_VISUAL');
			const prepared = prepareVisualEdit(source, previous, transaction);
			const patches = prepared.patches;
			let nextState = this.view.state.apply(transaction);
			if (retainedMarks !== null && nextState.selection.empty && !this.options.readOnly()) {
				nextState = nextState.apply(nextState.tr.setStoredMarks(retainedMarks));
			}
			const validation: { calls: number; source?: SourceDocument; projection?: VisualProjection } = { calls: 0 };
			const validateNextSource = (next: SourceDocument) => {
				if (validation.calls !== 0) throw new Error('VISUAL_RECEIPT');
				validation.calls++;
				if (!changedSpansMatch(next, source, patches)) throw new Error('VISUAL_RECEIPT');
				const nextProjection = advanceVisual(source, previous, transaction, next, prepared);
				if (nextProjection.viewDocument !== nextState.doc) throw new Error('VISUAL_RECEIPT');
				validation.source = next;
				validation.projection = nextProjection;
			};
			// Compatibility for consumers that only provide apply(). The integrated
			// SourceView path supplies the actual prepared CodeMirror receipt instead.
			if (!this.options.applyValidated) {
				validateNextSource(source.apply({ expectedVersion: source.version, patches }).document);
			}
			this.applying = true;
			const receipt = this.options.applyValidated
				? this.options.applyValidated(previous, patches, validateNextSource)
				: this.options.apply(previous, patches);
			if (validation.calls !== 1 || !validation.source || !validation.projection) throw new Error('VISUAL_RECEIPT');
			const prospective = validation.source, nextProjection = validation.projection;
			const current = this.options.source();
			const committed = receipt === current && (!this.options.applyValidated || receipt === prospective) &&
				receipt.documentId === prospective.documentId && receipt.version === prospective.version && receipt.length === prospective.length &&
				current.documentId === prospective.documentId && current.version === prospective.version && current.length === prospective.length &&
				changedSpansMatch(current, source, patches);
			if (!committed) {
				if (current !== source) this.projection = null;
				this.options.rejected();
				return;
			}
			this.projection = nextProjection;
			// Accepted text edits preserve cell indices. Map the existing widgets and cell
			// decorations through the real transaction instead of rebuilding every cell.
			if (this.cachedDecorations && this.cachedDoc === transaction.before &&
				this.cachedSelectedCell === this.selectedCellIndex && this.cachedEditable === this.editable() &&
				this.cachedLocale === (this.options.locale?.() ?? 'zh-Hant') &&
				transaction.before.childCount === nextState.doc.childCount) {
				this.cachedDecorations = this.cachedDecorations.map(transaction.mapping, nextState.doc);
				this.cachedDoc = nextState.doc;
			} else this.cachedDecorations = null;
			this.view.updateState(nextState);
		} catch (error) {
			try { if (this.options.source() !== source) this.projection = null; }
			catch { this.projection = null; }
			this.options.rejected();
		}
		finally { this.applying = false; this.refresh(); }
	}
	focus(): void {
		if (this.disposed) return;
		if (!this.editable() && !this.options.readOnly()) { this.pendingFocus = true; return; }
		this.view.focus();
	}
	/** Tools capture only one literal text segment, never hidden source selections. */
	insertionSelection(): { span: SourceSpan; inlineOnly: boolean } | null {
		if (!this.editable() || !this.projection) return null;
		const selection = this.view.state.selection;
		if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to) || selection.$from.parent.type.name !== 'source_block') return null;
		const index = selection.$from.index(0), node = this.projection.document.child(index);
		const segments = this.projection.segments?.[index];
		if (segments) {
			const segment = segments.find(segment => !segment.atom && segment.from <= selection.$from.parentOffset && segment.to >= selection.$to.parentOffset);
			if (!segment) return null;
			const from = segment.editFrom + segment.boundaries[selection.$from.parentOffset - segment.from]!;
			const to = segment.editFrom + segment.boundaries[selection.$to.parentOffset - segment.from]!;
			return { span: { documentId: this.projection.documentId, version: this.projection.version, from, to }, inlineOnly: node.attrs.role !== 'paragraph' || segment.marks.length > 0 };
		}
		const span = this.formatSelection();
		return span ? { span, inlineOnly: node.attrs.role !== 'paragraph' } : null;
	}
	formatSelection(): SourceSpan | null {
		if (!this.editable() || !this.projection) return null;
		const selection = this.view.state.selection;
		if (!selection.$from.sameParent(selection.$to) || selection.$from.parent.type.name !== 'source_block') return null;
		const index = selection.$from.index(0), node = this.projection.document.child(index);
		if (selection.empty) {
			const marks = this.view.state.storedMarks ?? selection.$from.marks();
			const anchor = visualCaretAnchor(this.projection, index, node, selection.$from.parentOffset, 'right', marks.map(visualMarkName));
			return anchor ? { documentId: this.projection.documentId, version: this.projection.version, from: anchor.from, to: anchor.from } : null;
		}
		if (this.projection.segments?.[index]?.some(segment => segment.atom && selection.$from.parentOffset < segment.to && selection.$to.parentOffset > segment.from)) return null;
		const boundary = (offset: number, start: boolean): number | null => {
			const segments = this.projection!.segments?.[index];
			if (segments) {
				const candidates = segments.filter(segment => !segment.atom && segment.from <= offset && segment.to >= offset);
				const segment = candidates.find(segment => start ? segment.to > offset : segment.from < offset) ?? candidates[0];
				return segment ? segment.editFrom + segment.boundaries[offset - segment.from]! : null;
			}
			const boundaries = this.projection!.boundaries[index];
			return boundaries && offset < boundaries.length ? node.attrs.editFrom + boundaries[offset]! : null;
		};
		const from = boundary(selection.$from.parentOffset, true), to = boundary(selection.$to.parentOffset, false);
		return from === null || to === null ? null : { documentId: this.projection.documentId, version: this.projection.version, from, to };
	}
	navigate(span: SourceSpan, atEnd = false): boolean {
		if (!this.editable() || !this.projection || span.documentId !== this.projection.documentId || span.version !== this.projection.version) return false;
		let position = -1, atom = false, length = 0;
		this.projection.document.descendants((node, offset) => {
			if (node.attrs.from === span.from && node.attrs.to === span.to) { position = offset; atom = node.isAtom; length = node.content.size; }
		});
		if (position < 0) return false;
		const selection = atom ? NodeSelection.create(this.view.state.doc, position) : TextSelection.near(this.view.state.doc.resolve(position + 1 + (atEnd ? length : 0)));
		this.view.dispatch(this.view.state.tr.setSelection(selection));
		const dom = this.view.nodeDOM(position);
		if (dom instanceof HTMLElement && typeof dom.scrollIntoView === 'function') dom.scrollIntoView({ block: 'nearest' });
		this.focus(); return true;
	}
	dispose(): void { if (this.disposed) return; this.dragCleanup?.(); this.closeEquation(); this.disposed = true; this.projection = null; this.cellOriginal = null; this.cachedDecorations = null; this.inserterButtons.clear(); this.cellActionButtons.clear(); this.view.destroy(); }
	/** Toolbar insertion retains clicked text and the active caret; explicit boundary actions stay separate. */
	toolInsertionSelection(inline = false): { span: SourceSpan; inlineOnly: boolean; atCaret: boolean } | null {
		const captured = this.insertionSelection();
		const selectedIndex = this.selectedCellIndex ?? Math.min(this.view.state.selection.$from.index(0), this.view.state.doc.childCount - 1);
		if (!inline && this.isMaketitleField(this.projection?.document.maybeChild(selectedIndex))) {
			const body = this.bodyInsertionSpan();
			if (body) return { span: body, inlineOnly: false, atCaret: false };
		}
		if (this.selectedCellIndex !== null && captured) {
			const span = this.cellSpan(this.selectedCellIndex), node = this.view.state.doc.child(this.selectedCellIndex);
			if (!inline && span && node.attrs.role === 'paragraph' && /^\s*(?:\\par)?\s*$/.test(this.options.source().read(span.from, span.to))) return { span, inlineOnly: false, atCaret: true };
			const point = this.view.state.selection.head === this.view.state.selection.from ? captured.span.from : captured.span.to;
			return { ...captured, span: { ...captured.span, from: point, to: point }, atCaret: true };
		}
		if (inline) return captured ? { ...captured, atCaret: true } : null;
		const boundary = this.cellInsertionBoundary();
		return boundary ? { span: boundary, inlineOnly: false, atCaret: false } : null;
	}
	cellInsertionBoundary(): SourceSpan | null {
		const index = this.selectedCellIndex ?? Math.min(this.view.state.selection.$from.index(0), this.view.state.doc.childCount - 1);
		if (this.isMaketitleField(this.projection?.document.maybeChild(index))) return this.bodyInsertionSpan();
		return this.boundarySpan(index + 1);
	}
	textStructureSelection(): (StructureSelection & { readonly content: string }) | null {
		if (!this.editable() || !this.projection) return null;
		const index = this.selectedCellIndex ?? Math.min(this.view.state.selection.$from.index(0), this.view.state.doc.childCount - 1);
		// Native ProseMirror nodes deliberately retain their attrs during fast typing.
		// Source coordinates always come from the advanced canonical projection.
		const node = this.projection.document.child(index), span = this.cellSpan(index);
		if (!span || node.type.name !== 'source_block') return null;
		const contentSpan = { ...span, from: node.attrs.name === 'null' && node.content.size === 0 ? node.attrs.editTo : node.attrs.editFrom, to: node.attrs.editTo };
		return { span, contentSpan, name: node.attrs.name, content: this.options.source().read(contentSpan.from, contentSpan.to) };
	}
	/** A structural commit starts a new edit session; Cancel must never restore its old wrapper. */
	selectChangedCell(span: SourceSpan): boolean {
		this.selectCell(null);
		const node = this.projection?.document.content.content.find(node => node.attrs.from === span.from);
		return !!node && this.navigate({ ...span, to: node.attrs.to }, true);
	}
}
