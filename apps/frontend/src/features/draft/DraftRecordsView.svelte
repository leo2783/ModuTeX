<script lang="ts">
	import { text, type Language } from '../../i18n/text.ts';
	import type { DraftDocumentResult, DraftPageRecord } from './types.ts';
	import PdfView from '../pdf/PdfView.svelte';

	let {
		result,
		pdfBytes,
		active = true,
		locale = 'zh-Hant',
		onPoint
	}: {
		result: DraftDocumentResult;
		pdfBytes?: Uint8Array;
		active?: boolean;
		locale?: Language;
		onPoint?: (point: { page: number; x: number; y: number }) => void;
	} = $props();

	const t = (zh: string, en: string) => text(locale, zh, en);

	let pageIndex = $state(0);
	let viewMode = $state<'records' | 'pdf'>('records');
	let metaTab = $state<'none' | 'references' | 'bibliography' | 'images' | 'info'>('none');

	const totalPages = $derived(result.pages.length || result.pageCount || 1);
	const currentPageRecord = $derived.by<DraftPageRecord | null>(() => {
		const pages = result.pages;
		if (!pages) return null;
		const page = pages[pageIndex];
		return page ?? null;
	});
	const hasUnsupportedContent = $derived.by(() => {
		if (result.pdfFallback) return true;
		if (result.unsupportedContentReasons.length > 0) return true;
		if (currentPageRecord && currentPageRecord.unsupportedContentReasons.length > 0) return true;
		return false;
	});
	const effectiveViewMode = $derived(
		hasUnsupportedContent || !currentPageRecord || currentPageRecord.renderableRecords.length === 0
			? 'pdf'
			: viewMode
	);

	function changePage(target: number) {
		if (target >= 0 && target < totalPages) {
			pageIndex = target;
		}
	}

	function handleSvgClick(event: MouseEvent) {
		if (!onPoint || !currentPageRecord) return;
		const svg = event.currentTarget as SVGSVGElement;
		const rect = svg.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const x = ((event.clientX - rect.left) / rect.width) * currentPageRecord.widthPt;
		const y = ((event.clientY - rect.top) / rect.height) * currentPageRecord.heightPt;
		onPoint({ page: pageIndex + 1, x, y });
	}
</script>

<div class="draft-records-view" role="region" aria-label={t('Draft 排版預覽', 'Draft typesetting preview')}>
	<div class="draft-records-bar" role="toolbar" aria-label={t('Draft 視圖控制', 'Draft view controls')}>
		<div class="pagination">
			<button
				class="text-button"
				onclick={() => changePage(pageIndex - 1)}
				disabled={pageIndex <= 0}
				aria-label={t('上一頁', 'Previous page')}
			>
				{t('上一頁', 'Previous')}
			</button>
			<span class="page-indicator">
				{t(`第 ${pageIndex + 1} 頁，共 ${totalPages} 頁`, `Page ${pageIndex + 1} of ${totalPages}`)}
			</span>
			<button
				class="text-button"
				onclick={() => changePage(pageIndex + 1)}
				disabled={pageIndex >= totalPages - 1}
				aria-label={t('下一頁', 'Next page')}
			>
				{t('下一頁', 'Next')}
			</button>
		</div>

		<div class="view-mode-toggle">
			<button
				class="text-button"
				class:selected={effectiveViewMode === 'records'}
				disabled={hasUnsupportedContent || !currentPageRecord || currentPageRecord.renderableRecords.length === 0}
				onclick={() => (viewMode = 'records')}
				title={hasUnsupportedContent ? t('包含未支援內容或字型，以真實 PDF 為準', 'Contains unsupported content or fonts; real PDF fallback used') : undefined}
			>
				{t('快速記錄', 'Records')}
			</button>
			<button
				class="text-button"
				class:selected={effectiveViewMode === 'pdf'}
				disabled={!pdfBytes}
				onclick={() => (viewMode = 'pdf')}
			>
				{t('真實 PDF', 'Real PDF')}
			</button>
		</div>

		<div class="meta-toggle-group">
			{#if result.references.length > 0}
				<button
					class="text-button"
					class:active={metaTab === 'references'}
					onclick={() => (metaTab = metaTab === 'references' ? 'none' : 'references')}
				>
					{t(`參照 (${result.references.length})`, `Refs (${result.references.length})`)}
				</button>
			{/if}
			{#if result.bibliography.length > 0}
				<button
					class="text-button"
					class:active={metaTab === 'bibliography'}
					onclick={() => (metaTab = metaTab === 'bibliography' ? 'none' : 'bibliography')}
				>
					{t(`文獻 (${result.bibliography.length})`, `Bib (${result.bibliography.length})`)}
				</button>
			{/if}
			{#if result.images.length > 0}
				<button
					class="text-button"
					class:active={metaTab === 'images'}
					onclick={() => (metaTab = metaTab === 'images' ? 'none' : 'images')}
				>
					{t(`圖片 (${result.images.length})`, `Images (${result.images.length})`)}
				</button>
			{/if}
			<button
				class="text-button"
				class:active={metaTab === 'info'}
				onclick={() => (metaTab = metaTab === 'info' ? 'none' : 'info')}
			>
				{t('詳細', 'Details')}
			</button>
		</div>
	</div>

	{#if hasUnsupportedContent && effectiveViewMode === 'pdf'}
		<div class="unsupported-banner" role="status">
			<span>
				{t('此頁面包含記錄擷取器尚未支援的巨集、字型或圖形，已切換至真實 PDF 顯示：', 'This page contains content, fonts, or macros not supported by record extraction; displaying real PDF fallback:')}
				{[
					...(currentPageRecord?.unsupportedContentReasons ?? []),
					...result.unsupportedContentReasons
				].filter((v, i, a) => a.indexOf(v) === i).join(', ') || t('需要真實 PDF 渲染', 'Real PDF rendering required')}
			</span>
		</div>
	{/if}

	<div class="display-container">
		{#if effectiveViewMode === 'pdf'}
			{#if pdfBytes}
				<PdfView
					bytes={pdfBytes}
					{active}
					{locale}
					onError={() => {}}
					onPageCount={() => {}}
					{onPoint}
				/>
			{:else}
				<div class="empty-state">
					<p>{t('目前尚無 PDF 備份可顯示。', 'No fallback PDF available for display.')}</p>
				</div>
			{/if}
		{:else if currentPageRecord}
			<div class="svg-stage">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<svg
					viewBox={`0 0 ${currentPageRecord.widthPt} ${currentPageRecord.heightPt}`}
					width={currentPageRecord.widthPt}
					height={currentPageRecord.heightPt}
					class="record-svg"
					onclick={handleSvgClick}
					role="presentation"
				>
					<rect width="100%" height="100%" fill="#ffffff" />

					{#if result.geometry.marginLeftPt > 0}
						<rect
							x={result.geometry.marginLeftPt}
							y={result.geometry.marginTopPt}
							width={Math.max(0, currentPageRecord.widthPt - result.geometry.marginLeftPt - result.geometry.marginRightPt)}
							height={Math.max(0, currentPageRecord.heightPt - result.geometry.marginTopPt - result.geometry.marginBottomPt)}
							fill="none"
							stroke="rgba(0, 120, 215, 0.15)"
							stroke-dasharray="3 3"
						/>
					{/if}

					{#each currentPageRecord.renderableRecords as rec}
						{#if rec.kind === 'rule'}
							<rect
								x={rec.xPt}
								y={rec.yPt}
								width={Math.max(1, rec.widthPt)}
								height={Math.max(1, rec.heightPt)}
								fill="currentColor"
								class="record-rule"
							/>
						{:else if rec.text}
							<text
								x={rec.xPt}
								y={rec.yPt}
								font-size={rec.heightPt > 0 ? rec.heightPt : 10}
								class="record-text"
								fill="currentColor"
							>
								{rec.text}
							</text>
						{:else if rec.kind === 'image'}
							<rect
								x={rec.xPt}
								y={rec.yPt}
								width={rec.widthPt}
								height={rec.heightPt}
								fill="rgba(0, 0, 0, 0.05)"
								stroke="#888"
								stroke-dasharray="4 2"
							/>
						{/if}
					{/each}
				</svg>
			</div>
		{/if}
	</div>

	{#if metaTab !== 'none'}
		<aside class="meta-drawer" role="region" aria-label={t('Draft 詮釋資料', 'Draft metadata')}>
			<div class="meta-header">
				<span>
					{metaTab === 'references'
						? t('文件參照標籤', 'Document References')
						: metaTab === 'bibliography'
							? t('文獻引用項目', 'Bibliography Entries')
							: metaTab === 'images'
								? t('引用圖片列表', 'Referenced Images')
								: t('排版與幾何資訊', 'Typesetting & Geometry')}
				</span>
				<button class="text-button" onclick={() => (metaTab = 'none')}>{t('關閉', 'Close')}</button>
			</div>
			<div class="meta-content">
				{#if metaTab === 'references'}
					<ul class="meta-list">
						{#each result.references as ref}
							<li>
								<span class="badge">{ref.key}</span>
								<span class="label">{ref.label}</span>
								{#if ref.page}<span class="page">p.{ref.page}</span>{/if}
							</li>
						{/each}
					</ul>
				{:else if metaTab === 'bibliography'}
					<ul class="meta-list">
						{#each result.bibliography as bib}
							<li>
								<span class="badge">{bib.citationLabel || bib.key}</span>
								<span class="body">{bib.text}</span>
							</li>
						{/each}
					</ul>
				{:else if metaTab === 'images'}
					<ul class="meta-list">
						{#each result.images as img}
							<li>
								<span class="path">{img.path}</span>
								{#if img.page !== null && img.page !== undefined}<span class="page">p.{img.page}</span>{/if}
							</li>
						{/each}
					</ul>
				{:else if metaTab === 'info'}
					<div class="info-grid">
						<div><strong>{t('耗時', 'Elapsed')}:</strong> {result.elapsedMs} ms</div>
						<div><strong>{t('排版輪次', 'Passes')}:</strong> {result.passCount} ({t('文獻', 'Bib')}: {result.bibliographyPassCount})</div>
						<div><strong>{t('記錄總數', 'Total records')}:</strong> {result.renderableRecordCount}</div>
						<div><strong>{t('紙張尺寸', 'Paper size')}:</strong> {result.geometry.paperWidthPt.toFixed(1)} x {result.geometry.paperHeightPt.toFixed(1)} pt</div>
						<div><strong>{t('邊界', 'Margins')}:</strong> L {result.geometry.marginLeftPt.toFixed(1)}, R {result.geometry.marginRightPt.toFixed(1)}, T {result.geometry.marginTopPt.toFixed(1)}, B {result.geometry.marginBottomPt.toFixed(1)} pt</div>
					</div>
				{/if}
			</div>
		</aside>
	{/if}
</div>

<style>
	.draft-records-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		position: relative;
		background: var(--canvas);
		color: var(--ink);
	}
	.draft-records-bar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
		font-size: 13px;
	}
	.pagination {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.page-indicator {
		font-variant-numeric: tabular-nums;
		font-size: 12px;
	}
	.view-mode-toggle {
		display: flex;
		gap: 4px;
		margin-left: 8px;
		border-left: 1px solid var(--line);
		padding-left: 8px;
	}
	.view-mode-toggle button.selected {
		font-weight: 600;
		background: var(--line);
		border-radius: 3px;
	}
	.meta-toggle-group {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}
	.meta-toggle-group button.active {
		font-weight: 600;
		background: var(--line);
		border-radius: 3px;
	}
	.unsupported-banner {
		padding: 6px 12px;
		background: rgba(255, 180, 0, 0.15);
		border-bottom: 1px solid rgba(255, 180, 0, 0.3);
		font-size: 12px;
	}
	.display-container {
		flex: 1;
		min-height: 0;
		overflow: auto;
		position: relative;
	}
	.svg-stage {
		display: flex;
		justify-content: center;
		padding: 24px;
		background: var(--canvas);
	}
	.record-svg {
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		background: #ffffff;
		cursor: crosshair;
	}
	.record-text {
		font-family: serif;
		user-select: text;
	}
	.meta-drawer {
		border-top: 1px solid var(--line);
		background: var(--surface);
		max-height: 200px;
		overflow: auto;
		font-size: 12px;
	}
	.meta-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 12px;
		border-bottom: 1px solid var(--line);
		font-weight: 600;
	}
	.meta-content {
		padding: 8px 12px;
	}
	.meta-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.meta-list li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.badge {
		font-family: monospace;
		background: var(--line);
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 11px;
	}
	.info-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 8px;
	}
	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--ink);
		opacity: 0.7;
	}
</style>
