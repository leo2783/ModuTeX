<script lang="ts">
	import type { Dialect } from '$lib/editor/dialect';
	import { editorViewStore } from '$lib/stores/editorStore';
	import { DOMSerializer } from 'prosemirror-model';
	import { onMount } from 'svelte';
	import { deleteColumn, deleteRow, deleteTable, CellSelection, mergeCells, splitCell } from 'prosemirror-tables';
	import { toaster } from '$lib/modals/toaster-svelte';
	import { sliceToLatex, pasteLatexText } from '$lib/editor/extensions/latexClipboard';
	import { sliceToTypst } from '$lib/typst/visual/clipboard';
	import { Popover, Portal } from '@skeletonlabs/skeleton-svelte';
	import { Copy, Clipboard, Plus, Trash2, Combine, SplitSquareHorizontal, MessageSquarePlus } from '@lucide/svelte';
	import { TextSelection } from 'prosemirror-state';
	import { buildPmAnchor } from '$lib/editor/extensions/pmComments';
	import type { CommentAnchor } from '$lib/comments/anchor';
	import Kbd from '$lib/components/Kbd.svelte';
	import { m } from '$lib/paraglide/messages';
	import { canChangeSelectedTableStructure, changeTableStructure } from './table-preset-commands';

	interface Props {
		/** dialect-aware chrome (see lib/editor/dialect.ts): feature flags derive from this. */
		dialect?: Dialect;
		/** offered as a menu item when present; the anchor is rendered-dialect (see pmComments) */
		onAddComment?: (anchor: CommentAnchor | null) => void;
	}
	let { dialect = 'latex', onAddComment }: Props = $props();
	// merged cells have no pipe-table syntax, so the markdown editor loses merge/split
	const cellMerging = $derived(dialect === 'latex');

	let isVisible: boolean = $state(false);
	let isOnTable: boolean = $state(false);
	/** captured when the menu opens: a text selection Comment could act on */
	let hasTextSelection: boolean = $state(false);
	let selectionType: 'cell' | 'column' | 'row' | null = $state(null);
	let canMerge: boolean = $state(false);
	let canSplit: boolean = $state(false);
	let cursorX: number = $state(0);
	let cursorY: number = $state(0);

	function detectSelectionType(): 'cell' | 'column' | 'row' | null {
		const { state } = $editorViewStore;
		const { selection } = state;

		if (selection instanceof CellSelection) {
			if (selection.isColSelection()) {
				return 'column';
			}
			if (selection.isRowSelection()) {
				return 'row';
			}
			return 'cell';
		}

		return null;
	}

	const menuItems = [
		{
			type: 'item',
			label: m.ctxmenu_copy(),
			icon: Copy,
			shortcut: 'Mod+C',
			action: () => {
				const { state } = $editorViewStore;
				const { from, to } = state.selection;
				if (from === to) {
					return;
				} // nothing to copy
				const slice = state.doc.slice(from, to);
				const fragment = slice.content;

				// the VIEW's schema, not the tex one: the fragment's nodes belong to whichever
				// dialect this editor runs, and nodes must never meet a foreign Schema object
				const serializer = DOMSerializer.fromSchema(state.schema);

				const div = document.createElement('div');
				div.appendChild(serializer.serializeFragment(fragment));
				const html = div.innerHTML;

				// both flavors: HTML for rich internal paste, plus a plain-text form in the
				// EDITOR'S OWN markup - typst selections copy as typst, tex/md as LaTeX
				let latex: string;
				try {
					latex = dialect === 'typst' ? sliceToTypst(slice) : sliceToLatex(slice);
				} catch {
					latex = state.doc.textBetween(from, to, '\n\n');
				}
				navigator.clipboard
					.write([
						new ClipboardItem({
							'text/html': new Blob([html], { type: 'text/html' }),
							'text/plain': new Blob([latex], { type: 'text/plain' })
						})
					])
					.then(() => {
						toaster.info({ title: m.ctxmenu_copied_toast(), duration: 3000 });
					})
					.catch((_err) => {
						toaster.info({ title: m.ctxmenu_copy_failed_toast(), duration: 3000 });
					});
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_paste(),
			icon: Clipboard,
			shortcut: 'Mod+V',
			action: async () => {
				try {
					const clipboardItems = await navigator.clipboard.read();
					for (const item of clipboardItems) {
						if (item.types.includes('text/html')) {
							const blob = await item.getType('text/html');
							const text = await blob.text();
							$editorViewStore.pasteHTML(text);
						} else if (item.types.includes('text/plain')) {
							const blob = await item.getType('text/plain');
							const text = await blob.text();
							// LaTeX text pastes as rich nodes, same as the Ctrl+V path — except in the
							// typst editor, where the latex parser's tex-schema nodes must never land
							if (dialect === 'typst' || !pasteLatexText($editorViewStore, text)) $editorViewStore.pasteText(text);
						} else {
							toaster.warning({
								title: m.ctxmenu_paste_images_hint_toast(),
								duration: 3000
							});
						}
					}
				} catch (_err) {
					toaster.warning({
						title: m.ctxmenu_paste_read_failed_toast(),
						duration: 3000
					});
				}
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_paste_without_formatting(),
			icon: Clipboard,
			shortcut: 'Mod+Shift+V',
			action: async () => {
				try {
					const clipboardItems = await navigator.clipboard.read();
					for (const item of clipboardItems) {
						if (item.types.includes('text/plain')) {
							const blob = await item.getType('text/plain');
							const text = await blob.text();
							$editorViewStore.pasteText(text);
						} else if (item.types.includes('text/html')) {
							const blob = await item.getType('text/html');
							const text = await blob.text();
							const plainText = text.replace(/<[^>]+>/g, '');
							$editorViewStore.pasteText(plainText);
						}
					}
				} catch (_err) {
					toaster.warning({
						title: m.ctxmenu_paste_plain_read_failed_toast(),
						duration: 3000
					});
				}
			}
		}
	];

	const tableMenuItems = [
		{
			type: 'item',
			label: m.ctxmenu_add_column_before(),
			icon: Plus,
			showFor: ['cell', 'column'],
			showWhen: () => canChangeSelectedTableStructure($editorViewStore, dialect, 'column-before'),
			action: () => {
				changeTableStructure($editorViewStore, 'column-before', undefined, dialect);
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_add_column_after(),
			icon: Plus,
			showFor: ['cell', 'column'],
			showWhen: () => canChangeSelectedTableStructure($editorViewStore, dialect, 'column-after'),
			action: () => {
				changeTableStructure($editorViewStore, 'column-after', undefined, dialect);
			}
		},
		{ type: 'separator', showFor: ['cell', 'column'] },
		{
			type: 'item',
			label: m.ctxmenu_add_row_before(),
			icon: Plus,
			showFor: ['cell', 'row'],
			showWhen: () => canChangeSelectedTableStructure($editorViewStore, dialect, 'row-before'),
			action: () => {
				changeTableStructure($editorViewStore, 'row-before', undefined, dialect);
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_add_row_after(),
			icon: Plus,
			showFor: ['cell', 'row'],
			showWhen: () => canChangeSelectedTableStructure($editorViewStore, dialect, 'row-after'),
			action: () => {
				changeTableStructure($editorViewStore, 'row-after', undefined, dialect);
			}
		},
		{ type: 'separator', showFor: ['cell', 'column', 'row'] },
		{
			type: 'item',
			label: m.ctxmenu_merge_cells(),
			icon: Combine,
			showFor: ['cell'],
			showWhen: () => cellMerging && canMerge,
			action: () => {
				const view = $editorViewStore;
				const { state, dispatch } = view;
				mergeCells(state, dispatch);
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_split_cell(),
			icon: SplitSquareHorizontal,
			showFor: ['cell'],
			showWhen: () => cellMerging && canSplit,
			action: () => {
				const view = $editorViewStore;
				const { state, dispatch } = view;
				splitCell(state, dispatch);
			}
		},
		{ type: 'separator', showFor: ['cell'], showWhen: () => cellMerging && (canMerge || canSplit) },
		{
			type: 'item',
			label: m.ctxmenu_delete_column(),
			icon: Trash2,
			showFor: ['cell', 'column'],
			action: () => {
				const view = $editorViewStore;
				const { state, dispatch } = view;
				deleteColumn(state, dispatch);
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_delete_row(),
			icon: Trash2,
			showFor: ['cell', 'row'],
			action: () => {
				const view = $editorViewStore;
				const { state, dispatch } = view;
				deleteRow(state, dispatch);
			}
		},
		{
			type: 'item',
			label: m.ctxmenu_delete_table(),
			icon: Trash2,
			showFor: ['cell', 'column', 'row'],
			action: () => {
				const view = $editorViewStore;
				const { state, dispatch } = view;
				deleteTable(state, dispatch);
			}
		}
	];

	function getVisibleTableMenuItems() {
		let filtered;
		if (!selectionType) {
			filtered = tableMenuItems.filter((item) => {
				if (item.showWhen && !item.showWhen()) return false;
				return true;
			});
		} else {
			filtered = tableMenuItems.filter((item) => {
				if (item.showWhen && !item.showWhen()) return false;

				if (item.type === 'separator') {
					return item.showFor?.includes(selectionType);
				}
				return item.showFor?.includes(selectionType);
			});
		}

		// drop leading/trailing and consecutive separators
		const result = [];
		for (let i = 0; i < filtered.length; i++) {
			const item = filtered[i];
			const isLast = i === filtered.length - 1;
			const isFirst = i === 0;

			if (item.type === 'separator') {
				if (isFirst || isLast) continue;
				if (result.length > 0 && result[result.length - 1].type === 'separator') continue;
			}
			result.push(item);
		}

		if (result.length > 0 && result[result.length - 1].type === 'separator') {
			result.pop();
		}

		return result;
	}

	function handleContextMenu(event: MouseEvent): void {
		// only override the context menu inside the editor
		if (!(event.target as Element).closest('.texpile-main-editor')) {
			return;
		}

		event.preventDefault();

		const coords = { left: event.clientX, top: event.clientY };
		const pos = $editorViewStore.posAtCoords(coords);

		if (pos) {
			const Resolvedpos = $editorViewStore.state.doc.resolve(pos.pos);
			isOnTable = false;
			for (let i = Resolvedpos.depth; i > 0; i--) {
				if (Resolvedpos.node(i).type.name === 'table') {
					isOnTable = true;
					break;
				}
			}
		}

		if (isOnTable) {
			selectionType = detectSelectionType();
			// calling the commands without dispatch just tests applicability
			const { state } = $editorViewStore;
			canMerge = mergeCells(state);
			canSplit = splitCell(state);
		} else {
			selectionType = null;
			canMerge = false;
			canSplit = false;
		}
		const sel = $editorViewStore.state.selection;
		hasTextSelection = sel instanceof TextSelection && !sel.empty;

		isVisible = true;
		cursorX = event.clientX;
		cursorY = event.clientY;

		// empty transaction keeps the selection visible while the editor is blurred
		requestAnimationFrame(() => {
			if ($editorViewStore && !$editorViewStore.hasFocus()) {
				const { state, dispatch } = $editorViewStore;
				const tr = state.tr;
				dispatch(tr);
			}
		});
	}

	function handleClickOutside(event: MouseEvent): void {
		if (isVisible && !(event.target as Element).closest('.context-menu-popover')) {
			isVisible = false;
		}
	}

	function handleItemClick(action: () => void): void {
		action();
		isVisible = false;
		$editorViewStore.focus();
	}

	onMount(() => {
		document.addEventListener('contextmenu', handleContextMenu);
		document.addEventListener('click', handleClickOutside);

		return () => {
			document.removeEventListener('contextmenu', handleContextMenu);
			document.removeEventListener('click', handleClickOutside);
		};
	});
</script>

<Popover
	open={isVisible}
	onOpenChange={(e) => (isVisible = e.open)}
	positioning={{
		getAnchorRect: () => ({
			x: cursorX,
			y: cursorY,
			width: 0,
			height: 0
		}),
		placement: 'bottom-start',
		gutter: 2
	}}
	closeOnInteractOutside={true}
	closeOnEscape={true}
	portalled={true}
	autoFocus={false}
>
	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content class="card bg-surface-50-950 context-menu-popover border-surface-300-700 min-w-[240px] border shadow-lg">
				<div class="py-1">
					{#each menuItems as item}
						{#if item.type === 'separator'}
							<div class="my-1 border-t"></div>
						{:else}
							<button
								type="button"
								class="hover:preset-tonal-primary flex w-full items-center gap-3 px-4 py-2 text-left"
								onclick={() => handleItemClick(item.action)}
								onmousedown={(e) => e.preventDefault()}
							>
								<item.icon class="h-4 w-4 flex-shrink-0" />
								<span class="min-w-0 flex-1 text-sm">{item.label}</span>
								{#if item.shortcut}
									<Kbd keys={item.shortcut} />
								{/if}
							</button>
						{/if}
					{/each}

					{#if onAddComment}
						<!-- the same gesture the floating tooltip offers, for people who reach for the menu;
						     disabled rather than hidden with nothing selected, so it is discoverable -->
						<div class="my-1 border-t"></div>
						<button
							type="button"
							class="hover:preset-tonal-primary flex w-full items-center gap-3 px-4 py-2 text-left disabled:opacity-50"
							disabled={!hasTextSelection}
							onclick={() =>
								handleItemClick(() => {
									const { state } = $editorViewStore;
									const sel = state.selection;
									if (sel instanceof TextSelection && !sel.empty) onAddComment(buildPmAnchor(state.doc, sel.from, sel.to));
								})}
							onmousedown={(e) => e.preventDefault()}
						>
							<MessageSquarePlus class="h-4 w-4 flex-shrink-0" />
							<span class="min-w-0 flex-1 text-sm">{m.comments_add()}</span>
						</button>
					{/if}

					{#if isOnTable}
						<div class="my-1 border-t"></div>
						{#each getVisibleTableMenuItems() as item}
							{#if item?.type === 'separator'}
								<div class="my-1 border-t"></div>
							{:else}
								<button
									type="button"
									class="hover:preset-tonal-primary flex w-full items-center gap-3 px-4 py-2 text-left"
									onclick={() => handleItemClick(item.action)}
									onmousedown={(e) => e.preventDefault()}
								>
									<item.icon class="h-4 w-4 flex-shrink-0" />
									<span class="min-w-0 flex-1 text-sm">{item.label}</span>
								</button>
							{/if}
						{/each}
					{/if}
				</div>
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>

<style>
	/* keep the editor selection visible while the context menu is open */
	:global(.ProseMirror .ProseMirror-selectednode) {
		outline: 2px solid #8cf !important;
	}

	:global(.ProseMirror.ProseMirror-hideselection *::selection),
	:global(.ProseMirror.ProseMirror-hideselection *::-moz-selection) {
		background: transparent !important;
	}

	:global(.ProseMirror *::selection),
	:global(.ProseMirror *::-moz-selection) {
		/* the shared selection colour (app.css), not its own grey: this rule exists to keep the
		   selection visible while the menu is open, and visible-but-recoloured still reads as a
		   different selection */
		background: var(--editor-selection, #d3d3d3);
	}

	:global(.ProseMirror-selectednode) {
		outline: 2px solid #8cf;
	}
</style>
