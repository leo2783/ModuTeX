<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { editorViewStore, templateFeaturesStore } from '$lib/stores/editorStore';
	import { Popover, Portal, Switch, Tooltip } from '@skeletonlabs/skeleton-svelte';
	import { Table } from '@lucide/svelte';
	import { createTableNode } from '$lib/editor/utils/tableUtils';
	import { TABLE_PACKAGE_CONTEXT, type TablePackageRequester } from '$lib/workspace/table-package-context';
	import { isTableDimension, type TablePreset } from './table-preset-commands';
	import { m } from '$lib/paraglide/messages';

	const maxRows = 10;
	const maxCols = 10;

	let open = $state(false);
	let hoveredCells = $state({ rows: 2, cols: 2 });
	let rows = $state(2);
	let cols = $state(2);
	let preset = $state<TablePreset>('full-grid');
	let insertPending = $state(false);
	let packageRequest: AbortController | null = null;
	const tablePackages = getContext<TablePackageRequester | undefined>(TABLE_PACKAGE_CONTEXT);

	const tableCaptionEnabled = $derived($templateFeaturesStore?.tableCaption ?? true);

	let numberedState = $state(true); // user's preference while enabled
	let numbered = $derived(tableCaptionEnabled ? numberedState : false);

	function isCellHighlighted(row, col) {
		return row <= hoveredCells.rows && col <= hoveredCells.cols;
	}

	let highlightedCells = $state(getHighlightedCells());

	function getHighlightedCells() {
		let cells = [];
		for (let row = 1; row <= maxRows; row++) {
			for (let col = 1; col <= maxCols; col++) {
				cells.push({ row, col, highlighted: isCellHighlighted(row, col) });
			}
		}
		return cells;
	}
	function handleMouseOver(row, col) {
		hoveredCells = { rows: row, cols: col };
		rows = row;
		cols = col;
		highlightedCells = getHighlightedCells();
	}

	onDestroy(() => packageRequest?.abort());

	async function insertTable(rowCount = rows, colCount = cols) {
		if (insertPending) return;
		const view = get(editorViewStore);
		if (!view?.dom.isConnected || !view.editable) return;
		const originalState = view.state;
		const originalDoc = originalState.doc;
		const originalSelection = { from: originalState.selection.from, to: originalState.selection.to };
		let chosenPreset = preset;
		insertPending = true;
		try {
			if (chosenPreset === 'booktabs' || chosenPreset === 'arydshln') {
				if (!tablePackages) return;
				const controller = new AbortController();
				packageRequest = controller;
				const targetIsCurrent = () => {
					const current = get(editorViewStore);
					return (
						current === view &&
						view.dom.isConnected &&
						view.state.doc === originalDoc &&
						view.state.selection.from === originalSelection.from &&
						view.state.selection.to === originalSelection.to
					);
				};
				const lease =
					chosenPreset === 'booktabs'
						? await tablePackages.ensureBooktabs(controller.signal, targetIsCurrent)
						: await tablePackages.ensureArydshln(controller.signal, targetIsCurrent);
				if (!lease || controller.signal.aborted || !lease.isCurrent()) return;
				chosenPreset = lease.preset;
			}
			const current = get(editorViewStore);
			if (
				current !== view ||
				!view.dom.isConnected ||
				!view.editable ||
				view.state.doc !== originalDoc ||
				view.state.selection.from !== originalSelection.from ||
				view.state.selection.to !== originalSelection.to
			) {
				return;
			}
			const { state, dispatch } = view;
			const tableNode = createTableNode(state.schema, rowCount, colCount, numbered, chosenPreset);
			dispatch(state.tr.insert(state.selection.from, tableNode));
			view.focus();
			open = false;
		} finally {
			packageRequest = null;
			insertPending = false;
		}
	}

	function insertManualSize(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget;
		if (!(form instanceof HTMLFormElement)) return;
		const rowCount = form.querySelector<HTMLInputElement>('input[name="rows"]')?.valueAsNumber;
		const columnCount = form.querySelector<HTMLInputElement>('input[name="columns"]')?.valueAsNumber;
		if (!isTableDimension(rowCount) || !isTableDimension(columnCount)) return;
		void insertTable(rowCount, columnCount);
	}
</script>

<Popover {open} onOpenChange={(e) => (open = e.open)} positioning={{ placement: 'bottom-start', offset: { mainAxis: 0 } }}>
	<Popover.Trigger class="toolbarButton rounded p-1 hover:bg-surface-200-800">
		<button aria-label={m.tbar_insert_table_aria()} title={m.tbar_insert_table_aria()} class="flex items-center justify-center">
			<Table class="h-5 w-5 text-surface-800-200" />
		</button>
	</Popover.Trigger>

	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content class="card bg-surface-50-950 border-surface-300-700 border p-3 shadow-lg">
				<form onsubmit={insertManualSize}>
					<p class="mb-2 text-center text-sm">{rows}×{cols}</p>
					<div class="mb-3 grid grid-cols-2 gap-2">
						<label class="label text-xs">
							<span>{m.table_rows_label()}</span>
							<input type="number" name="rows" min="1" max="10" step="1" required value="2" class="input input-sm" />
						</label>
						<label class="label text-xs">
							<span>{m.table_columns_label()}</span>
							<input type="number" name="columns" min="1" max="10" step="1" required value="2" class="input input-sm" />
						</label>
					</div>
					<label class="label mb-3 text-xs">
						<span>{m.table_preset_label()}</span>
						<select class="select select-sm" bind:value={preset}>
							<option value="booktabs">{m.table_preset_booktabs()}</option>
							<option value="three-line">{m.table_preset_three_line()}</option>
							<option value="full-grid">{m.table_preset_full_grid()}</option>
							<option value="horizontal-lines">{m.table_preset_horizontal_lines()}</option>
							<option value="arydshln">{m.table_preset_arydshln()}</option>
						</select>
					</label>
					<div class="mb-3 grid grid-cols-10 gap-1">
						{#each highlightedCells as cell (`${cell.row}-${cell.col}`)}
							<button
								type="button"
								class="h-6 w-6 rounded"
								class:bg-surface-200-800={!cell.highlighted}
								class:bg-blue={cell.highlighted}
								onmouseenter={() => handleMouseOver(cell.row, cell.col)}
								onfocus={() => handleMouseOver(cell.row, cell.col)}
								disabled={insertPending}
								onclick={() => void insertTable(cell.row, cell.col)}
								aria-label={m.tbar_insert_table_size_aria({ rows: cell.row, cols: cell.col })}
							></button>
						{/each}
					</div>
					<button type="submit" class="btn btn-sm variant-filled-primary w-full" disabled={insertPending}>
						{m.table_insert_button()}
					</button>

					{#if tableCaptionEnabled}
						<Switch
							name="numbered-table"
							checked={numberedState}
							onCheckedChange={(e) => (numberedState = e.checked)}
							class="flex cursor-pointer items-center justify-between text-sm"
						>
							<Switch.Label>{m.tbar_numbered_table()}</Switch.Label>
							<Switch.Control class="preset-filled-surface-200-800 data-[state=checked]:preset-filled-primary-500">
								<Switch.Thumb />
							</Switch.Control>
							<Switch.HiddenInput />
						</Switch>
					{:else}
						<Tooltip positioning={{ placement: 'top' }} openDelay={200}>
							<Tooltip.Trigger class="w-full">
								<Switch
									name="numbered-table"
									checked={false}
									disabled
									class="flex cursor-not-allowed items-center justify-between text-sm opacity-50"
								>
									<Switch.Label>{m.tbar_numbered_table()}</Switch.Label>
									<Switch.Control class="preset-filled-surface-200-800">
										<Switch.Thumb />
									</Switch.Control>
									<Switch.HiddenInput />
								</Switch>
							</Tooltip.Trigger>
							<Portal>
								<Tooltip.Positioner class="z-floating-ui">
									<Tooltip.Content class="card preset-filled p-2 text-sm">{m.tbar_feature_not_enabled()}</Tooltip.Content>
								</Tooltip.Positioner>
							</Portal>
						</Tooltip>
					{/if}
				</form>
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>
