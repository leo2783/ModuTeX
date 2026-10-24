<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { text, type Language } from '../../i18n/text.ts';
	import { parseCompileIdentity } from '@modutex/frontend-contracts';
	import type { SourceDocument } from '../document-core/core.ts';
	import type {
		DraftCompileRequest,
		DraftDocumentResult,
		DraftError,
		DraftParagraphRequest,
		DraftSavePdfRequest
	} from './types.ts';
	import {
		compileDraft,
		normalizeDraftError,
		saveDraftPdf,
		stopDraft,
		takeoverDraft,
		typesetParagraph
	} from './transport.ts';
	import { findEnclosingParagraph } from './utf8.ts';
	import DraftRecordsView from './DraftRecordsView.svelte';

	let {
		document,
		workspaceId,
		entryPath,
		revision,
		dirty = false,
		active = true,
		locale = 'zh-Hant',
		selection = null,
		getSelection,
		onSave,
		onResult,
		onError
	}: {
		document: SourceDocument | null;
		workspaceId: string | null;
		entryPath: string | null;
		revision: string | null;
		dirty?: boolean;
		active?: boolean;
		locale?: Language;
		selection?: { from: number; to: number } | null;
		getSelection?: () => { readonly from: number; readonly to: number } | null;
		onSave?: () => Promise<boolean>;
		onResult?: (result: DraftDocumentResult, pdfBytes?: Uint8Array) => void;
		onError?: (error: DraftError | Error) => void;
	} = $props();

	const t = (zh: string, en: string) => text(locale, zh, en);

	let busy = $state(false);
	let stopping = $state(false);
	let result = $state<DraftDocumentResult | null>(null);
	let pdfBytes = $state<Uint8Array | undefined>(undefined);
	let error = $state<string | null>(null);
	let currentMode = $state<'full' | 'paragraph'>('full');
	let resultIsStale = $derived.by(() => {
		const currentResult = result;
		if (!currentResult) return false;
		return (
			dirty ||
			!document ||
			!workspaceId ||
			!entryPath ||
			!revision ||
			currentResult.identity.workspaceId !== workspaceId ||
			currentResult.identity.entryPath !== entryPath ||
			currentResult.identity.documentId !== document.documentId ||
			currentResult.identity.documentVersion !== document.version ||
			currentResult.identity.savedRevision !== revision
		);
	});

	let operationTicket = 0;
	let prevWorkspaceId: string | null = null;
	let prevDocumentId: string | null = null;
	let prevActive = untrack(() => active);

	function teardownWarmDaemon(targetWorkspaceId: string | null) {
		operationTicket++;
		if (targetWorkspaceId) {
			void stopDraft(targetWorkspaceId).catch(() => {});
		}
	}

	$effect(() => {
		const currentActive = active;
		const currentWs = workspaceId;
		const currentDocId = document?.documentId ?? null;

		if (!currentActive) {
			if (prevActive) {
				const wsToStop = prevWorkspaceId ?? currentWs;
				teardownWarmDaemon(wsToStop);
				busy = false;
				stopping = false;
			}
		} else {
			if (prevWorkspaceId !== null && prevWorkspaceId !== currentWs) {
				teardownWarmDaemon(prevWorkspaceId);
				result = null;
				pdfBytes = undefined;
				busy = false;
				stopping = false;
			} else if (prevDocumentId !== null && prevDocumentId !== currentDocId) {
				teardownWarmDaemon(currentWs);
				result = null;
				pdfBytes = undefined;
				busy = false;
				stopping = false;
			}
		}

		prevActive = currentActive;
		prevWorkspaceId = currentWs;
		prevDocumentId = currentDocId;
	});

	onDestroy(() => {
		const wsToStop = prevWorkspaceId ?? workspaceId;
		teardownWarmDaemon(wsToStop);
		busy = false;
		stopping = false;
	});

	async function handleCompile() {
		if (busy || stopping || !active || !document || !workspaceId || !entryPath) return;

		if (dirty && onSave) {
			const saved = await onSave();
			if (!saved) {
				error = t('請先儲存變更', 'Please save changes first');
				return;
			}
		}

		if (!revision) {
			error = t('文件尚未儲存至工作區', 'Document is not saved in workspace');
			return;
		}

		const requestDoc = document;
		const requestVersion = document.version;
		const requestRevision = revision;
		const requestWorkspaceId = workspaceId;
		const requestEntryPath = entryPath;

		const request: DraftCompileRequest = {
			workspaceId: requestWorkspaceId,
			entryPath: requestEntryPath,
			documentId: requestDoc.documentId,
			documentVersion: requestVersion,
			savedRevision: requestRevision
		};

		const ticket = ++operationTicket;
		busy = true;
		error = null;
		currentMode = 'full';

		try {
			const res = await compileDraft(request);

			if (ticket !== operationTicket) return;

			parseCompileIdentity(res.identity, request);

			if (
				!active ||
				workspaceId !== requestWorkspaceId ||
				entryPath !== requestEntryPath ||
				!document ||
				document.documentId !== requestDoc.documentId ||
				document.version !== requestVersion ||
				revision !== requestRevision ||
			dirty
			) {
				return;
			}

			if (res.status === 'success') {
				result = res;
				pdfBytes = res.pdfBytes;
				onResult?.(res, res.pdfBytes);
			} else {
				const failureMessage =
					res.failure ||
					res.diagnostics[0]?.message ||
					(res.status === 'cancelled'
						? t('排版已取消', 'Draft compilation cancelled')
						: res.status === 'preempted'
							? t('排版已被搶佔', 'Draft compilation preempted')
							: t('Draft 排版失敗', 'Draft compilation failed'));
				const normalized = normalizeDraftError(new Error(failureMessage));
				error = normalized.message || failureMessage;
				onError?.(normalized);
			}
		} catch (err) {
			if (ticket !== operationTicket) return;
			const normalized = normalizeDraftError(err);
			error = normalized.message;
			onError?.(normalized);
		} finally {
			if (ticket === operationTicket) {
				busy = false;
			}
		}
	}

	async function handleParagraph() {
		if (busy || stopping || !active || !document || !workspaceId || !entryPath) return;

		if (dirty && onSave) {
			const saved = await onSave();
			if (!saved) {
				error = t('請先儲存變更', 'Please save changes first');
				return;
			}
		}

		if (!revision) {
			error = t('文件尚未儲存至工作區', 'Document is not saved in workspace');
			return;
		}

		let paragraphSelection: { readonly from: number; readonly to: number } | null;
		try {
			paragraphSelection = getSelection ? getSelection() : selection;
		} catch {
			paragraphSelection = null;
		}
		if (!paragraphSelection) {
			error = t(
				'無法讀取目前編輯器位置。請聚焦 TeX 原始碼編輯器後重試。',
				'Could not read the current editor position. Focus the TeX source editor and try again.'
			);
			return;
		}

		const textContent = document.read();
		let paragraph;
		try {
			paragraph = findEnclosingParagraph(textContent, paragraphSelection);
		} catch {
			error = t('段落過大（超過 1 MiB）', 'Paragraph too large (> 1 MiB)');
			return;
		}

		if (!paragraph) {
			error = t('未找到可排版的段落', 'No paragraph found to typeset');
			return;
		}

		const requestDoc = document;
		const requestVersion = document.version;
		const requestRevision = revision;
		const requestWorkspaceId = workspaceId;
		const requestEntryPath = entryPath;

		const request: DraftParagraphRequest = {
			workspaceId: requestWorkspaceId,
			entryPath: requestEntryPath,
			documentId: requestDoc.documentId,
			documentVersion: requestVersion,
			savedRevision: requestRevision,
			range: paragraph.range,
			source: paragraph.source
		};

		const ticket = ++operationTicket;
		busy = true;
		error = null;
		currentMode = 'paragraph';

		try {
			const res = await typesetParagraph(request);

			if (ticket !== operationTicket) return;

			parseCompileIdentity(res.identity, request);

			if (
				!active ||
				workspaceId !== requestWorkspaceId ||
				entryPath !== requestEntryPath ||
				!document ||
				document.documentId !== requestDoc.documentId ||
				document.version !== requestVersion ||
				revision !== requestRevision ||
			dirty
			) {
				return;
			}

			if (res.status === 'success') {
				result = res;
				pdfBytes = res.pdfBytes;
				onResult?.(res, res.pdfBytes);
			} else {
				const failureMessage =
					res.failure ||
					res.diagnostics[0]?.message ||
					(res.status === 'cancelled'
						? t('排版已取消', 'Draft compilation cancelled')
						: res.status === 'preempted'
							? t('排版已被搶佔', 'Draft compilation preempted')
							: t('段落排版失敗', 'Paragraph typesetting failed'));
				const normalized = normalizeDraftError(new Error(failureMessage));
				error = normalized.message || failureMessage;
				onError?.(normalized);
			}
		} catch (err) {
			if (ticket !== operationTicket) return;
			const normalized = normalizeDraftError(err);
			error = normalized.message;
			onError?.(normalized);
		} finally {
			if (ticket === operationTicket) {
				busy = false;
			}
		}
	}

	async function handleStop() {
		if (!workspaceId || stopping) return;
		const ticket = ++operationTicket;
		stopping = true;
		busy = true;
		try {
			await stopDraft(workspaceId);
		} catch (err) {
			if (ticket !== operationTicket) return;
			const normalized = normalizeDraftError(err);
			error = normalized.message;
			onError?.(normalized);
		} finally {
			if (ticket === operationTicket) {
				stopping = false;
				busy = false;
			}
		}
	}

	async function handleTakeover() {
		if (!workspaceId || busy || stopping) return;
		const ticket = ++operationTicket;
		busy = true;
		try {
			await takeoverDraft(workspaceId);
		} catch (err) {
			if (ticket !== operationTicket) return;
			const normalized = normalizeDraftError(err);
			error = normalized.message;
			onError?.(normalized);
		} finally {
			if (ticket === operationTicket) {
				busy = false;
			}
		}
	}

	async function handleSavePdf() {
		if (!workspaceId || !result || !entryPath || busy || stopping) return;
		const pdfPath = entryPath.replace(/\.tex$/i, '') + '-draft.pdf';
		const request: DraftSavePdfRequest = {
			workspaceId,
			runId: result.identity.runId,
			path: pdfPath,
			expectedRevision: null
		};
		const ticket = ++operationTicket;
		busy = true;
		try {
			await saveDraftPdf(request);
		} catch (err) {
			if (ticket !== operationTicket) return;
			const normalized = normalizeDraftError(err);
			error = normalized.message;
			onError?.(normalized);
		} finally {
			if (ticket === operationTicket) {
				busy = false;
			}
		}
	}
</script>

<div class="draft-panel" role="region" aria-label={t('Draft 排版工作區', 'Draft typesetting workspace')}>
	<div class="draft-toolbar" role="toolbar" aria-label={t('Draft 操作', 'Draft actions')}>
		<div class="toolbar-group">
			<button
				class="text-button action-btn"
				onclick={handleCompile}
				disabled={busy || !document || !workspaceId || !entryPath}
			>
				{t('全篇 Draft 排版', 'Full Draft')}
			</button>
			<button
				class="text-button action-btn"
				onclick={handleParagraph}
				disabled={busy || !document || !workspaceId || !entryPath}
			>
				{t('段落排版', 'Typeset Paragraph')}
			</button>
		</div>

		<div class="toolbar-group">
			<button
				class="text-button"
				onclick={handleStop}
				disabled={stopping || !workspaceId}
				title={t('停止背景排版程序', 'Stop background daemon')}
			>
				{t('停止程序', 'Stop Daemon')}
			</button>
			<button
				class="text-button"
				onclick={handleTakeover}
				disabled={busy || !workspaceId}
				title={t('搶佔背景排版權限', 'Takeover daemon control')}
			>
				{t('搶佔控制', 'Takeover')}
			</button>
			{#if result && result.status === 'success'}
				<button
					class="text-button save-pdf-btn"
					onclick={handleSavePdf}
					disabled={busy || !workspaceId}
					title={t('儲存 Draft PDF 至工作區', 'Save Draft PDF to workspace')}
				>
					{t('另存 PDF', 'Save PDF')}
				</button>
			{/if}
		</div>

		{#if busy}
			<div class="draft-busy-indicator" role="status">
				<span>{currentMode === 'paragraph' ? t('段落排版中…', 'Typesetting paragraph…') : t('全篇排版中…', 'Compiling draft…')}</span>
			</div>
		{/if}
		{#if resultIsStale}
			<div class="draft-stale-indicator" role="status">
				{t('目前文件已變更；以下保留的是先前 Draft 排版結果。', 'The current document has changed; showing the previous Draft result.')}
			</div>
		{/if}
	</div>

	{#if error}
		<div class="draft-error-strip" role="alert">
			<span>{error}</span>
			<button class="text-button" onclick={() => (error = null)}>{t('關閉', 'Close')}</button>
		</div>
	{/if}

	<div class="draft-body">
		{#if result}
			<DraftRecordsView
				{result}
				{pdfBytes}
				{active}
				{locale}
			/>
		{:else}
			<div class="draft-placeholder">
				<p>{t('尚未執行 Draft 排版。點選「全篇 Draft 排版」或「段落排版」開始。', 'No draft typesetting has been run yet. Click "Full Draft" or "Typeset Paragraph" to begin.')}</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.draft-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--canvas, #fdfdfd);
		overflow: hidden;
	}
	.draft-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 12px;
		background: var(--surface, #ffffff);
		border-bottom: 1px solid var(--line, #e2e8f0);
		font-size: 13px;
		gap: 8px;
		flex-wrap: wrap;
	}
	.toolbar-group {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.action-btn {
		font-weight: 500;
	}
	.save-pdf-btn {
		color: var(--primary, #0284c7);
	}
	.draft-busy-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted, #64748b);
	}
	.draft-stale-indicator {
		flex: 1 1 100%;
		color: var(--muted, #64748b);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.draft-error-strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 12px;
		background: #fef2f2;
		color: #991b1b;
		border-bottom: 1px solid #fee2e2;
		font-size: 13px;
	}
	.draft-body {
		flex: 1;
		position: relative;
		overflow: hidden;
	}
	.draft-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--muted, #64748b);
		padding: 24px;
		text-align: center;
		font-size: 14px;
	}
</style>
