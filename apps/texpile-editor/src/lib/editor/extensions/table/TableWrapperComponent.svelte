<script lang="ts">
	import { Popover, Portal, Switch, Tooltip } from '@skeletonlabs/skeleton-svelte';
	import {
		Settings,
		ChevronDown,
		AlertCircle,
		Info,
		AlignLeft,
		AlignCenter,
		AlignRight,
		WrapText,
		StretchHorizontal,
		ArrowUp,
		ArrowDown,
		ArrowLeft,
		ArrowRight
	} from '@lucide/svelte';
	import type { Node } from 'prosemirror-model';
	import { sanitizeLabel } from '$lib/editor/utils/label';
	import { isReadOnly } from '$lib/stores/permissionStore';
	import { templateFeaturesStore } from '$lib/stores/editorStore';
	import { parseColspec, generateColspec, type ColAlign } from '$lib/latex-parser/colspec';
	import type { TablePreset, TableStructureAction } from '$lib/editor/comp/toolbar/table-preset-commands';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** typst hides every LaTeX-only control; see tableWrapperView's TableDialect */
		dialect?: 'latex' | 'typst';
		tableNumber: number;
		sectionNumber: string | null;
		node: Node;
		updateAttrs: (attrs: Partial<typeof node.attrs>) => void;
		checkDuplicate: (label: string) => boolean;
		// per-row latex rules (\hline etc.): one string before each row + one after the last row
		rowRules: string[];
		bottomRule: string;
		setRowRule: (rowIndex: number, rule: string) => void;
		setBottomRule: (rule: string) => void;
		setVerticalLines: (on: boolean) => void;
		setColumnWidth: (columnIndex: number, percent: number) => void;
		setCaptionPlacement: (placement: 'none' | 'above' | 'below') => void | Promise<void>;
		// column spec (e.g. "|l|c|p{3cm}|") + the env (X is offered only for tabularx)
		colspec: string;
		tableEnv: string;
		setColspec: (spec: string) => void;
		tablePreset: TablePreset | null;
		canChangePreset: boolean;
		isSelected: boolean;
		applyPreset: (preset: TablePreset) => void;
		canChangeRows: boolean;
		canChangeColumns: boolean;
		canSetColumnWidths: boolean;
		changeStructure: (action: TableStructureAction) => void;
	}

	let {
		dialect = 'latex',
		tableNumber,
		// not yet consulted, reserved for hierarchical numbering (see the commented-out tableDisplay below)
		sectionNumber: _sectionNumber,
		node,
		updateAttrs,
		checkDuplicate,
		rowRules,
		bottomRule,
		setRowRule,
		setBottomRule,
		setVerticalLines: updateVerticalLines,
		setColumnWidth,
		setCaptionPlacement,
		colspec,
		tableEnv,
		setColspec,
		tablePreset,
		canChangePreset,
		isSelected,
		applyPreset,
		canChangeRows,
		canChangeColumns,
		canSetColumnWidths,
		changeStructure
	}: Props = $props();

	const ALIGN_ICONS = [
		{ value: 'l' as ColAlign, icon: AlignLeft, title: m.tablewrap_align_left() },
		{ value: 'c' as ColAlign, icon: AlignCenter, title: m.tablewrap_align_center() },
		{ value: 'r' as ColAlign, icon: AlignRight, title: m.tablewrap_align_right() },
		{ value: 'p' as ColAlign, icon: WrapText, title: m.tablewrap_align_paragraph() },
		{ value: 'X' as ColAlign, icon: StretchHorizontal, title: m.tablewrap_align_stretch(), tabularx: true }
	];
	// columns the table actually has (first row's colspans summed)
	const columnCount = $derived.by(() => {
		let table: Node | null = null;
		node.forEach((c) => {
			if (c.type.name === 'table') table = c as Node;
		});
		if (!table || (table as Node).childCount === 0) return 0;
		let w = 0;
		(table as Node).child(0).forEach((cell) => (w += Number(cell.attrs.colspan ?? 1)));
		return w;
	});
	const isTabularx = $derived(tableEnv === 'tabularx' || tableEnv === 'tabulary');
	const tableHasMergedCells = $derived.by(() => {
		let merged = false;
		node.forEach((child) => {
			if (child.type.name !== 'table') return;
			child.descendants((cell) => {
				if (
					(cell.type.name === 'table_cell' || cell.type.name === 'table_header') &&
					(Number(cell.attrs.colspan ?? 1) > 1 || Number(cell.attrs.rowspan ?? 1) > 1)
				)
					merged = true;
				return !merged;
			});
		});
		return merged;
	});
	// the captured spec, or a default (all centred) for editor-created tables
	const effectiveColspec = $derived(colspec && colspec.trim() ? colspec : 'c'.repeat(columnCount));
	const colModel = $derived(parseColspec(effectiveColspec));
	const verticalLines = $derived(!!colModel && colModel.rules.length > 1 && colModel.rules.every(Boolean));
	const captionNode = $derived.by(() => {
		let found: Node | null = null;
		node.forEach((child) => {
			if (child.type.name === 'table_caption') found = child as Node;
		});
		return found;
	});
	const captionPlacement = $derived(captionNode ? (node.attrs.captionPlacement === 'below' ? 'below' : 'above') : 'none');
	let activeColumn = $state(0);
	let widthDraft = $state(50);
	let activeRuleRow = $state(0);
	function widthPercentForColumn(index: number): number {
		const width = colModel?.columns[index]?.width;
		const match = width?.match(/^((?:\d+(?:\.\d+)?|\.\d+))\\linewidth$/);
		return match ? Math.max(1, Math.min(100, Math.round(Number(match[1]) * 100))) : 50;
	}
	$effect(() => {
		widthDraft = widthPercentForColumn(activeColumn);
		if (activeColumn >= (colModel?.columns.length ?? 0)) activeColumn = Math.max(0, (colModel?.columns.length ?? 1) - 1);
		if (activeRuleRow >= rowRules.length) activeRuleRow = Math.max(0, rowRules.length - 1);
	});

	// p/m/b all read as the paragraph icon; C reads as the X icon
	const activeAlign = (a: ColAlign): ColAlign => (a === 'm' || a === 'b' ? 'p' : a === 'C' ? 'X' : a);

	function setAlign(i: number, align: ColAlign) {
		if (!colModel) return;
		const columns = colModel.columns.map((c, j) => {
			if (j !== i) return c;
			const isPara = align === 'p' || align === 'm' || align === 'b';
			return { align, width: isPara ? (c.width ?? '2cm') : undefined };
		});
		setColspec(generateColspec({ ...colModel, columns }));
	}
	function setWidth(i: number, width: string) {
		if (!colModel) return;
		const columns = colModel.columns.map((c, j) => (j === i ? { ...c, width } : c));
		setColspec(generateColspec({ ...colModel, columns }));
	}
	function setVerticalLines(on: boolean) {
		updateVerticalLines(on);
	}
	const activeRowRule = $derived(rowRules[activeRuleRow] ?? '');
	const activeRowRuleToggleable = $derived(activeRowRule === '' || activeRowRule === '\\hline');
	const bottomRuleToggleable = $derived(bottomRule === '' || bottomRule === '\\hline');
	function toggleActiveRowRule() {
		if (activeRowRuleToggleable) setRowRule(activeRuleRow, activeRowRule === '\\hline' ? '' : '\\hline');
	}
	function toggleBottomRule() {
		if (bottomRuleToggleable) setBottomRule(bottomRule === '\\hline' ? '' : '\\hline');
	}
	function commitWidth(value: number) {
		if (!Number.isInteger(value) || value < 1 || value > 100) {
			widthDraft = widthPercentForColumn(activeColumn);
			return;
		}
		setColumnWidth(activeColumn, value);
	}

	const tableCaptionEnabled = $derived($templateFeaturesStore?.tableCaption ?? true);
	// notes and table* are LaTeX constructs; the typst serializer has nowhere to put them
	const tableNotesEnabled = $derived(dialect === 'latex' && ($templateFeaturesStore?.tableNotes ?? true));
	const columnSpanningEnabled = $derived(dialect === 'latex' && ($templateFeaturesStore?.columnSpanningFigures ?? false));

	let settingsOpen = $state(false);
	let showAdvanced = $state(false);
	let tooltipOpen = $state(false);

	// first-paint snapshot by design, re-synced by the $effect below when the node prop changes
	// svelte-ignore state_referenced_locally
	const initialAttrs = node?.attrs;
	let labelInput = $state(initialAttrs?.label || '');
	let showNotesInput = $state(initialAttrs?.showNotes || false);
	let spanningInput = $state(initialAttrs?.spanning || false);

	// original label, used to revert invalid edits
	const originalTexpileLabel = initialAttrs?.label || '';

	// re-sync when the node changes externally
	$effect(() => {
		labelInput = node?.attrs?.label || '';
		showNotesInput = node?.attrs?.showNotes || false;
		spanningInput = node?.attrs?.spanning || false;
	});

	// validate the label when the popover closes
	$effect(() => {
		if (!settingsOpen) {
			validateAndFixLabel();
		}
	});

	let isDuplicate = $derived(labelInput && !isTexpileManagedLabel(labelInput) && checkDuplicate(labelInput));

	function isTexpileManagedLabel(label: string | null): boolean {
		if (!label) return false;
		return label.startsWith('texpile-table-');
	}

	// display number is calculated (updates when the table moves); the label is only for \ref
	let tableDisplay = $derived(m.tablewrap_table_display({ number: tableNumber }));

	let hasPlaceholderCaption = $derived.by(() => {
		if (!node.content || node.content.childCount === 0) return false;
		const captionNode = node.content.child(0); // table_caption is first child
		if (!captionNode || captionNode.type.name !== 'table_caption') return false;

		// typst numbers a #figure with or without a caption (the serializer just omits the
		// argument), so an empty caption is legitimate there; LaTeX needs \caption to number
		if (captionNode.content.size === 0) return dialect === 'latex';

		const captionText = captionNode.textContent.trim();
		return (captionText === '' && dialect === 'latex') || captionText === 'Table caption';
	});

	// FUTURE: Restore for hierarchical numbering (Table 1.1, 1.2, 2.1...)
	/*
	let tableDisplay = $derived(
		sectionNumber 
			? `Table ${sectionNumber}.${tableNumber}`
			: `Table ${tableNumber}`
	);
	*/

	function validateAndFixLabel() {
		const currentLabel = sanitizeLabel(labelInput);

		if (!currentLabel || checkDuplicate(currentLabel)) {
			labelInput = originalTexpileLabel;
			updateAttrs({ label: originalTexpileLabel });
		}
	}

	function handleLabelInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const newLabel = sanitizeLabel(input.value);
		labelInput = newLabel;
		// don't update attrs yet, wait for blur to validate
	}

	function handleLabelBlur(e: Event) {
		const input = e.target as HTMLInputElement;
		const newLabel = sanitizeLabel(input.value);

		if (!newLabel) {
			labelInput = originalTexpileLabel;
			updateAttrs({ label: originalTexpileLabel });
			return;
		}

		if (checkDuplicate(newLabel)) {
			labelInput = originalTexpileLabel;
			updateAttrs({ label: originalTexpileLabel });
			return;
		}

		updateAttrs({ label: newLabel });
	}

	function handleNotesToggle(details: { checked: boolean }) {
		showNotesInput = details.checked;
		updateAttrs({ showNotes: details.checked });
	}

	function handleSpanningToggle(details: { checked: boolean }) {
		spanningInput = details.checked;
		updateAttrs({ spanning: details.checked });
	}
</script>

<div class="table-header-container">
	{#if !tableCaptionEnabled}
		<div class="table-caption-warning">
			<AlertCircle class="h-4 w-4" />
			<span>{m.tablewrap_caption_unsupported_warning()}</span>
		</div>
	{/if}
	{#if isSelected}
		<section
			class="table-contextual-panel border-surface-300-700 bg-surface-100-900 text-surface-900-100"
			aria-label={m.table_contextual_tools()}
		>
			<div class="table-structure-actions" role="group" aria-label={m.table_structure_actions()}>
				<button
					type="button"
					class="hover:bg-surface-200-800"
					aria-label={m.table_insert_row_above()}
					title={m.table_insert_row_above()}
					disabled={$isReadOnly || !canChangeRows}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => changeStructure('row-before')}
				>
					<ArrowUp class="size-3.5" /><span>{m.table_rows_label()}↑</span>
				</button>
				<button
					type="button"
					class="hover:bg-surface-200-800"
					aria-label={m.table_insert_row_below()}
					title={m.table_insert_row_below()}
					disabled={$isReadOnly || !canChangeRows}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => changeStructure('row-after')}
				>
					<ArrowDown class="size-3.5" /><span>{m.table_rows_label()}↓</span>
				</button>
				<button
					type="button"
					class="hover:bg-surface-200-800"
					aria-label={m.table_insert_column_left()}
					title={m.table_insert_column_left()}
					disabled={$isReadOnly || !canChangeColumns}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => changeStructure('column-before')}
				>
					<ArrowLeft class="size-3.5" /><span>{m.table_columns_label()}←</span>
				</button>
				<button
					type="button"
					class="hover:bg-surface-200-800"
					aria-label={m.table_insert_column_right()}
					title={m.table_insert_column_right()}
					disabled={$isReadOnly || !canChangeColumns}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => changeStructure('column-after')}
				>
					<ArrowRight class="size-3.5" /><span>{m.table_columns_label()}→</span>
				</button>
			</div>
			{#if dialect === 'latex'}
				<label class="label table-contextual-preset text-xs">
					<span>{m.tablewrap_caption_placement()}</span>
					<select
						class="select select-sm"
						value={captionPlacement}
						disabled={$isReadOnly}
						onchange={(event) => setCaptionPlacement((event.currentTarget as HTMLSelectElement).value as 'none' | 'above' | 'below')}
					>
						<option value="none">{m.tablewrap_caption_none()}</option>
						<option value="above">{m.tablewrap_caption_above()}</option>
						<option value="below">{m.tablewrap_caption_below()}</option>
					</select>
				</label>
				{#if !captionNode && node.attrs.label}
					<p class="basis-full text-warning-700 text-xs" role="status">{m.tablewrap_label_without_caption_warning()}</p>
				{/if}
				{#if canSetColumnWidths && colModel && colModel.columns.length > 0}
					<div class="table-width-controls" role="group" aria-label={m.tablewrap_width_controls()}>
						<label class="table-width-column text-xs">
							<span>{m.tablewrap_width_column_label()}</span>
							<select
								class="select select-sm"
								value={activeColumn}
								disabled={$isReadOnly}
								onchange={(event) => (activeColumn = Number((event.currentTarget as HTMLSelectElement).value))}
							>
								{#each colModel.columns as _column, index (index)}
									<option value={index}>{index + 1}</option>
								{/each}
							</select>
						</label>
						<label class="table-width-slider text-xs">
							<span>{m.tablewrap_width_percent()}</span>
							<input
								type="range"
								min="1"
								max="100"
								step="1"
								value={widthDraft}
								aria-label={m.tablewrap_column_width_aria({ index: activeColumn + 1 })}
								disabled={$isReadOnly}
								oninput={(event) => (widthDraft = Number((event.currentTarget as HTMLInputElement).value))}
								onchange={(event) => commitWidth(Number((event.currentTarget as HTMLInputElement).value))}
							/>
						</label>
						<input
							type="number"
							class="input table-width-number px-1.5 py-0.5 text-xs"
							min="1"
							max="100"
							step="1"
							value={widthDraft}
							aria-label={m.tablewrap_column_width_aria({ index: activeColumn + 1 })}
							disabled={$isReadOnly}
							oninput={(event) => (widthDraft = Number((event.currentTarget as HTMLInputElement).value))}
							onchange={(event) => commitWidth(Number((event.currentTarget as HTMLInputElement).value))}
						/>
						<span class="text-surface-500 max-w-44 text-xs">{m.tablewrap_width_hint()}</span>
					</div>
				{/if}
				{#if colModel && colModel.rules.length > 1}
					<Switch
						checked={verticalLines}
						disabled={$isReadOnly || tableHasMergedCells}
						onCheckedChange={(event) => setVerticalLines(event.checked)}
						class="flex items-center gap-2 text-xs"
					>
						<Switch.Label>{m.tablewrap_vertical_lines()}</Switch.Label>
						<Switch.Control class="preset-filled-surface-200-800 data-[state=checked]:preset-filled-primary-500"
							><Switch.Thumb /></Switch.Control
						>
						<Switch.HiddenInput />
					</Switch>
				{/if}
				{#if colModel && colModel.rules.some(Boolean) && !colModel.rules.every(Boolean)}
					<p class="basis-full text-surface-500 text-xs">{m.tablewrap_vertical_lines_partial_hint()}</p>
				{/if}
				<div class="table-rule-controls" role="group" aria-label={m.tablewrap_horizontal_rules()}>
					<label class="text-xs">
						<span>{m.tablewrap_before_row({ index: activeRuleRow + 1 })}</span>
						<select
							class="select select-sm"
							value={activeRuleRow}
							aria-label={m.tablewrap_rule_row_label()}
							disabled={$isReadOnly || rowRules.length === 0}
							onchange={(event) => (activeRuleRow = Number((event.currentTarget as HTMLSelectElement).value))}
						>
							{#each rowRules as _rule, index (index)}
								<option value={index}>{index + 1}</option>
							{/each}
						</select>
					</label>
					<button
						type="button"
						class="table-inline-action hover:bg-surface-200-800"
						aria-pressed={activeRowRule === '\\hline'}
						title={activeRowRuleToggleable ? m.tablewrap_toggle_hline() : m.tablewrap_custom_rule_advanced_hint()}
						disabled={$isReadOnly || !activeRowRuleToggleable}
						onmousedown={(event) => event.preventDefault()}
						onclick={toggleActiveRowRule}>{activeRowRule === '\\hline' ? m.tablewrap_remove_hline() : m.tablewrap_add_hline()}</button
					>
					<button
						type="button"
						class="table-inline-action hover:bg-surface-200-800"
						aria-pressed={bottomRule === '\\hline'}
						title={bottomRuleToggleable ? m.tablewrap_toggle_hline() : m.tablewrap_custom_rule_advanced_hint()}
						disabled={$isReadOnly || !bottomRuleToggleable}
						onmousedown={(event) => event.preventDefault()}
						onclick={toggleBottomRule}
						>{bottomRule === '\\hline' ? m.tablewrap_remove_bottom_hline() : m.tablewrap_add_bottom_hline()}</button
					>
				</div>
			{/if}
			{#if dialect === 'latex'}
				<label class="label table-contextual-preset text-xs">
					<span>{m.table_preset_label()}</span>
					<select
						class="select select-sm"
						value={tablePreset ?? ''}
						disabled={$isReadOnly || !canChangePreset || tableHasMergedCells}
						onchange={(event) => {
							const value = (event.currentTarget as HTMLSelectElement).value;
							if (value) applyPreset(value as TablePreset);
						}}
					>
						{#if !tablePreset}<option value="" disabled>{m.table_preset_custom()}</option>{/if}
						<option value="booktabs">{m.table_preset_booktabs()}</option>
						<option value="three-line">{m.table_preset_three_line()}</option>
						<option value="full-grid">{m.table_preset_full_grid()}</option>
						<option value="horizontal-lines">{m.table_preset_horizontal_lines()}</option>
						<option value="arydshln">{m.table_preset_arydshln()}</option>
					</select>
				</label>
				<p class="text-surface-500 text-xs">{m.table_preset_header_note()}</p>
				{#if tableHasMergedCells}
					<p class="text-surface-500 text-xs" role="status">{m.table_preset_merged_disabled()}</p>
				{:else if !canChangePreset}
					<p class="text-surface-500 text-xs" role="status">{m.table_preset_unknown_disabled()}</p>
				{/if}
			{/if}
		</section>
	{/if}
	<div class="table-header">
		<div class="table-number-row">
			<div class="table-number">{tableDisplay}</div>
			{#if hasPlaceholderCaption}
				<Tooltip open={tooltipOpen} onOpenChange={(e) => (tooltipOpen = e.open)} positioning={{ placement: 'top' }} openDelay={200}>
					<Tooltip.Trigger class="flex items-center">
						<AlertCircle class="text-warning-500 h-4 w-4" />
					</Tooltip.Trigger>
					<Tooltip.Content class="card preset-filled p-2 text-sm">
						{dialect === 'typst' ? m.tablewrap_caption_placeholder_tooltip() : m.tablewrap_caption_required_tooltip()}
					</Tooltip.Content>
				</Tooltip>
			{/if}
		</div>

		<Popover
			open={settingsOpen}
			onOpenChange={(e) => (settingsOpen = e.open)}
			positioning={{ placement: 'bottom-end', offset: { mainAxis: 4 } }}
		>
			<Popover.Trigger class="table-settings-btn">
				<button aria-label={m.tablewrap_settings_button()} title={m.tablewrap_settings_button()} type="button" disabled={$isReadOnly}>
					<Settings class="h-4 w-4" />
				</button>
			</Popover.Trigger>

			<Portal>
				<Popover.Positioner class="z-floating-ui">
					<Popover.Content class="card bg-surface-50-950 border-surface-300-700 min-w-[250px] border shadow-lg">
						<div class="settings-content">
							{#if dialect === 'latex' && colModel && colModel.columns.length > 0}
								<div class="settings-row">
									<div class="text-surface-700-300 mb-1.5 text-xs font-semibold">{m.tablewrap_columns_heading()}</div>
									{#each colModel.columns as col, i (i)}
										<div class="mb-1 flex items-center gap-2">
											<span class="text-surface-400 w-4 text-right text-xs">{i + 1}</span>
											<div class="border-surface-300-700 flex overflow-hidden rounded-base border">
												{#each ALIGN_ICONS as opt (opt.value)}
													{#if !opt.tabularx || isTabularx}
														<button
															type="button"
															title={opt.title}
															aria-label={opt.title}
															class="hover:preset-tonal p-1 {activeAlign(col.align) === opt.value ? 'preset-filled-primary-500' : ''}"
															disabled={tableHasMergedCells}
															onclick={() => setAlign(i, opt.value)}
														>
															<opt.icon class="size-3.5" />
														</button>
													{/if}
												{/each}
											</div>
											{#if col.align === 'p' || col.align === 'm' || col.align === 'b'}
												<input
													class="input w-16 px-1.5 py-0.5 text-xs"
													value={col.width ?? ''}
													placeholder="3cm"
													aria-label={m.tablewrap_column_width_aria({ index: i + 1 })}
													disabled={tableHasMergedCells}
													onchange={(e) => setWidth(i, (e.currentTarget as HTMLInputElement).value)}
												/>
											{/if}
										</div>
									{/each}
									<hr class="border-surface-200-800 mt-3" />
									{#if tableHasMergedCells}
										<p class="text-surface-500 mt-1 text-xs" role="status">{m.table_preset_merged_disabled()}</p>
									{/if}
									<hr class="border-surface-200-800 mt-3" />
								</div>
							{:else if colspec && colspec.trim()}
								<!-- spec too exotic to model visually: edit the verbatim string -->
								<div class="settings-row">
									<div class="text-surface-700-300 mb-1.5 text-xs font-semibold">{m.tablewrap_column_spec()}</div>
									<input
										class="input w-full px-1.5 py-0.5 text-xs"
										value={colspec}
										aria-label={m.tablewrap_column_spec()}
										disabled={$isReadOnly || tableHasMergedCells}
										onchange={(e) => setColspec((e.currentTarget as HTMLInputElement).value)}
									/>
									<div class="text-surface-400 mt-1 text-xs">{m.tablewrap_column_spec_hint()}</div>
									<hr class="border-surface-200-800 mt-3" />
								</div>
							{/if}
							{#if dialect === 'latex'}
								<div class="settings-row">
									{#if tableNotesEnabled}
										<Switch checked={showNotesInput} onCheckedChange={handleNotesToggle} class="flex items-center justify-between gap-3">
											<Switch.Label>{m.tablewrap_show_notes()}</Switch.Label>
											<Switch.Control class="preset-filled-surface-200-800 data-[state=checked]:preset-filled-primary-500">
												<Switch.Thumb />
											</Switch.Control>
											<Switch.HiddenInput />
										</Switch>
									{:else}
										<Tooltip positioning={{ placement: 'top' }} openDelay={200}>
											<Tooltip.Trigger class="w-full">
												<Switch checked={false} disabled class="flex cursor-not-allowed items-center justify-between gap-3 opacity-50">
													<Switch.Label>{m.tablewrap_show_notes()}</Switch.Label>
													<Switch.Control class="preset-filled-surface-200-800">
														<Switch.Thumb />
													</Switch.Control>
													<Switch.HiddenInput />
												</Switch>
											</Tooltip.Trigger>
											<Portal>
												<Tooltip.Positioner class="z-floating-ui">
													<Tooltip.Content class="card preset-filled p-2 text-sm">
														{m.tablewrap_notes_disabled_tooltip()}
													</Tooltip.Content>
												</Tooltip.Positioner>
											</Portal>
										</Tooltip>
									{/if}
								</div>
							{/if}

							{#if columnSpanningEnabled}
								<div class="settings-row">
									<Switch checked={spanningInput} onCheckedChange={handleSpanningToggle} class="flex items-center justify-between gap-3">
										<Switch.Label class="flex items-center gap-2">
											{m.tablewrap_span_columns()}
											<Tooltip positioning={{ placement: 'top' }} openDelay={200}>
												<Tooltip.Trigger class="inline-flex items-center">
													<Info class="text-surface-500 h-3.5 w-3.5" />
												</Tooltip.Trigger>
												<Portal>
													<Tooltip.Positioner class="z-floating-ui">
														<Tooltip.Content class="card preset-filled p-2 text-sm">
															{m.tablewrap_span_columns_tooltip()}
														</Tooltip.Content>
													</Tooltip.Positioner>
												</Portal>
											</Tooltip>
										</Switch.Label>
										<Switch.Control class="preset-filled-surface-200-800 data-[state=checked]:preset-filled-primary-500">
											<Switch.Thumb />
										</Switch.Control>
										<Switch.HiddenInput />
									</Switch>
								</div>
							{/if}

							<button
								type="button"
								class="text-surface-600-400 hover:text-surface-900-100 my-3 flex w-full items-center gap-2 text-sm transition-colors"
								onclick={() => (showAdvanced = !showAdvanced)}
							>
								<ChevronDown class="h-4 w-4 transition-transform {showAdvanced ? 'rotate-180' : ''}" />
								<span>{m.tablewrap_advanced_options()}</span>
							</button>

							{#if showAdvanced}
								<div class="border-surface-300-700 mb-3 space-y-4 pl-6">
									<label class="label">
										<span>
											{dialect === 'typst' ? m.tablewrap_typst_label() : m.tablewrap_latex_label()}
											<span class="text-surface-600-400 text-sm">
												{dialect === 'typst' ? m.tablewrap_typst_label_hint() : m.tablewrap_latex_label_hint()}
											</span>
										</span>
										<input
											id="table-label-input"
											type="text"
											class="input text-sm"
											value={labelInput}
											oninput={handleLabelInput}
											onblur={handleLabelBlur}
											placeholder={m.tablewrap_label_placeholder()}
										/>
										{#if isTexpileManagedLabel(labelInput)}
											<span class="text-surface-500-400 mt-1 flex items-center gap-1 text-xs">
												<Info class="h-3 w-3" />
												{m.tablewrap_label_auto_generated_hint()}
											</span>
										{/if}
										{#if isDuplicate}
											<p class="text-error-500 mt-1 flex items-center gap-1 text-sm">
												<AlertCircle class="h-4 w-4" />
												{m.tablewrap_label_duplicate()}
											</p>
										{/if}
									</label>

									<!-- per-row rules (\hline, \toprule, ...); empty = no rule before that row -->
									{#if dialect === 'latex'}
										<div class="space-y-1.5">
											<span class="text-surface-900-100 block text-sm font-medium">
												{m.tablewrap_row_rules_heading()} <span class="text-surface-600-400 text-xs">{m.tablewrap_row_rules_hint()}</span>
											</span>
											{#each rowRules as rule, i (i)}
												<div class="flex items-center gap-2">
													<span class="text-surface-500-400 w-24 shrink-0 text-xs">{m.tablewrap_before_row({ index: i + 1 })}</span>
													<input
														type="text"
														class="input flex-1 text-xs"
														value={rule}
														placeholder={m.tablewrap_rule_placeholder()}
														onchange={(e) => setRowRule(i, (e.currentTarget as HTMLInputElement).value)}
													/>
												</div>
											{/each}
											<div class="flex items-center gap-2">
												<span class="text-surface-500-400 w-24 shrink-0 text-xs">{m.tablewrap_after_last_row()}</span>
												<input
													type="text"
													class="input flex-1 text-xs"
													value={bottomRule}
													placeholder={m.tablewrap_rule_placeholder()}
													onchange={(e) => setBottomRule((e.currentTarget as HTMLInputElement).value)}
												/>
											</div>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</Popover.Content>
				</Popover.Positioner>
			</Portal>
		</Popover>
	</div>
</div>

<style>
	/* flex container makes whitespace between children irrelevant */
	.table-header-container {
		display: flex;
		flex-direction: column;
	}

	:global(.table-wrapper) {
		margin: 1rem 0;
		border: 1px solid var(--color-surface-300);
		border-radius: 0.5rem;
		padding: 1rem;
		background: var(--color-surface-50);
	}

	/* the tableWrapper boundary breaks drag selection (posAtCoords fails there and the selection
	   collapses), so make it transparent to mouse events. wide tables just overflow, no scrollbar. */
	:global(.ProseMirror .tableWrapper) {
		pointer-events: none;
		overflow: visible !important;
		margin: 0 !important;
		padding: 0 !important;
	}

	:global(.ProseMirror .tableWrapper > *) {
		pointer-events: auto;
	}

	/* over-wide tables scroll inside their own box, the page never gets a horizontal scrollbar */
	:global(.table-wrapper-content) {
		max-width: 100%;
		overflow-x: auto;
	}

	.table-caption-warning {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		margin-bottom: 0.75rem;
		background: var(--color-warning-100);
		border: 1px solid var(--color-warning-400);
		border-radius: 0.375rem;
		color: var(--color-warning-700);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.table-caption-warning :global(svg) {
		flex-shrink: 0;
	}

	.table-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-surface-200);
	}

	.table-contextual-panel {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.6rem;
		border-radius: 0.4rem;
	}

	.table-contextual-preset {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.table-structure-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
	}

	.table-structure-actions button {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.4rem;
		border: 1px solid var(--color-surface-300);
		border-radius: 0.3rem;
		color: inherit;
		font-size: 0.7rem;
	}

	.table-structure-actions button:disabled {
		cursor: not-allowed;
		opacity: 0.7;
	}

	.table-width-controls,
	.table-rule-controls {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.35rem 0.55rem;
	}

	.table-width-controls label,
	.table-rule-controls label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.table-width-slider input {
		width: 5rem;
	}

	.table-width-number {
		width: 3.5rem;
	}

	.table-inline-action {
		border: 1px solid var(--color-surface-300);
		border-radius: 0.3rem;
		padding: 0.2rem 0.4rem;
		color: inherit;
		font-size: 0.7rem;
	}

	.table-inline-action:disabled {
		cursor: not-allowed;
		opacity: 0.7;
	}

	.table-number-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.table-number {
		font-size: 0.875rem;
		font-weight: 700;
		color: var(--color-surface-900);
	}

	:global(.table-settings-btn) button {
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		cursor: pointer;
		transition: background-color 0.15s;
		border: none;
		background: transparent;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.table-settings-btn) button:hover {
		background: var(--color-surface-200);
	}

	.settings-content {
		padding: 0.75rem;
	}

	.settings-row {
		margin-bottom: 0.75rem;
	}

	.settings-row:last-child {
		margin-bottom: 0;
	}

	:global(.table-wrapper-content) {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	:global(.table-wrapper-content .tableWrapper) {
		order: 0;
	}

	:global(.table-wrapper-content .table-notes) {
		order: 2;
	}

	:global(.table-wrapper[data-caption-placement='below'] .table-wrapper-content .table-caption) {
		order: 1;
	}

	:global(.table-caption) {
		font-size: 0.875rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
		color: var(--color-surface-900);
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		cursor: text;
		min-height: 1.5rem;
	}

	:global(.table-notes) {
		font-size: 0.75rem;
		margin-top: 0.5rem;
		color: var(--color-surface-600);
		font-style: italic;
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		cursor: text;
		min-height: 1.5rem;
	}

	:global(.table-wrapper-content.hide-notes .table-notes) {
		display: none;
	}

	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true']) {
		border-collapse: collapse;
	}
	:global(.TexpileEditor .table-wrapper-content:has(table[data-table-preview='true'])) {
		container-type: inline-size;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] td),
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] th) {
		border: 0 solid currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-top='solid']) {
		border-top: 1px solid currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-top='heavy']) {
		border-top: 2px solid currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-top='dashed']) {
		border-top: 1px dashed currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-top='double']) {
		border-top: 3px double currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-bottom='solid']) {
		border-bottom: 1px solid currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-bottom='heavy']) {
		border-bottom: 2px solid currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-bottom='dashed']) {
		border-bottom: 1px dashed currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-bottom='double']) {
		border-bottom: 3px double currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-left='true']) {
		border-left: 1px solid currentColor !important;
	}
	:global(.TexpileEditor .table-wrapper-content table[data-table-preview='true'] [data-table-preview-right='true']) {
		border-right: 1px solid currentColor !important;
	}

	:global(.table-wrapper-content table th) {
		font-weight: 600;
		background: var(--color-surface-100);
	}

	/* the surfaces above are hardcoded light, flip them under data-mode=dark */
	:global([data-mode='dark'] .table-wrapper) {
		background: var(--color-surface-950);
		border-color: var(--color-surface-700);
	}
	:global([data-mode='dark'] .table-caption) {
		color: var(--color-surface-100);
	}
	:global([data-mode='dark'] .table-notes) {
		color: var(--color-surface-400);
	}
	:global([data-mode='dark'] .table-wrapper-content table th) {
		background: var(--color-surface-800);
	}
	:global([data-mode='dark'] .table-settings-btn button:hover) {
		background: var(--color-surface-700);
	}
	:global([data-mode='dark']) .table-header {
		border-bottom-color: var(--color-surface-700);
	}
	:global([data-mode='dark']) .table-number {
		color: var(--color-surface-100);
	}
	:global([data-mode='dark']) .table-caption-warning {
		background: var(--color-warning-950);
		border-color: var(--color-warning-700);
		color: var(--color-warning-200);
	}
</style>
