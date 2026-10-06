import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { get } from 'svelte/store';
import { mount, unmount } from 'svelte';
import { confirmAsk } from '$lib/modals/confirm.svelte';
import { toaster } from '$lib/modals/toaster-svelte';
import { m } from '$lib/paraglide/messages';
import TableWrapperComponent from './TableWrapperComponent.svelte';
import {
	applyTablePreset,
	changeTableStructure,
	detectTablePreset,
	setTableBottomRule,
	setTableCaption,
	setTableColumnWidth,
	setTableRowRule,
	setTableVerticalLines,
	supportsTablePreset,
	supportsTableColumnWidth,
	supportsTableStructure,
	type TableCaptionPlacement,
	type TablePreset,
	type TableStructureAction
} from '$lib/editor/comp/toolbar/table-preset-commands';
import { getActiveTablePackageRequester } from '$lib/workspace/table-package-context';
import { isReadOnly } from '$lib/stores/permissionStore';
import { subscribeTableSelection } from './tableSelectionContext';

/** which markup language the wrapper edits; typst hides every LaTeX-only control
 * (notes, colspec model, row rules, spanning) and never writes tex concepts into the doc. */
export type TableDialect = 'latex' | 'typst';

function isLabelDuplicate(view: EditorView, label: string | null, currentPos: number): boolean {
	if (!label) return false;

	let isDuplicate = false;
	view.state.doc.descendants((node, pos) => {
		if (node.type.name === 'table_wrapper' && pos !== currentPos) {
			if (node.attrs.label === label) {
				isDuplicate = true;
				return false;
			}
		}
	});
	return isDuplicate;
}

// unused, kept for the future template-driven numbering feature
function _generateUniqueLabel(view: EditorView, baseLabel: string, currentPos: number): string {
	let label = baseLabel;
	let counter = 1;

	while (isLabelDuplicate(view, label, currentPos)) {
		label = `${baseLabel}-${counter}`;
		counter++;
	}

	return label;
}

// matches the CSS counter logic. currently unused (sequential numbering);
// TODO: re-enable when template-driven table numbering is implemented
function getSectionNumber(view: EditorView, pos: number): string | null {
	let h1 = 0;
	let h2 = 0;
	let h3 = 0;

	view.state.doc.nodesBetween(0, pos, (node) => {
		if (node.type.name === 'heading') {
			const level = node.attrs.level;
			if (level === 1) {
				h1++;
				h2 = 0;
				h3 = 0;
			} else if (level === 2) {
				h2++;
				h3 = 0;
			} else if (level === 3) {
				h3++;
			}
		}
	});

	if (h3 > 0) {
		return `${h1}.${h2}.${h3}`;
	} else if (h2 > 0) {
		return `${h1}.${h2}`;
	} else if (h1 > 0) {
		return `${h1}`;
	}
	return null;
}

function getTableNumber(view: EditorView, pos: number): number {
	let count = 0;

	view.state.doc.nodesBetween(0, pos, (node) => {
		if (node.type.name === 'table_wrapper') {
			count++;
		}
	});

	return count + 1;
}

// unused, kept for the future template-driven numbering feature
function _getTableNumberHierarchical(view: EditorView, pos: number): number {
	const _sectionNumber = getSectionNumber(view, pos);
	let count = 0;

	let sectionStart = 0;
	view.state.doc.nodesBetween(0, pos, (node, nodePos) => {
		if (node.type.name === 'heading') {
			sectionStart = nodePos;
		}
	});

	view.state.doc.nodesBetween(sectionStart, pos, (node) => {
		if (node.type.name === 'table_wrapper') {
			count++;
		}
	});

	return count + 1;
}

function getTableNode(tableWrapperNode: Node): Node | null {
	let tableNode: Node | null = null;
	tableWrapperNode.forEach((child) => {
		if (child.type.name === 'table') {
			tableNode = child;
		}
	});
	return tableNode;
}

// the rule before each row (table_row.topRules, e.g. "\hline") plus the rule after the last row
// (table.bottomRules); these drive the editable "Row rules" advanced settings
function collectRowRules(tableWrapperNode: Node): { rowRules: string[]; bottomRule: string } {
	const tableNode = getTableNode(tableWrapperNode);
	const rowRules: string[] = [];
	let bottomRule = '';
	if (tableNode) {
		tableNode.forEach((row) => rowRules.push(String(row.attrs.topRules ?? '')));
		bottomRule = String(tableNode.attrs.bottomRules ?? '');
	}
	return { rowRules, bottomRule };
}

export default function tableWrapperView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
	return buildTableWrapperView('latex', node, view, getPos);
}

/** same view over typSchema's table_wrapper: shared header/caption/label UI, tex-only controls hidden. */
export function typstTableWrapperView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
	return buildTableWrapperView('typst', node, view, getPos);
}

function buildTableWrapperView(dialect: TableDialect, node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
	let currentNode = node;

	const dom = document.createElement('div');
	dom.className = 'table-wrapper';
	// refs find this table via data-label
	if (currentNode.attrs.label) {
		dom.setAttribute('data-label', currentNode.attrs.label);
	}

	const componentContainer = document.createElement('div');
	componentContainer.contentEditable = 'false';
	dom.appendChild(componentContainer);

	const contentDOM = document.createElement('div');
	contentDOM.className = 'table-wrapper-content';

	const updateClasses = () => {
		dom.dataset.captionPlacement = currentNode.attrs.captionPlacement === 'below' ? 'below' : 'above';
		if (currentNode.attrs.showNotes) {
			contentDOM.classList.remove('hide-notes');
		} else {
			contentDOM.classList.add('hide-notes');
		}
	};
	updateClasses();

	dom.appendChild(contentDOM);

	const updateAttrs = (attrs: Partial<typeof node.attrs>) => {
		if (!canMutateView()) return;
		const pos = getPos();
		if (pos !== undefined) {
			const tr = view.state.tr.setNodeMarkup(pos, undefined, {
				...currentNode.attrs,
				...attrs
			});
			// typst: renaming the label follows every @ref chip pointing at it, in the same
			// transaction (one undo step). All steps are attr-only, so positions stay valid.
			const oldLabel = currentNode.attrs.label;
			if (dialect === 'typst' && 'label' in attrs && attrs.label !== oldLabel && oldLabel && attrs.label) {
				view.state.doc.descendants((n, p) => {
					if (n.type.name === 'typ_ref' && n.attrs.target === String(oldLabel)) {
						tr.setNodeMarkup(p, undefined, { target: String(attrs.label) });
					}
				});
			}
			view.dispatch(tr);
		}
	};

	// absolute position of the inner `table` node, for editing its rows' rule attrs
	const getTableAbsPos = (): number | null => {
		const pos = getPos();
		if (pos === undefined) return null;
		let tableAbs: number | null = null;
		currentNode.forEach((child, childOffset) => {
			if (child.type.name === 'table') tableAbs = pos + 1 + childOffset;
		});
		return tableAbs;
	};

	// push the latest row-rule strings into the component after an edit (immediate feedback)
	const refreshRowRules = () => {
		const pos = getPos();
		if (pos === undefined) return;
		const updated = view.state.doc.nodeAt(pos);
		if (updated) {
			const r = collectRowRules(updated);
			componentProps.rowRules = r.rowRules;
			componentProps.bottomRule = r.bottomRule;
		}
	};

	const getTableTarget = () => {
		const pos = getTableAbsPos();
		const table = pos === null ? null : view.state.doc.nodeAt(pos);
		return pos !== null && table?.type.name === 'table' ? { pos, node: table } : null;
	};

	const setRowRule = (rowIndex: number, rule: string) => {
		if (!canMutateView()) return;
		const target = getTableTarget();
		if (target && setTableRowRule(view, target, rowIndex, rule)) refreshRowRules();
	};

	const setBottomRule = (rule: string) => {
		if (!canMutateView()) return;
		const target = getTableTarget();
		if (target && setTableBottomRule(view, target, rule)) refreshRowRules();
	};

	const setVerticalLines = (on: boolean) => {
		if (!canMutateView()) return;
		const target = getTableTarget();
		if (target) setTableVerticalLines(view, target, on);
	};

	const setColumnWidth = (columnIndex: number, percent: number) => {
		if (!canMutateView()) return;
		const target = getTableTarget();
		if (target) setTableColumnWidth(view, target, columnIndex, percent);
	};

	const setCaptionPlacement = async (placement: TableCaptionPlacement) => {
		if (!canMutateView()) return;
		const pos = getPos();
		const wrapper = pos === undefined ? null : view.state.doc.nodeAt(pos);
		if (pos === undefined || !wrapper || wrapper !== currentNode || wrapper.type.name !== 'table_wrapper') return;
		const receipt = { pos, node: wrapper, doc: view.state.doc, selection: view.state.selection };
		let allowNonEmptyRemoval = false;
		if (placement === 'none') {
			let caption: Node | null = null;
			wrapper.forEach((child) => {
				if (child.type.name === 'table_caption') caption = child;
			});
			const hasContent = !!caption && (!!caption.textContent.trim() || !!caption.attrs.captionOpt);
			if (hasContent) {
				const confirmed = await confirmAsk(m.tablewrap_caption_remove_confirm(), {
					confirmLabel: m.tablewrap_caption_remove_button(),
					cancelLabel: m.wsview_cancel_label(),
					danger: true
				});
				if (!confirmed) return;
				allowNonEmptyRemoval = true;
			}
		}
		if (!canMutateView()) return;
		if (!setTableCaption(view, receipt, placement, { allowNonEmptyRemoval })) {
			toaster.warning({ title: m.tablewrap_caption_change_stale(), duration: 4000 });
			return;
		}
		if (placement === 'none' && allowNonEmptyRemoval) {
			toaster.info({ title: m.tablewrap_caption_remove_undo(), duration: 5000 });
		}
	};

	const colspecOf = (wrapper: Node): string => String(getTableNode(wrapper)?.attrs.colspec ?? '');
	const envOf = (wrapper: Node): string => String(getTableNode(wrapper)?.attrs.env ?? 'tabular');
	const setColspec = (spec: string) => {
		if (!canMutateView()) return;
		const tableAbs = getTableAbsPos();
		const tableNode = tableAbs === null ? null : view.state.doc.nodeAt(tableAbs);
		if (tableAbs === null || !tableNode) return;
		// setting a spec also pins env (the serializer's faithful path needs both); an editor-created
		// table with no env becomes a plain tabular carrying the user's spec. typst has no env: its
		// colspec is the verbatim `columns:` value, and the serializer count-guards it on its own
		view.dispatch(
			view.state.tr.setNodeMarkup(
				tableAbs,
				undefined,
				dialect === 'latex'
					? { ...tableNode.attrs, colspec: spec, env: tableNode.attrs.env ?? 'tabular' }
					: { ...tableNode.attrs, colspec: spec }
			)
		);
		const pos = getPos();
		const updated = pos !== undefined ? view.state.doc.nodeAt(pos) : null;
		if (updated) componentProps.colspec = colspecOf(updated);
	};

	const applyPreset = async (requestedPreset: TablePreset) => {
		if (!canMutateView()) return;
		const wrapperPos = getPos();
		if (wrapperPos === undefined || view.state.doc.nodeAt(wrapperPos) !== currentNode) return;
		const expectedDoc = view.state.doc;
		const expectedTable = getTableNode(currentNode);
		const tableAbs = getTableAbsPos();
		if (!expectedTable || tableAbs === null || view.state.doc.nodeAt(tableAbs) !== expectedTable) return;
		let preset = requestedPreset;
		if (preset === 'booktabs' || preset === 'arydshln') {
			const requester = getActiveTablePackageRequester();
			if (!requester) return;
			const controller = new AbortController();
			presetRequest?.abort();
			presetRequest = controller;
			try {
				const targetIsCurrent = () => {
					const pos = getPos();
					return (
						pos === wrapperPos &&
						view.dom.isConnected &&
						view.state.doc === expectedDoc &&
						view.state.doc.nodeAt(pos) === currentNode &&
						view.state.doc.nodeAt(tableAbs) === expectedTable
					);
				};
				const lease =
					preset === 'booktabs'
						? await requester.ensureBooktabs(controller.signal, targetIsCurrent)
						: await requester.ensureArydshln(controller.signal, targetIsCurrent);
				if (!lease || controller.signal.aborted || !lease.isCurrent()) return;
				preset = lease.preset;
			} finally {
				if (presetRequest === controller) presetRequest = null;
			}
		}
		if (
			!canMutateView() ||
			getPos() !== wrapperPos ||
			view.state.doc.nodeAt(wrapperPos) !== currentNode ||
			view.state.doc.nodeAt(tableAbs) !== expectedTable
		) {
			return;
		}
		applyTablePreset(view, tableAbs, expectedTable, preset);
	};

	const changeStructure = (action: TableStructureAction) => {
		if (!canMutateView()) return;
		const pos = getTableAbsPos();
		const table = pos === null ? null : view.state.doc.nodeAt(pos);
		if (!table || table !== getTableNode(currentNode)) return;
		changeTableStructure(view, action, { pos, node: table }, dialect);
	};

	let presetRequest: AbortController | null = null;
	const canMutateView = () => view.dom.isConnected && view.editable && !get(isReadOnly);

	const calculateTableData = () => {
		const pos = getPos();
		if (pos === undefined) return { tableNumber: 1, sectionNumber: null };

		return {
			tableNumber: getTableNumber(view, pos),
			sectionNumber: null // sequential numbering, no section needed
			// FUTURE: Restore for hierarchical numbering
			// sectionNumber: getSectionNumber(view, pos)
		};
	};

	const checkDuplicate = (label: string) => {
		const pos = getPos();
		if (pos === undefined) return false;
		return isLabelDuplicate(view, label, pos);
	};

	const initialData = calculateTableData();

	// $state so prop mutations reach the component (svelte 5)
	const initialRules = collectRowRules(currentNode);
	const componentProps = $state({
		dialect,
		tableNumber: initialData.tableNumber,
		sectionNumber: initialData.sectionNumber,
		node: currentNode,
		updateAttrs,
		checkDuplicate,
		rowRules: initialRules.rowRules,
		bottomRule: initialRules.bottomRule,
		setRowRule,
		setBottomRule,
		setVerticalLines,
		setColumnWidth,
		setCaptionPlacement,
		colspec: colspecOf(currentNode),
		tableEnv: envOf(currentNode),
		setColspec,
		tablePreset: (() => {
			const table = getTableNode(currentNode);
			return table ? detectTablePreset(table) : null;
		})(),
		canChangePreset: (() => {
			const table = getTableNode(currentNode);
			return !!table && supportsTablePreset(table);
		})(),
		isSelected: false,
		applyPreset,
		canChangeRows: (() => {
			const table = getTableNode(currentNode);
			return !!table && supportsTableStructure(table, dialect, 'row-before');
		})(),
		canChangeColumns: (() => {
			const table = getTableNode(currentNode);
			return !!table && supportsTableStructure(table, dialect, 'column-before');
		})(),
		canSetColumnWidths: (() => {
			const table = getTableNode(currentNode);
			return dialect === 'latex' && !!table && supportsTableColumnWidth(table);
		})(),
		changeStructure
	});

	const component = mount(TableWrapperComponent, {
		target: componentContainer,
		props: componentProps
	});
	const unsubscribeTableSelection = subscribeTableSelection(view, getPos, (selected) => {
		componentProps.isSelected = selected;
	});

	let lastTableData = initialData;

	return {
		dom,
		contentDOM,
		update(newNode) {
			if (newNode.type !== node.type) return false;
			currentNode = newNode;

			if (currentNode.attrs.label) {
				dom.setAttribute('data-label', currentNode.attrs.label);
			} else {
				dom.removeAttribute('data-label');
			}

			const newTableData = calculateTableData();
			const dataChanged =
				newTableData.tableNumber !== lastTableData.tableNumber || newTableData.sectionNumber !== lastTableData.sectionNumber;

			if (dataChanged) {
				lastTableData = newTableData;
				componentProps.tableNumber = newTableData.tableNumber;
				componentProps.sectionNumber = newTableData.sectionNumber;
			}

			// always update node so caption validation stays reactive
			componentProps.node = currentNode;

			// keep the editable row-rule list + column spec in sync (rows/columns added/removed, etc.)
			const rules = collectRowRules(currentNode);
			componentProps.rowRules = rules.rowRules;
			componentProps.bottomRule = rules.bottomRule;
			componentProps.colspec = colspecOf(currentNode);
			componentProps.tableEnv = envOf(currentNode);
			const table = getTableNode(currentNode);
			componentProps.tablePreset = table ? detectTablePreset(table) : null;
			componentProps.canChangePreset = !!table && supportsTablePreset(table);
			componentProps.canChangeRows = !!table && supportsTableStructure(table, dialect, 'row-before');
			componentProps.canChangeColumns = !!table && supportsTableStructure(table, dialect, 'column-before');
			componentProps.canSetColumnWidths = dialect === 'latex' && !!table && supportsTableColumnWidth(table);

			updateClasses();
			return true;
		},
		destroy() {
			unsubscribeTableSelection();
			presetRequest?.abort();
			presetRequest = null;
			unmount(component);
		},
		// ignore DOM mutations from the svelte component (popover portals, etc.); PM still
		// handles mutations in contentDOM
		ignoreMutation(mutation) {
			if (componentContainer.contains(mutation.target)) {
				return true;
			}
			if (mutation.target === componentContainer) {
				return true;
			}
			return false;
		},
		// keep events inside the settings UI
		stopEvent(event) {
			const target = event.target;
			if (target instanceof HTMLElement && componentContainer.contains(target)) {
				return true;
			}
			return false;
		}
	};
}
