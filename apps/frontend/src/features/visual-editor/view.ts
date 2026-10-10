import { EditorState, TextSelection, NodeSelection, Plugin, type Transaction } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { DOMSerializer, type Node as VisualNode } from 'prosemirror-model';
import { projectionIsCurrent, type SourceDocument, type SourcePatch, type SourceProjection, type SourceSpan } from '@modutex/document-core';
import { parseTable, columnPercentages, type TableDraft } from '../tables/source.ts';
import type { EquationDraft } from '../math/source.ts';
import { formatShortcut, type TextFormat } from '../source-editor/format.ts';
import { advanceVisual, prepareVisualEdit, projectVisual, visualCaretAnchor, visualSchema, type VisualProjection } from './schema.ts';
import { text, type Language } from '../../i18n/text.ts';

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
	table?(draft: TableDraft, span: SourceSpan): void;
	equation?(draft: EquationDraft, span: SourceSpan): void;
	format?(format: TextFormat): void;
	raw?(source: string, span: SourceSpan): void;
	insertBlock?(kind: 'text' | 'equation' | 'matrix' | 'table', span: SourceSpan, beforeText: boolean): void;
	cellAction?(action: 'delete' | 'move-up' | 'move-down', span: SourceSpan, adjacent?: SourceSpan): void;
	cellSelected?(span: SourceSpan): void;
	cellDone?(): void;
	cellCancel?(span: SourceSpan, original: string): void;
}

let mathRendererPromise: Promise<typeof import('../math/render.ts')> | null = null;
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
	private refreshedEditable: boolean | undefined;
	private refreshedLabel: string | undefined;
	private selectedCellIndex: number | null = null;
	private cellOriginal: string | null = null;
	private readonly tableButtons = new Set<HTMLButtonElement>();
	private readonly equationButtons = new Set<HTMLButtonElement>();
	private readonly rawButtons = new Set<HTMLButtonElement>();
	private readonly inserterButtons = new Set<HTMLButtonElement>();
	private readonly cellActionButtons = new Set<HTMLButtonElement>();
	private cachedDecorations: DecorationSet | null = null;
	private cachedDoc: VisualNode | null = null;
	private cachedEditable: boolean | undefined = undefined;
	private cachedLocale: string | undefined = undefined;
	private cachedSelectedCell: number | null = null;
	private readonly options: VisualOptions;

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

	private text(traditionalChinese: string, english: string): string {
		return text(this.options.locale ? this.options.locale() : 'zh-Hant', traditionalChinese, english);
	}
	private boundarySpan(index: number): SourceSpan | null {
		if (!this.editable() || !this.projection) return null;
		const source = this.options.source();
		if (this.projection.documentId !== source.documentId || this.projection.version !== source.version) return null;
		const childCount = this.projection.document.childCount;
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
	private createBoundaryElement(boundaryIndex: number): HTMLElement {
		const doc = this.view?.dom.ownerDocument ?? document;
		const container = doc.createElement('div');
		container.className = 'visual-cell-boundary';
		container.contentEditable = 'false';
		container.setAttribute('role', 'presentation');
		const trigger = doc.createElement('button');
		trigger.type = 'button';
		trigger.className = 'boundary-trigger';
		trigger.textContent = '+';
		trigger.title = this.text('在此處插入區塊', 'Insert block here');
		trigger.setAttribute('aria-label', this.text('在此處插入區塊', 'Insert block here'));
		trigger.disabled = !this.editable() || !this.options.insertBlock;
		this.inserterButtons.add(trigger);
		const menu = doc.createElement('div');
		menu.className = 'boundary-menu';
		const makeItem = (kind: 'text' | 'equation' | 'matrix' | 'table', label: string, title: string) => {
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
				if (!this.editable() || !this.options.insertBlock) return;
				const span = this.boundarySpan(boundaryIndex);
				if (!span) { this.options.rejected(); return; }
				const next = this.projection?.document.maybeChild(boundaryIndex);
				this.options.insertBlock(kind, span, next?.type.name === 'source_block');
			});
			return button;
		};
		trigger.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			container.classList.toggle('open');
		});
		menu.append(
			makeItem('text', this.text('文字', 'Text'), this.text('插入文字段落', 'Insert text paragraph')),
			makeItem('equation', this.text('公式', 'Equation'), this.text('插入公式', 'Insert equation')),
			makeItem('matrix', this.text('矩陣', 'Matrix'), this.text('插入矩陣', 'Insert matrix')),
			makeItem('table', this.text('表格', 'Table'), this.text('插入表格', 'Insert table'))
		);
		container.append(trigger, menu);
		return container;
	}

	private createCellToolbarElement(cellIndex: number): HTMLElement {
		const doc = this.view?.dom.ownerDocument ?? document;
		const childCount = this.view.state.doc.childCount;
		const node = this.view.state.doc.child(cellIndex);
		const container = doc.createElement('div');
		container.className = 'visual-cell-toolbar';
		container.contentEditable = 'false';
		container.setAttribute('role', 'toolbar');
		container.setAttribute('aria-label', this.text('儲存格操作列', 'Cell actions'));

		const typeBadge = doc.createElement('span');
		typeBadge.className = 'cell-badge';
		let typeName = this.text('文字', 'Text');
		if (node.type.name === 'math_block') typeName = this.text('公式', 'Equation');
		else if (node.type.name === 'table_block') typeName = this.text('表格', 'Table');
		else if (node.type.name === 'raw_block') typeName = this.text('原始碼', 'Raw LaTeX');
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
			const makeItem = (kind: 'text' | 'equation' | 'matrix' | 'table', label: string) => {
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
					const next = this.projection?.document.maybeChild(boundary);
					this.options.insertBlock(kind, span, next?.type.name === 'source_block');
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
				makeItem('table', this.text('表格', 'Table'))
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
		moveUpBtn.disabled = !this.editable() || cellIndex <= 0 || !this.options.cellAction;
		moveUpBtn.dataset.atEdge = String(cellIndex <= 0);
		this.cellActionButtons.add(moveUpBtn);
		moveUpBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.editable() || cellIndex <= 0 || !this.options.cellAction) return;
			const span = this.cellSpan(cellIndex);
			const adjacent = this.cellSpan(cellIndex - 1);
			if (!span || !adjacent) { this.options.rejected(); return; }
			this.selectCell(cellIndex - 1);
			this.cellOriginal = null;
			this.options.cellAction('move-up', span, adjacent);
		});

		const moveDownBtn = doc.createElement('button');
		moveDownBtn.type = 'button';
		moveDownBtn.className = 'cell-tool-btn';
		moveDownBtn.textContent = '↓';
		moveDownBtn.title = this.text('下移儲存格', 'Move cell down');
		moveDownBtn.setAttribute('aria-label', this.text('下移儲存格', 'Move cell down'));
		moveDownBtn.disabled = !this.editable() || cellIndex >= childCount - 1 || !this.options.cellAction;
		moveDownBtn.dataset.atEdge = String(cellIndex >= childCount - 1);
		this.cellActionButtons.add(moveDownBtn);
		moveDownBtn.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.editable() || cellIndex >= childCount - 1 || !this.options.cellAction) return;
			const span = this.cellSpan(cellIndex);
			const adjacent = this.cellSpan(cellIndex + 1);
			if (!span || !adjacent) { this.options.rejected(); return; }
			this.selectCell(cellIndex + 1);
			this.cellOriginal = null;
			this.options.cellAction('move-down', span, adjacent);
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
			this.selectCell(null);
			this.options.cellDone?.();
			this.view.dom.blur();
			this.options.cellAction('delete', span);
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
							const isSelected = i === selected;
							decorations.push(Decoration.node(pos, pos + child.nodeSize, {
								class: `notebook-cell${isSelected ? ' is-selected' : ''}`,
								'data-cell-index': String(i),
								'data-cell-type': child.type.name
							}));
							if (isSelected) {
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
					if (target?.closest('.visual-cell-toolbar') || target?.closest('.visual-cell-boundary')) return false;
					const cell = target?.closest<HTMLElement>('[data-cell-index]');
					// Blank space between cells must not select the nearest paragraph.
					if (!cell || !view.dom.contains(cell)) return false;
					const cellIndex = Number(cell.dataset.cellIndex);
					if (cellIndex !== null && cellIndex !== this.selectedCellIndex) {
						this.selectCell(cellIndex);
					}
					return false;
				}
			}
		});
		this.view = new EditorView(target, { state: EditorState.create({ schema: visualSchema, plugins: [notebookPlugin] }),
			attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label + this.text(' 視覺編輯', ' visual editor') },
			editable: () => this.editable(),
			nodeViews: { source_block: initial => {
				const rendered = DOMSerializer.renderSpec(target.ownerDocument, initial.type.spec.toDOM!(initial));
				return { ...rendered, update: next => next.type === initial.type &&
					next.attrs.role === initial.attrs.role && next.attrs.name === initial.attrs.name && next.attrs.level === initial.attrs.level };
			}, raw_block: (initial, _view, getPos) => {
				let node = initial, destroyed = false;
				const document = target.ownerDocument;
				const dom = document.createElement('section'); dom.className = 'visual-raw'; dom.contentEditable = 'false';
				const code = document.createElement('pre'); code.className = 'raw-latex'; code.setAttribute('aria-label', 'Raw LaTeX');
				const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = this.text('編輯原始碼', 'Edit source'); button.disabled = true;
				const render = () => { code.textContent = String(node.attrs.source); }; render();
				const edit = () => {
					if (destroyed || !this.editable() || !this.options.raw) return;
					const anchored = this.anchorAt(getPos(), node); if (!anchored) return;
					const source = this.options.source();
					if (source.read(anchored.attrs.from, anchored.attrs.to) !== anchored.attrs.source) { this.options.rejected(); return; }
					this.options.raw(String(anchored.attrs.source), { documentId: source.documentId, version: source.version, from: anchored.attrs.from, to: anchored.attrs.to });
				};
				this.rawButtons.add(button); button.addEventListener('click', edit); dom.append(code, button);
				dom.addEventListener('click', () => {
					const pos = getPos();
					if (typeof pos === 'number' && !this.disposed) {
						const cellIndex = this.view.state.doc.resolve(pos).index(0);
						if (this.selectedCellIndex !== cellIndex) this.selectCell(cellIndex);
					}
				});
				return { dom, stopEvent: () => true, ignoreMutation: () => true,
					update: next => { if (next.type !== node.type) return false; const changed = next.attrs.source !== node.attrs.source; node = next; if (changed) render(); return true; },
					destroy: () => { destroyed = true; button.removeEventListener('click', edit); this.rawButtons.delete(button); }
				};
			}, table_block: (initial, _view, getPos) => {
				let node = initial, destroyed = false;
				const document = target.ownerDocument;
				const dom = document.createElement('figure'); dom.className = 'visual-table'; dom.contentEditable = 'false';
				const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = this.text('編輯表格', 'Edit table');
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
					if (draft.header) table.append(head); table.append(body); dom.replaceChildren(table, button);
				};
				const edit = () => {
					if (destroyed || !this.editable() || !this.options.table) return;
					const anchored = this.anchorAt(getPos(), node); if (!anchored) return;
					const source = this.options.source();
					if (source.read(anchored.attrs.from, anchored.attrs.to) !== anchored.attrs.source) { this.options.rejected(); return; }
					const draft = parseTable(String(anchored.attrs.source));
					if (draft) this.options.table(draft, { documentId: source.documentId, version: source.version, from: anchored.attrs.from, to: anchored.attrs.to });
				};
				button.addEventListener('click', edit); render();
				dom.addEventListener('click', () => {
					const pos = getPos();
					if (typeof pos === 'number' && !this.disposed) {
						const cellIndex = this.view.state.doc.resolve(pos).index(0);
						if (this.selectedCellIndex !== cellIndex) this.selectCell(cellIndex);
					}
				});
				return { dom, stopEvent: (event) => button.contains(event.target as Node), ignoreMutation: () => true,
					update: (next) => { if (next.type !== node.type) return false; const changed = next.attrs.source !== node.attrs.source; node = next; if (changed) render(); return true; },
					destroy: () => { destroyed = true; button.removeEventListener('click', edit); this.tableButtons.delete(button); }
				};
			}, math_block: (initial, _view, getPos) => {
				let node = initial, destroyed = false, generation = 0;
				let release: ((() => void) & { update?(latex: string): void }) | null = null;
				const document = target.ownerDocument;
				const inline = initial.type.name === 'math_inline';
				const dom = document.createElement(inline ? 'span' : 'figure'); dom.className = inline ? 'visual-math visual-math-inline' : 'visual-math'; dom.contentEditable = 'false';
				const content = document.createElement(inline ? 'span' : 'div'); content.className = 'visual-math-content';
				const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = this.text('編輯公式', 'Edit equation'); button.disabled = true;
				this.equationButtons.add(button); dom.append(content, button);
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
				const edit = () => {
					if (destroyed || !this.editable() || !this.options.equation) return;
					const anchored = this.anchorAt(getPos(), node); if (!anchored) return;
					const source = this.options.source();
					if (source.read(anchored.attrs.from, anchored.attrs.to) !== anchored.attrs.source) { this.options.rejected(); return; }
					this.options.equation({ latex: String(anchored.attrs.latex), inline: Boolean(anchored.attrs.inline) }, { documentId: source.documentId, version: source.version, from: anchored.attrs.from, to: anchored.attrs.to });
				};
				button.addEventListener('click', edit); render();
				if (!inline) {
					dom.addEventListener('click', () => {
						const pos = getPos();
						if (typeof pos === 'number' && !this.disposed) {
							const cellIndex = this.view.state.doc.resolve(pos).index(0);
							if (this.selectedCellIndex !== cellIndex) this.selectCell(cellIndex);
						}
					});
				}
				return { dom, stopEvent: () => true, ignoreMutation: () => true,
					update: next => { if (next.type !== node.type) return false; const changed = next.attrs.latex !== node.attrs.latex; node = next; if (changed) render(); return true; },
					destroy: () => { destroyed = true; generation++; release?.(); release = null; button.removeEventListener('click', edit); this.equationButtons.delete(button); }
				};
			} },
			dispatchTransaction: (transaction) => this.dispatch(transaction),
			handleKeyDown: (_view, event) => {
				if (event.key === 'Escape' && this.selectedCellIndex !== null) {
					this.selectCell(null);
					return true;
				}
				const format = formatShortcut(event);
				if (format && this.options.format && this.editable()) { this.options.format(format); return true; }
				if (!event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat && !event.altKey &&
					event.ctrlKey !== event.metaKey && ['z', 'y'].includes(event.key.toLowerCase())) {
					if (!options.readOnly()) {
						if (this.view.state.storedMarks !== null) this.view.dispatch(this.view.state.tr.setStoredMarks(null));
						options.history(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
					}
					return true;
				}
				if (event.key === 'Enter' && this.editable()) {
					const selection = this.view.state.selection;
					if (selection.$from.parent.attrs.role !== 'paragraph' || !selection.$from.sameParent(selection.$to)) { options.rejected(); return true; }
					this.view.dispatch(this.view.state.tr.insertText('\n\n')); return true;
				}
				return false;
			},
			handlePaste: (_view, event) => {
				if (!this.editable()) return true;
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
		if (this.disposed || this.applying) return;
		const editable = this.editable();
		if (!editable) this.clearStoredMarks();
		const label = this.label + this.text(' 視覺編輯', ' visual editor');
		if (editable !== this.refreshedEditable || label !== this.refreshedLabel) {
			this.view.setProps({
				editable: () => this.editable(),
				attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label }
			});
			this.refreshedEditable = editable;
			this.refreshedLabel = label;
		}
		const rawText = this.text('編輯原始碼', 'Edit source');
		for (const button of this.rawButtons) {
			const disabled = !editable || !this.options.raw;
			if (button.disabled !== disabled) button.disabled = disabled;
			if (button.textContent !== rawText) button.textContent = rawText;
		}
		const tableText = this.text('編輯表格', 'Edit table');
		for (const button of this.tableButtons) {
			const disabled = !editable || !this.options.table;
			if (button.disabled !== disabled) button.disabled = disabled;
			if (button.textContent !== tableText) button.textContent = tableText;
		}
		const equationText = this.text('編輯公式', 'Edit equation');
		for (const button of this.equationButtons) {
			const disabled = !editable || !this.options.equation;
			if (button.disabled !== disabled) button.disabled = disabled;
			if (button.textContent !== equationText) button.textContent = equationText;
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
			resolved.marks().map(mark => mark.type.name));
		if (!anchor) return false;
		const active = state.storedMarks === null ? [...anchor.marks] : state.storedMarks.map(mark => mark.type.name);
		if (active.some(name => !['strong', 'em', 'underline'].includes(name))) return false;
		const next = new Set(active);
		if (next.has(format)) next.delete(format); else next.add(format);
		const nextNames = ['strong', 'em', 'underline'].filter(name => next.has(name));
		const changesSourceMarks = nextNames.length !== anchor.marks.length || nextNames.some(name => !anchor.marks.includes(name));
		if (changesSourceMarks && !anchor.safeToSplit) return false;
		this.view.dispatch(state.tr.setStoredMarks(nextNames.map(name => visualSchema.marks[name]!.create())));
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
		const position = Math.min(this.view.state.selection.from, document.content.size);
		this.view.updateState(EditorState.create({ doc: document, plugins: this.view.state.plugins, selection: TextSelection.near(document.resolve(position)) }));
		this.refresh();
	}
	private dispatch(transaction: Transaction): void {
		if (this.disposed) return;
		if (!transaction.docChanged) {
			this.view.updateState(this.view.state.apply(transaction));
			if (transaction.selectionSet && !this.disposed) {
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
			this.cachedDecorations = null;
			this.view.updateState(nextState);
		} catch {
			try { if (this.options.source() !== source) this.projection = null; }
			catch { this.projection = null; }
			this.options.rejected();
		}
		finally { this.applying = false; this.refresh(); }
	}
	focus(): void { if (!this.disposed) this.view.focus(); }
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
		if (this.projection.segments?.[index]?.some(segment => segment.atom && selection.$from.parentOffset < segment.to && selection.$to.parentOffset > segment.from)) return null;
		const boundary = (offset: number): number | null => {
			const segments = this.projection!.segments?.[index];
			if (segments) {
				const segment = segments.find(segment => !segment.atom && segment.from <= offset && segment.to >= offset);
				return segment ? segment.editFrom + segment.boundaries[offset - segment.from]! : null;
			}
			const boundaries = this.projection!.boundaries[index];
			return boundaries && offset < boundaries.length ? node.attrs.editFrom + boundaries[offset]! : null;
		};
		const from = boundary(selection.$from.parentOffset), to = boundary(selection.$to.parentOffset);
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
	dispose(): void { if (this.disposed) return; this.disposed = true; this.projection = null; this.cellOriginal = null; this.cachedDecorations = null; this.inserterButtons.clear(); this.cellActionButtons.clear(); this.view.destroy(); }
}
