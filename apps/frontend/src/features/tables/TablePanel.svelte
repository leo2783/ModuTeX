<script lang="ts">
	import { tick, onDestroy } from 'svelte';
	import { ColumnDrag, resizeColumns } from './column-resize.ts';
	import { createTable, changeTableAxis, columnPercentages, tableSource, type TableDraft } from './source.ts';
	import { text, type Language } from '../../i18n/text.ts';
	let { active, locked = false, initialDraft = null, sessionKey = 'insert', editing = false, locale = 'zh-Hant', onInsert, onClose }: { active: boolean; locked?: boolean;
		initialDraft?: TableDraft | null; sessionKey?: string; editing?: boolean; locale?: Language; onInsert: (source: string, booktabs?: boolean) => void; onClose: () => void } = $props();
	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);
	type PanelError = 'axis' | 'weight' | 'content' | 'width';
	function errorMessage(code: PanelError): string {
		if (code === 'axis') return t('表格需保留至少一行一列；最多 100 行、20 列。', 'A table needs at least one row and one column, with at most 100 rows and 20 columns.');
		if (code === 'weight') return t('欄寬請輸入大於 0、最多 1000 的比例。', 'Enter a column width ratio greater than 0 and at most 1000.');
		if (code === 'width') return t('寬度請輸入 1 到 100。', 'Enter a width from 1 to 100.');
		return t('請檢查表格內容與寬度；儲存格和說明只接受單行文字。', 'Check the table content and width. Cells and the caption accept single-line text only.');
	}
	const cellLabel = (row: number, column: number) => t('第 ' + row + ' 行，第 ' + column + ' 列', 'Row ' + row + ', column ' + column);
	let table = $state<TableDraft>(createTable());
	const drag = new ColumnDrag();
	let capture: { element: HTMLButtonElement; pointer: number } | null = null;
	let widthTrack: HTMLDivElement;
	function cancelDrag() {
		drag.cancel(); const previous = capture; capture = null;
		if (previous) { try { if (previous.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer); } catch {} }
	}
	onDestroy(cancelDrag);
	$effect(() => { if (!active || locked) cancelDrag(); });
	let loaded: string | null = null;
	$effect(() => { if (sessionKey !== loaded) { cancelDrag(); table = initialDraft ?? createTable(); loaded = sessionKey; row = 0; column = 0; error = null; } });
	let row = $state(0), column = $state(0), error = $state<PanelError | null>(null);
	let panel: HTMLElement;
	const percentages = $derived(columnPercentages(table));
	$effect(() => { if (active) void tick().then(() => { if (active) panel?.querySelector<HTMLInputElement>('td input, th input')?.focus(); }); });
	function change(axis: 'row' | 'column', action: 'insert' | 'delete', index: number) {
		cancelDrag();
		try {
			const proposal = changeTableAxis(table, axis, action, index);
			if (proposal.discarded && !window.confirm(t('刪除會移除這行或這列的內容。要繼續嗎？', 'Deleting removes the content in this row or column. Continue?'))) return;
			table = proposal.table; row = Math.min(row, table.rows - 1); column = Math.min(column, table.columns - 1); error = null;
		} catch { error = 'axis'; }
	}
	function cell(index: number, value: string) { const cells = [...table.cells]; cells[index] = value; table = { ...table, cells }; }
	function weight(index: number, value: number) {
		cancelDrag();
		if (!Number.isFinite(value) || value <= 0 || value > 1000) { error = 'weight'; return; }
		const weights = [...table.weights]; weights[index] = value; table = { ...table, weights }; error = null;
	}
	function close() { cancelDrag(); onClose(); }
	function insert() { cancelDrag(); try { onInsert(tableSource(table), table.rules === 'booktabs'); } catch { error = 'content'; } }
	function startDrag(event: PointerEvent, boundary: number) {
		if (!active || locked || event.button !== 0) return;
		const element = event.currentTarget as HTMLButtonElement;
		if (!drag.begin(event.pointerId, event.clientX, widthTrack.getBoundingClientRect().width, boundary, table.weights)) return;
		try { element.setPointerCapture(event.pointerId); capture = { element, pointer: event.pointerId }; event.preventDefault(); element.focus(); }
		catch { cancelDrag(); }
	}
	function moveDrag(event: PointerEvent) {
		if (!active || locked) { cancelDrag(); return; }
		const weights = drag.move(event.pointerId, event.clientX);
		if (weights) { table = { ...table, weights }; error = null; }
	}
	function endDrag(event: PointerEvent) { if (drag.end(event.pointerId)) cancelDrag(); }
	function resizeKey(event: KeyboardEvent, boundary: number) {
		if (!active || locked || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault(); cancelDrag();
		table = { ...table, weights: resizeColumns(table.weights, boundary, (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 0.05 : 0.01)) };
	}
</script>

<svelte:window onblur={cancelDrag} />

<section class="table-panel" bind:this={panel} aria-label={editing ? t('編輯表格', 'Edit table') : t('插入表格', 'Insert table')}>
	<div class="header"><h2>{t('表格', 'Table')}</h2><button class="text-button" onclick={close}>{t('關閉', 'Close')}</button></div>
	<fieldset disabled={!active || locked}>
	<div class="options">
		<label>{t('樣式', 'Style')}<select value={table.style} onchange={(event) => { const style = event.currentTarget.value as TableDraft['style']; table = { ...table, style, rules: style === 'three-line' ? table.rules : 'hline' }; }}><option value="three-line">{t('三線表', 'Three-line')}</option><option value="full">{t('全框線', 'All borders')}</option><option value="horizontal">{t('僅橫線', 'Horizontal lines only')}</option></select></label>
		{#if table.style === 'three-line'}<label>{t('線條', 'Rules')}<select value={table.rules ?? 'hline'} onchange={(event) => { table = { ...table, rules: event.currentTarget.value as TableDraft['rules'] }; }}><option value="hline">{t('等粗線（不加套件）', 'Equal-weight rules (no package)')}</option><option value="booktabs">Booktabs</option></select></label>{/if}
		<label>{t('說明', 'Caption')}<select value={table.caption.position} onchange={(event) => { table = { ...table, caption: { ...table.caption, position: event.currentTarget.value as TableDraft['caption']['position'] } }; }}><option value="none">{t('無', 'None')}</option><option value="above">{t('置上', 'Above')}</option><option value="below">{t('置下', 'Below')}</option></select></label>
		<label><input type="checkbox" checked={table.header} onchange={(event) => { table = { ...table, header: event.currentTarget.checked }; }} />{t('首列為表頭', 'First row is header')}</label>
		<label>{t('寬度 (%)', 'Width (%)')}<input type="number" min="1" max="100" value={table.width} onchange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= 1 && value <= 100) { table = { ...table, width: value }; error = null; } else error = 'width'; event.currentTarget.value = String(table.width); }} /></label>
	</div>
	<div class="row-tools" role="group" aria-label={t('所選儲存格的行列操作', 'Row and column actions for selected cell')}>
		<button class="text-button" onclick={() => change('row', 'insert', row)} disabled={table.rows === 100}>{t('上方加行', 'Insert row above')}</button>
		<button class="text-button" onclick={() => change('row', 'insert', row + 1)} disabled={table.rows === 100}>{t('下方加行', 'Insert row below')}</button>
		<button class="text-button" onclick={() => change('column', 'insert', column)} disabled={table.columns === 20}>{t('左側加列', 'Insert column left')}</button>
		<button class="text-button" onclick={() => change('column', 'insert', column + 1)} disabled={table.columns === 20}>{t('右側加列', 'Insert column right')}</button>
		<button class="text-button" onclick={() => change('row', 'delete', row)} disabled={table.rows === 1}>{t('刪除此行', 'Delete this row')}</button>
		<button class="text-button" onclick={() => change('column', 'delete', column)} disabled={table.columns === 1}>{t('刪除此列', 'Delete this column')}</button>
	</div>
	<div class="widths">{#each table.weights as value, index}<label>{t('第 ' + (index + 1) + ' 列', 'Column ' + (index + 1))}<input type="number" min="0.01" max="1000" step="0.1" value={value} onchange={(event) => { weight(index, event.currentTarget.valueAsNumber); event.currentTarget.value = String(table.weights[index]); }} /><span>{percentages[index]!.toFixed(1)}%</span></label>{/each}</div>
	<div class="table-scroll">
		<div class="width-track" bind:this={widthTrack} aria-label={t('欄寬邊界', 'Column width boundaries')}>
			{#each percentages.slice(0, -1) as _, index}
				<button type="button" class="column-boundary" aria-label={t('調整第 ' + (index + 1) + ' 與第 ' + (index + 2) + ' 列的寬度', 'Adjust width between column ' + (index + 1) + ' and column ' + (index + 2))} title={t('拖曳調整欄寬；方向鍵每次調整 1%，Shift 調整 5%', 'Drag to resize column width; arrow keys adjust by 1%, Shift by 5%')}
					style:left={percentages.slice(0, index + 1).reduce((sum, value) => sum + value, 0) + '%'}
					onpointerdown={(event) => startDrag(event, index)} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={endDrag}
					onkeydown={(event) => resizeKey(event, index)}><span aria-hidden="true"></span></button>
			{/each}
		</div>
		<table class:full={table.style === 'full'} class:horizontal={table.style === 'horizontal'} class:three={table.style === 'three-line'} class:booktabs={table.rules === 'booktabs'} aria-label={t('表格儲存格文字', 'Table cell text')}>
		<colgroup>{#each percentages as percent}<col style:width={percent + '%'} />{/each}</colgroup>
		<tbody>{#each Array.from({ length: table.rows }) as _, r}<tr class:heading={table.header && r === 0}>{#each Array.from({ length: table.columns }) as _, c}<td class:selected={row === r && column === c}><input value={table.cells[r * table.columns + c]} maxlength="2048" aria-label={cellLabel(r + 1, c + 1)} onfocus={() => { row = r; column = c; }} oninput={(event) => cell(r * table.columns + c, event.currentTarget.value)} /></td>{/each}</tr>{/each}</tbody>
	</table></div>
	{#if table.caption.position !== 'none'}<label class="caption">{t('表格說明', 'Table caption')}<input value={table.caption.text} maxlength="2048" oninput={(event) => { table = { ...table, caption: { ...table.caption, text: event.currentTarget.value } }; }} /></label>{/if}
	{#if error}<p class="error" role="alert">{errorMessage(error)}</p>{/if}
	<div class="actions"><button onclick={close}>{t('取消', 'Cancel')}</button><button class="primary" onclick={insert}>{editing ? t('套用', 'Apply') : t('插入', 'Insert')}</button></div>
	</fieldset>
</section>

<style>
	.table-panel { padding: 12px 16px; background: var(--canvas); border-bottom: 1px solid var(--line); max-height: 60dvh; overflow: auto; }
	fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
	.header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	h2 { margin: 0; font-size: 16px; font-weight: 600; }
	.options, .row-tools, .widths { display: flex; flex-wrap: wrap; gap: 8px 12px; margin-block: 12px; }
	label { display: flex; align-items: center; gap: 6px; }
	input, select { color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 6px; }
	input[type='number'] { width: 64px; }
	.widths label { font-size: 13px; }
	.table-scroll { overflow-x: auto; }
	.width-track { min-width: 360px; position: relative; height: 36px; border-bottom: 1px solid var(--line); }
	.column-boundary { position: absolute; top: 0; width: 32px; height: 36px; transform: translateX(-50%); cursor: col-resize; touch-action: none; padding: 6px 14px; border: none; background: transparent; }
	.column-boundary span { display: block; width: 4px; height: 24px; border-radius: 2px; background: var(--muted); }
	.column-boundary:hover span, .column-boundary:focus-visible span { background: var(--accent); }
	table { width: 100%; min-width: 360px; border-collapse: collapse; table-layout: fixed; border-block: 1px solid var(--line); }
	td { padding: 2px; }
	.full td { border: 1px solid var(--line); }
	.horizontal tr, .three tr.heading { border-bottom: 1px solid var(--line); }
	.booktabs { border-block: 2px solid var(--ink); }
	td input { min-width: 0; width: 100%; border-color: transparent; background: transparent; }
	.heading input { font-weight: 600; }
	td.selected { background: var(--selection); }
	td input:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
	.caption { margin-top: 12px; }
	.caption input { flex: 1; min-width: 0; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
	.error { color: var(--error); }
</style>
