<script lang="ts">
	import type { Snippet } from 'svelte';
	import { isTauri } from '@tauri-apps/api/core';
import type { CompileIdentity, Diagnostic, FileEntry, WorkspaceInfo } from '@modutex/frontend-contracts';
	import type { SourceDocument, SourceProjection, SourceSpan } from '../features/document-core/core.ts';
	import { projectionIsCurrent } from '../features/document-core/projection-state.ts';
	import type { OutlineEntry } from '../features/source-editor/outline.ts';
	import type { BoundSynctexIndex } from '../features/compile/synctex.ts';
	import { previewStatus } from '../features/compile/preview-status.ts';
	import {
		canForwardSynctexState,
		captureDraftSelectionSnapshot,
		type DraftSelectionSnapshot,
		type SourceViewHandle
	} from '../features/compile/workbench-runtime.ts';
	import type { WorkspaceFilesPort } from '../features/files/workspace-files.ts';
	import { text, type Language } from '../i18n/text.ts';
	import WorkbenchLayout from './WorkbenchLayout.svelte';
	import DragSeparator from './splitter/DragSeparator.svelte';
	import { clampSplitterValue, splitterBounds } from './splitter/resize-logic.ts';
	import DraftPanel from '../features/draft/DraftPanel.svelte';
import WorkbenchDock from './WorkbenchDock.svelte';

type WorkbenchDockTab = 'problems' | 'output' | 'terminal' | null;

	let {
		locale,
		route,
		workbenchPane = $bindable<'document' | 'pdf'>('document'),
		workbenchSplitRatio = $bindable(0.5),
		draftPanelOpen = $bindable(false),
		workspaceFilesButton = $bindable<HTMLButtonElement | null>(null),
		pdfLoadKey = $bindable(0),
		pageCount = $bindable(0),
		pdfRendered = $bindable(false),
		pdfDisplayFailed = $bindable(false),
		activeDockTab = $bindable<WorkbenchDockTab>(null),
		diagnostics = [],
		compileLog = '',
		canNavigateDiagnostic = () => false,
		navigateToDiagnostic = () => {},
		desktop,
		workspace,
		workspaceFiles,
		workspaceFilesAvailability,
		entries,
		source,
		sourceName,
		revision,
		dirty,
		opening,
		saving,
		compiling,
		confirming,
		missingOnDisk,
		aborted,
		projection,
		outline,
		outlineOwner,
		outlineFailed,
		pdfBytes,
		pdfName,
		pdfIdentity,
		pdfReveal,
		synctexIndex,
		sourceViewInstance,
		draftSelectionSnapshot = $bindable<DraftSelectionSnapshot | null>(null),
		draftSelectionWarning = $bindable<[string, string] | null>(null),
		onOpenWorkspaceFiles,
		onNewWorkspaceFile,
		onChooseSource,
		onReadDesktopFile,
		onCompileWorkspaceFile,
		onNavigateHeading,
		onForwardSynctex,
		onPdfPoint,
		onPdfError,
		onOpenPdfClick,
		onSaveSourceForDraft,
		sourceEditor
	}: {
		locale: Language;
		route: string;
		workbenchPane: 'document' | 'pdf';
		workbenchSplitRatio: number;
		draftPanelOpen: boolean;
		workspaceFilesButton: HTMLButtonElement | null;
		pdfLoadKey: number;
		pageCount: number;
		pdfRendered: boolean;
		pdfDisplayFailed: boolean;
		activeDockTab: WorkbenchDockTab;
		diagnostics: readonly Diagnostic[];
		compileLog: string;
		canNavigateDiagnostic: (diagnostic: Diagnostic) => boolean;
		navigateToDiagnostic: (diagnostic: Diagnostic) => void;
		desktop: boolean;
		workspace: WorkspaceInfo | null;
		workspaceFiles: WorkspaceFilesPort | null;
		workspaceFilesAvailability: 'checking' | 'available' | 'unavailable';
		entries: readonly FileEntry[];
		source: SourceDocument | null;
		sourceName: string;
		revision: string | null;
		dirty: boolean;
		opening: boolean;
		saving: boolean;
		compiling: boolean;
		confirming: boolean;
		missingOnDisk: boolean;
		aborted: boolean;
		projection: SourceProjection | null;
		outline: readonly OutlineEntry[];
		outlineOwner: string;
		outlineFailed: boolean;
		pdfBytes: Uint8Array | null;
		pdfName: string;
		pdfIdentity: CompileIdentity | null;
		pdfReveal: { page: number; x: number; y: number; requestId: number } | undefined;
		synctexIndex: BoundSynctexIndex | null;
		sourceViewInstance: SourceViewHandle | null;
		draftSelectionSnapshot: DraftSelectionSnapshot | null;
		draftSelectionWarning: [string, string] | null;
		onOpenWorkspaceFiles: () => void;
		onNewWorkspaceFile: (parentPath?: string) => void;
		onChooseSource: (kind?: 'file' | 'folder') => void;
		onReadDesktopFile: (path: string, owner: WorkspaceInfo) => Promise<void>;
		onCompileWorkspaceFile: (path: string, owner: WorkspaceInfo) => Promise<void>;
		onNavigateHeading: (span: SourceSpan) => void;
		onForwardSynctex: () => void;
		onPdfPoint: (point: { page: number; x: number; y: number }) => void;
		onPdfError: (code: string) => void;
		onOpenPdfClick: () => void;
		onSaveSourceForDraft: () => Promise<boolean>;
		sourceEditor: Snippet<[{ active: boolean }]>;
	} = $props();

	const t = (zh: string, en: string) => text(locale, zh, en);

	let sidebarPrimaryElement: HTMLElement | null = $state(null);
	let explorerHeight = $state(280);

	function getExplorerBounds() {
		if (!sidebarPrimaryElement) return { min: 120, max: 400 };
		const rect = sidebarPrimaryElement.getBoundingClientRect();
		if (rect.height <= 0) return { min: 120, max: 400 };
		return splitterBounds(rect.height, 120, 96, 8);
	}

	$effect(() => {
		const container = sidebarPrimaryElement;
		if (!container) return;
		const resize = () => {
			if (container.clientHeight <= 0) return;
			explorerHeight = clampSplitterValue(explorerHeight, getExplorerBounds());
		};
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
		observer?.observe(container);
		window.addEventListener('resize', resize);
		resize();
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', resize);
		};
	});

	let draftPanelSelection = $derived.by(() => {
		const selected = draftSelectionSnapshot;
		if (!selected || !source || !workspace ||
			selected.workspaceId !== workspace.id ||
			selected.entryPath !== sourceName ||
			selected.documentId !== source.documentId ||
			selected.documentVersion !== source.version) return null;
		return { from: selected.from, to: selected.to };
	});

	function captureDraftSelection(): DraftSelectionSnapshot | null {
		return captureDraftSelectionSnapshot(source, workspace, sourceName, sourceViewInstance);
	}

	function canOpenDraftPanel(): boolean {
		return isTauri() && desktop && !!source && !!workspace && revision !== null &&
			sourceName.toLowerCase().endsWith('.tex') &&
			!opening && !saving && !confirming && !compiling && !missingOnDisk &&
			!aborted;
	}

	function refreshDraftSelection() {
		const selected = captureDraftSelection();
		draftSelectionSnapshot = selected;
		draftSelectionWarning = selected
			? null
			: ['無法讀取目前編輯器位置。請聚焦 TeX 原始碼編輯器後重試。', 'Could not read the current editor position. Focus the TeX source editor and try again.'];
	}

	function openDraftPanel() {
		if (!canOpenDraftPanel()) return;
		refreshDraftSelection();
		draftPanelOpen = true;
		workbenchPane = 'pdf';
	}

	function canForwardSynctex(): boolean {
		return canForwardSynctexState(
			source,
			pdfBytes,
			synctexIndex,
			pdfIdentity,
			workspace,
			dirty,
			sourceName,
			revision
		);
	}
</script>

<WorkbenchLayout
	{locale}
	bind:activePane={workbenchPane}
	bind:splitRatio={workbenchSplitRatio}
>
	{#snippet sidebarContent()}
		<aside class="files" aria-label={t('文件與大綱', 'Files and outline')}>
			<div class="sidebar-primary" bind:this={sidebarPrimaryElement} style:grid-template-rows={`minmax(120px, ${explorerHeight}px) 8px minmax(96px, 1fr)`}>
				<section class="explorer-section" aria-label={t('檔案總管', 'Explorer')}>
					<div class="sidebar-heading">
						<span>{t('檔案總管', 'Explorer')}</span>
						<div class="sidebar-heading-actions">
							{#if workspace && workspaceFiles && workspaceFilesAvailability === 'available'}
								<button class="text-button" bind:this={workspaceFilesButton} aria-label={t('工作區檔案操作', 'Workspace file operations')} title={t('工作區檔案操作', 'Workspace file operations')} onclick={onOpenWorkspaceFiles} disabled={opening || saving || compiling}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
								<button class="text-button" aria-label={t('新增 TeX 檔案', 'New TeX file')} title={t('新增 TeX 檔案', 'New TeX file')} onclick={() => onNewWorkspaceFile()} disabled={opening || saving || compiling}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M12 12v6m-3-3h6" /></svg></button>
							{/if}
							<button class="text-button" aria-label={t('開啟資料夾', 'Open folder')} title={t('開啟資料夾', 'Open folder')} onclick={() => onChooseSource('folder')} disabled={!desktop || opening || saving}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3z" /></svg></button>
						</div>
					</div>
					<div class="sidebar-scroll">
						{#await import('./FileTree.svelte') then { default: FileTree }}
						{#if workspace}
							{@const sidebarOwner = workspace}
							<div class="workspace-name" title={sidebarOwner.label}>{sidebarOwner.label}</div>
							<FileTree {entries} {locale} selected={sourceName} disabled={opening || saving || compiling} onOpen={async (path) => { await onReadDesktopFile(path, sidebarOwner); }} onCompile={async (path) => { await onCompileWorkspaceFile(path, sidebarOwner); }} onNewWorkspaceFile={onNewWorkspaceFile} />
						{:else if source}
							<FileTree entries={[{ path: sourceName, kind: 'file' }]} selected={sourceName} disabled={true} onOpen={() => {}} />
						{:else}<p class="sidebar-empty">{t('尚未開啟文件', 'No document open')}</p>{/if}
						{/await}
					</div>
				</section>
				<DragSeparator
					class="sidebar-outline-separator"
					value={explorerHeight}
					min={getExplorerBounds().min}
					max={getExplorerBounds().max}
					axis="horizontal"
					controls="workbench-outline-section"
					label={t('調整檔案與大綱高度', 'Resize explorer and outline height')}
					container={sidebarPrimaryElement}
					onChange={(value) => (explorerHeight = value)}
				/>
				<section id="workbench-outline-section" class="outline-section" aria-label={t('大綱', 'Outline')}>
					<div class="sidebar-heading">{t('大綱', 'Outline')}</div>
					<div class="sidebar-scroll">
					{#if source && outlineOwner === source.documentId && outline.length}
						{#each outline as heading (heading.span.from)}
							<button class="outline-row" style:padding-left={`${16 + heading.level * 12}px`}
								disabled={saving || opening || !projection || !projectionIsCurrent(source, projection)}
								onclick={() => onNavigateHeading(heading.span)}>{heading.label}</button>
						{/each}
					{:else}<p class="sidebar-empty">{!source ? t('開啟文件後顯示章節', 'Open a document to view sections') : outlineFailed ? t('大綱暫停更新', 'Outline updates paused') : !projection ? t('正在更新大綱…', 'Updating outline…') : t('此文件沒有章節', 'This document has no sections')}</p>{/if}
					</div>
				</section>
			</div>
		</aside>
	{/snippet}
	{#snippet editor({ active, hidden, inert })}
		<section class="editor-pane" aria-label={t('文件編輯', 'Document editor')} {hidden} {inert}>
			<div class="pane-title">
				<span>{sourceName || t('原始碼', 'Source')}</span>
				<div>
					{#if pdfBytes}
						<button
							class="text-button"
							onclick={onForwardSynctex}
							disabled={opening || saving || compiling || !canForwardSynctex()}
						>
							{t('定位至 PDF', 'Locate in PDF')}
						</button>
					{/if}
					{#if isTauri() && source && sourceName.toLowerCase().endsWith('.tex')}
						<button
							class="text-button"
							type="button"
							aria-label={t('開啟 Draft 排版工作區', 'Open Draft typesetting workspace')}
							aria-controls="draft-typesetting-panel"
							aria-pressed={draftPanelOpen}
							onclick={openDraftPanel}
							disabled={!canOpenDraftPanel()}
						>
							{t('Draft 排版', 'Draft')}
						</button>
					{/if}
					<span class="mode-label">LaTeX</span>
				</div>
			</div>
			<div class="editor-content">
				{#if source}
					{@render sourceEditor({ active })}
				{:else}
					<div class="empty-state">
						<h1>{t('開啟 TeX 文件', 'Open a TeX document')}</h1>
						<p>{t('開啟或新增文件。', 'Open or create a document.')}</p>
						<button onclick={() => onChooseSource()} disabled={opening}>{t('選擇文件', 'Choose document')}</button>
					</div>
				{/if}
			</div>
		</section>
	{/snippet}
	{#snippet preview({ active, hidden, inert })}
		<section class="preview-pane" aria-label={t('PDF 預覽', 'PDF preview')} {hidden} {inert}>
			<div class="pane-title">
				<span>{draftPanelOpen ? t('Draft 排版', 'Draft typesetting') : pdfName || 'PDF'}</span>
				{#if draftPanelOpen}
					<button
						class="text-button"
						type="button"
						aria-label={t('使用目前原始碼編輯器位置排版段落', 'Use the current source editor position for paragraph typesetting')}
						onclick={refreshDraftSelection}
						disabled={!sourceViewInstance || opening || saving}
					>
						{t('更新段落位置', 'Use current selection')}
					</button>
					{#if draftSelectionWarning}
						<span role="status" aria-live="polite">{t(draftSelectionWarning[0], draftSelectionWarning[1])}</span>
					{/if}
					<button class="text-button" type="button" onclick={() => (draftPanelOpen = false)}>
						{t('返回 PDF 預覽', 'Back to PDF preview')}
					</button>
				{/if}
				<button class="text-button" onclick={onOpenPdfClick}>{t('開啟 PDF', 'Open PDF')}</button>
			</div>
			<div class="editor-bar">
				<span>{!pdfBytes ? t('預覽', 'Preview') : previewStatus(source, sourceName, pdfIdentity) === 'stale' ? t('文件已變更，顯示上次編譯 PDF', 'Document changed; showing the previous PDF') : previewStatus(source, sourceName, pdfIdentity) === 'current' ? t('目前文件的編譯 PDF', 'PDF compiled from this document') : t('外部 PDF', 'External PDF')}</span>{#if pageCount}<span class="muted">{t(`共 ${pageCount} 頁`, `${pageCount} pages`)}</span>{/if}
			</div>
			<div class="preview-content">
				{#if isTauri() && source && sourceName.toLowerCase().endsWith('.tex')}
					<div
						id="draft-typesetting-panel"
						class="draft-preview"
						hidden={!draftPanelOpen}
						inert={!draftPanelOpen}
						style={`display: ${draftPanelOpen ? 'flex' : 'none'}; flex-direction: column; height: 100%; min-height: 0;`}
					>
						<DraftPanel
							document={source}
							workspaceId={workspace?.id ?? null}
							entryPath={sourceName || null}
							{revision}
							{dirty}
							active={route === 'workbench' && active && draftPanelOpen}
							{locale}
							selection={draftPanelSelection}
							getSelection={captureDraftSelection}
							onSave={onSaveSourceForDraft}
						/>
					</div>
				{/if}
				<div
					class="standard-preview"
					hidden={draftPanelOpen}
					inert={draftPanelOpen}
					style={`display: ${draftPanelOpen ? 'none' : 'flex'}; flex-direction: column; height: 100%; min-height: 0;`}
				>
					{#if pdfBytes}
						{#key pdfLoadKey}{#await import('../features/pdf/PdfView.svelte')}
							<div class="empty-state" role="status"><p>{t('正在開啟 PDF 預覽…', 'Loading PDF preview…')}</p></div>
						{:then { default: PdfView }}
							<PdfView
								bytes={pdfBytes}
								active={route === 'workbench' && active}
								{locale}
								reveal={pdfReveal}
								onPoint={onPdfPoint}
								onPageCount={(count) => (pageCount = count)}
								onRendered={() => { pdfRendered = true; pdfDisplayFailed = false; }}
								onError={(code) => { pdfDisplayFailed = true; onPdfError(code); }}
							/>
						{:catch}
							<div class="empty-state" role="alert"><p>{t('無法載入 PDF 預覽。', 'The PDF preview could not be loaded.')}</p><button onclick={() => pdfLoadKey++}>{t('重試', 'Retry')}</button></div>
						{/await}{/key}
					{:else}<div class="empty-state">
							<h2>{t('PDF 預覽', 'PDF preview')}</h2>
							<p>{t('開啟 PDF，檢視文件排版。', 'Open a PDF to view the document layout.')}</p>
						</div>{/if}
				</div>
			</div>
		</section>
	{/snippet}
</WorkbenchLayout>
<WorkbenchDock
	{locale}
	bind:activeTab={activeDockTab}
	workspaceId={desktop ? workspace?.id ?? null : null}
	{diagnostics}
	{compileLog}
	{canNavigateDiagnostic}
	{navigateToDiagnostic}
/>
