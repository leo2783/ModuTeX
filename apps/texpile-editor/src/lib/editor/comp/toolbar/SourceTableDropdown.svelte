<script lang="ts">
	// The Source-mode counterpart to ToolbarTable: same drag-a-grid gesture, but it writes LaTeX
	// rather than building a ProseMirror node.
	import { getContext, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { EditorState } from '@codemirror/state';
	import { Popover, Portal, Switch } from '@skeletonlabs/skeleton-svelte';
	import { Table } from '@lucide/svelte';
	import { sourceCmView } from '$lib/stores/editorStore';
	import { tablePresetLatex } from './tableLatex';
	import { insertSnippetAtCursor } from './sourceInsert';
	import { TABLE_PACKAGE_CONTEXT, type TablePackageRequester } from '$lib/workspace/table-package-context';
	import { isTableDimension, type TablePreset } from './table-preset-commands';
	import { m } from '$lib/paraglide/messages';

	const MAX = 10;

	let open = $state(false);
	let rows = $state(2);
	let cols = $state(2);
	let float = $state(true);
	let preset = $state<TablePreset>('horizontal-lines');
	let insertPending = $state(false);
	let packageRequest: AbortController | null = null;
	const tablePackages = getContext<TablePackageRequester | undefined>(TABLE_PACKAGE_CONTEXT);

	const cells = $derived(
		Array.from({ length: MAX * MAX }, (_, i) => ({
			row: Math.floor(i / MAX) + 1,
			col: (i % MAX) + 1
		}))
	);

	function preventFocusLoss(e: MouseEvent) {
		e.preventDefault(); // keep the caret in the CodeMirror view
	}

	onDestroy(() => packageRequest?.abort());

	async function insert(r: number, c: number) {
		if (insertPending) return;
		const view = $sourceCmView;
		if (!view || !view.dom.isConnected || view.state.facet(EditorState.readOnly)) return;
		const selection = { from: view.state.selection.main.from, to: view.state.selection.main.to };
		let selectedPreset = preset;
		insertPending = true;
		try {
			if (selectedPreset === 'booktabs' || selectedPreset === 'arydshln') {
				if (!tablePackages) return;
				const controller = new AbortController();
				packageRequest = controller;
				const targetIsCurrent = (patch?: { offset: number; insertedLength: number }) => {
					const current = get(sourceCmView);
					if (current !== view || !view.dom.isConnected) return false;
					const shift = patch && patch.offset < selection.from ? patch.insertedLength : 0;
					const currentSelection = view.state.selection.main;
					return currentSelection.from === selection.from + shift && currentSelection.to === selection.to + shift;
				};
				const lease =
					selectedPreset === 'booktabs'
						? await tablePackages.ensureBooktabs(controller.signal, targetIsCurrent)
						: await tablePackages.ensureArydshln(controller.signal, targetIsCurrent);
				if (!lease || controller.signal.aborted || !lease.isCurrent()) return;
				selectedPreset = lease.preset;
			}
			if (get(sourceCmView) !== view || !view.dom.isConnected || view.state.facet(EditorState.readOnly)) return;
			open = false;
			insertSnippetAtCursor(view, tablePresetLatex({ rows: r, cols: c, float, preset: selectedPreset }));
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
		void insert(rowCount, columnCount);
	}
</script>

<Popover
	{open}
	onOpenChange={(e) => (open = e.open)}
	positioning={{ placement: 'bottom-start', offset: { mainAxis: 0 } }}
	autoFocus={false}
>
	<Popover.Trigger>
		<button
			class="toolbarButton flex items-center rounded p-1 hover:preset-tonal"
			class:preset-tonal-primary={open}
			aria-label={m.tbar_insert_table_aria()}
			title={m.tbar_insert_table_aria()}
			tabindex="-1"
			onmousedown={preventFocusLoss}
		>
			<Table class="h-4.5 w-4.5" />
		</button>
	</Popover.Trigger>

	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content class="card bg-surface-50-950 border-surface-300-700 border p-3 shadow-lg">
				<form onsubmit={insertManualSize}>
					<div>
						<div class="mb-3 grid grid-cols-2 gap-2">
							<label class="label text-xs">
								<span>{m.table_rows_label()}</span>
								<input type="number" min="1" max="10" step="1" required class="input input-sm" name="rows" value="2" />
							</label>
							<label class="label text-xs">
								<span>{m.table_columns_label()}</span>
								<input type="number" min="1" max="10" step="1" required class="input input-sm" name="columns" value="2" />
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
						<p class="mb-2 text-center text-sm">{rows}×{cols}</p>
						<div class="mb-3 grid grid-cols-10 gap-1">
							{#each cells as cell (`${cell.row}-${cell.col}`)}
								<button
									type="button"
									class="h-6 w-6 rounded"
									class:bg-surface-200-800={!(cell.row <= rows && cell.col <= cols)}
									class:bg-blue={cell.row <= rows && cell.col <= cols}
									tabindex="-1"
									onmouseenter={() => {
										rows = cell.row;
										cols = cell.col;
									}}
									onfocus={() => {
										rows = cell.row;
										cols = cell.col;
									}}
									onmousedown={preventFocusLoss}
									disabled={insertPending}
									onclick={() => {
										void insert(cell.row, cell.col);
									}}
									aria-label={m.tbar_insert_table_size_aria({ rows: cell.row, cols: cell.col })}
								></button>
							{/each}
						</div>

						<div class="space-y-1.5">
							<Switch
								name="table-float"
								checked={float}
								onCheckedChange={(e) => (float = e.checked)}
								class="flex cursor-pointer items-center justify-between gap-6 text-sm"
							>
								<Switch.Label>{m.tbar_caption_and_label()}</Switch.Label>
								<Switch.Control class="preset-filled-surface-200-800 data-[state=checked]:preset-filled-primary-500">
									<Switch.Thumb />
								</Switch.Control>
								<Switch.HiddenInput />
							</Switch>
						</div>
					</div>
					<button type="submit" class="btn btn-sm variant-filled-primary w-full" disabled={insertPending}>
						{m.table_insert_button()}
					</button>
				</form>
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>

<style lang="postcss">
	@reference "../../../../app.css";

	.toolbarButton {
		@apply rounded-base transition-all ease-in-out;
	}
</style>
