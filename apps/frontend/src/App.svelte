<script lang="ts">
	import { SourceDocument, projectionIsCurrent, type SourceProjection, type SourceSpan } from './features/document-core/core.ts';
	import type { OutlineEntry } from './features/source-editor/outline.ts';
	import { onDestroy, onMount, tick } from 'svelte';
	import CloseDialog from './components/CloseDialog.svelte';
	import { text } from './i18n/text.ts';
	import { documentCommand } from './features/shortcuts/keyboard.ts';
	import { helpTopic, type HelpTopic } from './features/help/route.ts';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { DEFAULT_PREFERENCES, announcePreferenceChange, legacyPreferenceRecord, readPreferences, savePreference, restorePreferences, subscribePreferences, decodePreference, effectiveAppearance, type Preferences } from './state/preferences.ts';
	import { createNativePreferencesAdapter, type NativePreferencesImport, type NativePreferencesSnapshot } from './state/native-preferences.ts';
	import type { WorkspaceInfo, FileEntry, FileEvent, CompileHandle, CompileIdentity, Diagnostic } from '@modutex/frontend-contracts';
	import type { DiagnosticNavigationRequest } from './features/source-editor/diagnostics.ts';
	import type { FileDesktopPort } from './features/files/desktop.ts';
	import {
		isWorkspaceFilesCapabilityUnavailable,
		tauriWorkspaceFiles,
		workspaceFilesScopeMatches
	} from './features/files/workspace-files.ts';
	import type { WorkspaceFilesPort, WorkspaceFilesTask } from './features/files/workspace-files.ts';
	import TerminalPanel from './features/terminal/TerminalPanel.svelte';
	import GitPanel from './features/git/GitPanel.svelte';
	import type { RecentDocument } from './features/files/recent.ts';
	import { readSource, readSourceBytes } from './features/files/read.ts';
	import type { TemplateId } from './features/files/templates.ts';
	import { invoke, isTauri } from '@tauri-apps/api/core';
	import type { ReadReceipt } from '@modutex/frontend-contracts';
	import { BoundSynctexIndex, sameCompileIdentity, type SynctexPdfLocation, type SynctexSourceLocation } from './features/compile/synctex.ts';
	import DraftPanel from './features/draft/DraftPanel.svelte';
	import UpdateNotice from './features/updates/UpdateNotice.svelte';
	let workbenchPane = $state<'document' | 'pdf'>('document');
	let workbenchSplitRatio = $state(0.5);
	let workbenchVisited = $state(false);
	let draftPanelOpen = $state(false);
	let workbenchLoadKey = $state(0);
	let sourceViewMode = $state<'source' | 'visual'>('visual');
	let source = $state.raw<SourceDocument | null>(null);
	let projection = $state.raw<SourceProjection | null>(null);
	let sourceName = $state('');
	let dirty = $state(false);
	let revision = $state<string | null>(null);
	let saving = $state(false);
	let confirming = $state(false);
	let savedVersion = $state<number | null>(null);
	let hasDiskCheckpoint = $state(true);
	let compiling = $state(false);
	let compileHandle = $state.raw<CompileHandle | null>(null);
	let compileLog = $state('');
	let showCompileDetails = $state(false);
	let compileTicket = $state(0);
	let compileCancellationRequestedFor = $state<number | null>(null);
	let compileCancellationFailedFor: number | null = null;
	let diagnostics = $state.raw<readonly Diagnostic[]>([]);
	let diagnosticIdentity = $state.raw<CompileIdentity | null>(null);
	let pdfIdentity = $state.raw<CompileIdentity | null>(null);
	let pdfBytes = $state.raw<Uint8Array | null>(null);
	let pdfRendered = $state(false), pdfDisplayFailed = $state(false);
	$effect(() => { void pdfBytes; pdfRendered = false; pdfDisplayFailed = false; });
	let pdfName = $state('');
	let pdfLoadKey = $state(0);
	let pageCount = $state(0);
	let pdfReveal = $state<{ page: number; x: number; y: number; requestId: number } | undefined>(undefined);
	let pdfRevealSequence = 0;
	let synctexIndex = $state.raw<BoundSynctexIndex | null>(null);
	$effect(() => {
		const index = synctexIndex;
		if (!index) return;
		if (dirty || !source || !workspace ||
			workspace.id !== index.identity.workspaceId ||
			!pdfIdentity || !sameCompileIdentity(index.identity, pdfIdentity) ||
			sourceName.toLowerCase() === index.identity.entryPath.toLowerCase() &&
				(source.documentId !== index.identity.documentId ||
					source.version !== index.identity.documentVersion ||
					revision !== index.identity.savedRevision)) {
			invalidateSynctexIndex();
			return;
		}
		if (route === 'workbench') {
			try {
				index.resume();
			} catch {
				invalidateSynctexIndex();
			}
		} else {
			index.suspend();
		}
	});
	let opening = $state(false);
	let editorLoadKey = $state(0);
	let sidebar = $state<'files' | 'outline'>('files');
	let outline = $state.raw<readonly OutlineEntry[]>([]);
	let outlineOwner = $state('');
	let outlineFailed = $state(false);
	let navigation = $state.raw<{ readonly span: SourceSpan; readonly sequence: number; readonly sourceOnly?: boolean } | null>(null);
	let diagnosticNavigation = $state.raw<DiagnosticNavigationRequest | null>(null);
	let diagnosticNavigationSequence = 0;
	let navigationSequence = 0;
	let route = $state<'home' | 'workbench' | 'settings' | 'compile-settings' | 'release-notes' | 'help'>('home');
	$effect(() => { if (route === 'workbench') workbenchVisited = true; });
	let homeLoadKey = $state(0);
	let recent = $state.raw<readonly RecentDocument[]>([]);
	let recentTicket = 0;
	let selectedHelp = $state<HelpTopic>('getting-started');
	let helpLoadKey = $state(0);
	let settingsLoadKey = $state(0);
	let releaseLoadKey = $state(0);
	let showLimitations = $state(false);
	let preferences = $state.raw<Preferences>(DEFAULT_PREFERENCES);
	const nativePreferences = createNativePreferencesAdapter();
	let preferencesRevision = 0;
	let nativePreferencesReady = !isTauri();
	let nativePreferencesOperation = 0;
	let nativePreferencesResetPending = false;
	let nativePreferencesReloadPending = false;
	const pendingNativePreferences = new Map<keyof Preferences, unknown>();
	const t = (zh: string, en: string) => text(preferences.language, zh, en);
	let showCloseDialog = $state(false);
	let closeConfirmed = false;
	let closeConfirmedSource: SourceDocument | null = null;
	let closeConfirmedVersion: number | null = null;
	let openingWindow = $state(false);
	type NoticeDescriptor = [string, string] | { readonly raw: string } | null;
	type WorkspaceWatchIssue = 'offline' | 'reconcile';
	interface QueuedWorkspaceEvent {
		readonly event: FileEvent;
	}
	interface DiagnosticContext {
		readonly identity: CompileIdentity;
		readonly owner: WorkspaceInfo;
		readonly source: SourceDocument;
		readonly sourceName: string;
		readonly revision: string;
	}
	interface SourceViewHandle {
		getEditorSelection(documentId: string, documentVersion: number): {
			readonly documentId?: string;
			readonly documentVersion?: number;
			readonly cursor: { readonly line: number; readonly column: number };
			readonly selection?: {
				readonly start: { readonly line: number; readonly column: number };
				readonly end: { readonly line: number; readonly column: number };
			} | null;
		} | null;
	}
	interface DraftSelectionSnapshot {
		readonly workspaceId: string;
		readonly entryPath: string;
		readonly documentId: string;
		readonly documentVersion: number;
		readonly from: number;
		readonly to: number;
	}
	type LineDiagnostic = Diagnostic & { readonly path: string; readonly line: number };
	interface WorkspaceWatch {
		readonly owner: WorkspaceInfo;
		readonly generation: number;
		readonly pending: Map<string, QueuedWorkspaceEvent>;
		active: boolean;
		terminal: boolean;
		overflowed: boolean;
		recoveryEvents: boolean;
		processing: boolean;
		resync: boolean;
		recovering: boolean;
		unsubscribe: (() => void) | null;
	}
	const MAX_RENDERER_PENDING_WATCH_EVENTS = 128;
	const SYNCTEX_INPUT_EXTENSIONS = new Set([
		'tex', 'ltx', 'sty', 'cls', 'clo', 'def', 'dtx', 'ins', 'inc', 'bib', 'bbl', 'bst',
		'ist', 'cfg', 'fd', 'bbx', 'cbx', 'lbx', 'aux', 'toc', 'lof', 'lot', 'eps', 'ps',
		'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'svg', 'tikz',
		'pgf', 'mps', 'mp', 'mf', 'txt', 'csv', 'dat'
	]);
	function renderNotice(notice: NoticeDescriptor, lang: import('./i18n/text.ts').Language): string {
		if (!notice) return '';
		if ('raw' in notice) return notice.raw;
		return text(lang, notice[0], notice[1]);
	}
	let compileNoticeState = $state<[string, string] | null>(null);
	let compileNotice = $derived(compileNoticeState ? text(preferences.language, compileNoticeState[0], compileNoticeState[1]) : '');
	let errorState = $state<NoticeDescriptor>(null);
	let error = $derived(renderNotice(errorState, preferences.language));
	let recentNoticeState = $state<[string, string] | null>(null);
	let recentNotice = $derived(recentNoticeState ? text(preferences.language, recentNoticeState[0], recentNoticeState[1]) : '');
	let preferencesNoticeState = $state<[string, string] | null>(null);
	let preferencesNotice = $derived(preferencesNoticeState ? text(preferences.language, preferencesNoticeState[0], preferencesNoticeState[1]) : '');
	function mirrorNativePreferences(value: Preferences) {
		try {
			const storage = window.localStorage;
			for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
				savePreference(storage, key, value[key] as never);
			}
			announcePreferenceChange(storage);
		} catch {
			// The native store is authoritative; localStorage is only a compatibility import and signal.
		}
	}
	function enqueueNativePreferenceOperation(
		operation: () => Promise<NativePreferencesSnapshot>,
		revision: number,
		onSuccess: (snapshot: NativePreferencesSnapshot) => void,
		onFailure: () => void
	) {
		const ticket = ++nativePreferencesOperation;
		void operation().then((snapshot) => {
			if (lifetime.signal.aborted || ticket !== nativePreferencesOperation || revision !== preferencesRevision) return;
			preferences = snapshot.preferences;
			onSuccess(snapshot);
		}).catch(() => {
			if (!lifetime.signal.aborted && ticket === nativePreferencesOperation && revision === preferencesRevision) onFailure();
		});
	}
	function queueNativePreferenceSet(key: keyof Preferences, value: unknown, revision: number) {
		enqueueNativePreferenceOperation(
			() => nativePreferences.set(key, value),
			revision,
			(snapshot) => {
				mirrorNativePreferences(snapshot.preferences);
				preferencesNoticeState = ['設定已儲存', 'Settings saved'];
			},
			() => {
				preferencesNoticeState = ['已套用，但無法保存設定。重啟後可能恢復預設值。', 'Applied, but settings could not be saved. They may reset after restarting.'];
			}
		);
	}
	function queueNativePreferenceReset(revision: number) {
		enqueueNativePreferenceOperation(
			() => nativePreferences.reset(),
			revision,
			(snapshot) => {
				mirrorNativePreferences(snapshot.preferences);
				preferencesNoticeState = ['設定已恢復為預設值', 'Settings restored to defaults'];
			},
			() => {
				preferencesNoticeState = ['無法保存預設設定，保留目前畫面設定。', 'Could not save default settings. Current screen settings were preserved.'];
			}
		);
	}
	function queueNativePreferenceRead(revision: number) {
		enqueueNativePreferenceOperation(
			() => nativePreferences.read(),
			revision,
			(snapshot) => {
				preferencesNoticeState = snapshot.invalid
					? ['部分設定無法讀取，已使用預設值。', 'Some settings could not be read and were reset to defaults.']
					: null;
			},
			() => {
				preferencesNoticeState = ['無法重新讀取已保存的設定，保留目前設定。', 'Saved settings could not be re-read. Current settings were preserved.'];
			}
		);
	}
	function finishNativePreferenceInitialization() {
		nativePreferencesReady = true;
		const revision = preferencesRevision;
		if (nativePreferencesResetPending) {
			nativePreferencesResetPending = false;
			queueNativePreferenceReset(revision);
		}
		const pending = [...pendingNativePreferences];
		pendingNativePreferences.clear();
		for (const [key, value] of pending) queueNativePreferenceSet(key, value, revision);
		if (nativePreferencesReloadPending) {
			nativePreferencesReloadPending = false;
			queueNativePreferenceRead(revision);
		}
	}
	function nativeImportNotice(result: NativePreferencesImport): [string, string] | null {
		if (result.remainingElectronSettings.length) {
			const fields = result.remainingElectronSettings.join(', ');
			return [
				`舊版 Electron 設定尚有未遷移欄位：${fields}。原設定檔已保留。`,
				`Some legacy Electron settings remain unmigrated: ${fields}. The original settings file was preserved.`
			];
		}
		if (result.invalid) return ['部分設定無法讀取，已使用預設值。', 'Some settings could not be read and were reset to defaults.'];
		return null;
	}
	async function refreshRecent() {
		if (!desktop) return;
		const ticket = ++recentTicket;
		try {
			const result = await desktop.listRecent();
			if (!lifetime.signal.aborted && ticket === recentTicket) { recent = result; recentNoticeState = null; }
		} catch {
			if (!lifetime.signal.aborted && ticket === recentTicket) recentNoticeState = ['無法讀取最近文件。仍可使用「開啟文件」。', 'Unable to read recent documents. You can still use "Open document".'];
		}
	}
	async function removeRecent(id: string) {
		if (!desktop || opening || saving || compiling) return;
		try { await desktop.removeRecent(id); await refreshRecent(); }
		catch { if (!lifetime.signal.aborted) recentNoticeState = ['無法移除紀錄，請稍後再試。', 'Unable to remove record. Please try again shortly.']; }
	}
	let systemDark = $state(false);
	let rootStateReady = $state(false);
	let rootStateDisposed = false;
	function changePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
		let decoded: Preferences[K];
		try {
			decoded = decodePreference(key, value);
		} catch {
			preferencesNoticeState = ['設定值無效，請重新輸入。', 'Invalid setting. Enter a supported value.'];
			return;
		}
		const next = { ...preferences, [key]: decoded };
		const revision = ++preferencesRevision;
		if (isTauri()) {
			preferences = next;
			preferencesNoticeState = ['設定已套用，正在儲存…', 'Applying settings…'];
			if (nativePreferencesReady) queueNativePreferenceSet(key, decoded, revision);
			else pendingNativePreferences.set(key, decoded);
			return;
		}
		try {
			savePreference(window.localStorage, key, decoded);
			preferences = readPreferences(window.localStorage).preferences;
			preferencesNoticeState = ['設定已儲存', 'Settings saved'];
		} catch {
			preferences = next;
			preferencesNoticeState = ['已套用，但無法保存設定。重啟後可能恢復預設值。', 'Applied, but settings could not be saved. They may reset after restarting.'];
		}
	}
	function restoreDefaults() {
		const revision = ++preferencesRevision;
		if (isTauri()) {
			preferences = DEFAULT_PREFERENCES;
			pendingNativePreferences.clear();
			preferencesNoticeState = ['正在恢復預設設定…', 'Restoring default settings…'];
			if (nativePreferencesReady) queueNativePreferenceReset(revision);
			else nativePreferencesResetPending = true;
			return;
		}
		try {
			const storage = window.localStorage;
			const result = restorePreferences(storage);
			if (result.status === 'restored') {
				preferences = result.preferences;
				preferencesNoticeState = ['設定已恢復為預設值', 'Settings restored to defaults'];
			} else if (result.status === 'partial') {
				preferences = result.preferences;
				preferencesNoticeState = ['無法完全恢復預設值，已重新讀取目前設定。', 'Could not fully restore defaults. Current settings were re-read.'];
			} else {
				preferencesNoticeState = ['無法讀取儲存空間，保留目前設定。', 'Storage could not be read. Current settings were preserved.'];
			}
		} catch {
			preferencesNoticeState = ['無法存取儲存空間，保留目前設定。', 'Unable to access storage. Current settings were preserved.'];
		}
	}
	$effect(() => {
		if (!rootStateReady || rootStateDisposed) return;
		document.documentElement.dataset.theme = effectiveAppearance(preferences.appearance, systemDark);
		document.documentElement.lang = preferences.language;
	});
	const lifetime = new AbortController();
	const hasDesktopBridge = isTauri() || Boolean((window as Window & { modutexFiles?: unknown }).modutexFiles);
	let desktop = $state.raw<FileDesktopPort | null>(null);
	let desktopLoading = $state(hasDesktopBridge);
	let workspace = $state.raw<WorkspaceInfo | null>(null);
	let workspaceFiles = $state.raw<WorkspaceFilesPort | null>(null);
	let workspaceFilesAvailability = $state<'checking' | 'available' | 'unavailable'>('unavailable');
	let workspaceFilesOpen = $state(false);
	let workspaceFilesPanelVisited = $state(false);
	let workspaceFilesButton: HTMLButtonElement | null = $state(null);
	let workspaceGeneration = $state(0);
	let sourceViewInstance = $state.raw<SourceViewHandle | null>(null);
	let draftSelectionSnapshot = $state.raw<DraftSelectionSnapshot | null>(null);
	let draftSelectionWarning = $state<[string, string] | null>(null);
	let draftPanelSelection = $derived.by(() => {
		const selected = draftSelectionSnapshot;
		if (!selected || !source || !workspace ||
			selected.workspaceId !== workspace.id ||
			selected.entryPath !== sourceName ||
			selected.documentId !== source.documentId ||
			selected.documentVersion !== source.version) return null;
		return { from: selected.from, to: selected.to };
	});
	let workspaceEntriesTicket = 0;
	const workspaceTreeTasks = new Set<WorkspaceFilesTask<readonly FileEntry[]>>();
	let entries = $state.raw<readonly FileEntry[]>([]);
	let workspaceWatchIssue = $state<WorkspaceWatchIssue | null>(null);
	let externalFileNotice = $state.raw<{
		readonly kind: 'changed' | 'missing';
		readonly documentId: string;
		readonly path: string;
		readonly acknowledged: boolean;
	} | null>(null);
	let activeWorkspaceWatch: WorkspaceWatch | null = null;
	$effect(() => ensureWorkspaceWatch(workspace));
	let sourceInput: HTMLInputElement;
	let pdfInput: HTMLInputElement;
	let sourceTicket = 0;
	let pdfTicket = 0;
	const messages: Record<string, [string, string]> = {
		FILE_TYPE: ['格式不支援或檔案損壞。', 'Unsupported or damaged file.'],
		SOURCE_TOO_LARGE: ['文件超過 5 MiB，請使用較小檔案。', 'Use a document under 5 MiB.'],
		PDF_TOO_LARGE: ['PDF 超過 32 MiB。', 'PDF exceeds 32 MiB.'],
		PDF_HEADER: ['檔案不是有效的 PDF。', 'Invalid PDF.'],
		PDF_LOAD: ['無法讀取 PDF，請檢查檔案。', 'Cannot read PDF. Check the file.'],
		PDF_RENDER: ['無法顯示此 PDF 頁面。', 'Cannot display this PDF page.'],
		STALE_WORKSPACE: ['工作區已關閉，請重新開啟。', 'Workspace closed. Reopen it.'],
		LINK_NOT_ALLOWED: ['路徑包含連結，請直接開啟檔案。', 'Linked path. Open the file directly.'],
		FILE_CHANGED: ['讀取時檔案已變更，請重開。', 'File changed. Reopen it.'],
		FILE_CONFLICT: ['磁碟文件已變更，未覆寫。請先保留編輯內容，再重新開啟文件。', 'Disk file changed; not overwritten. Keep your edits and reopen.'],
		ENGINE_UNAVAILABLE: ['內建引擎無法啟動，請檢查程式檔案。', 'Compiler unavailable. Check app files.'],
		BUSY: ['操作進行中，請稍後重試。', 'Busy. Try again shortly.'],
		FILE_TOO_LARGE: ['檔案過大：TeX／圖片 5 MiB，PDF 32 MiB。', 'Too large: TeX/images 5 MiB; PDF 32 MiB.'],
		IMAGE_TOO_LARGE: ['圖片過大：單張 5 MiB，另存總量 32 MiB。', 'Images: 5 MiB each; 32 MiB per save-as.'],
		TREE_TOO_LARGE: ['檔案過多，請開啟較小資料夾。', 'Too many files. Open a smaller folder.'],
		TREE_TOO_DEEP: ['層級過深，請直接開啟子資料夾。', 'Open a shallower folder.']
	};
	function fileErrorDescriptor(value: unknown): [string, string] {
		const code = value instanceof Error ? value.message : '';
		const entry = messages[code];
		return entry ?? ['無法開啟文件，請檢查檔案與讀取權限。', 'Unable to open document. Check the file and access.'];
	}
	function fileError(value: unknown): string {
		const entry = fileErrorDescriptor(value);
		return t(entry[0], entry[1]);
	}
	function setSourceViewMode(mode: 'source' | 'visual') {
		sourceViewMode = mode;
	}
	$effect(() => {
		if (draftPanelOpen && (!source || !workspace || !revision ||
			!sourceName.toLowerCase().endsWith('.tex') || !isTauri())) {
			draftPanelOpen = false;
		}
	});
	function handleSourceChange(document: SourceDocument, changed: boolean) {
		const nextDirty = changed || !hasDiskCheckpoint;
		if (nextDirty) invalidateSynctexIndex();
		if (draftSelectionSnapshot &&
			(draftSelectionSnapshot.documentId !== document.documentId ||
				draftSelectionSnapshot.documentVersion !== document.version)) {
			draftSelectionSnapshot = null;
			draftSelectionWarning = null;
		}
		source = document;
		dirty = nextDirty;
		if (projection && !projectionIsCurrent(document, projection)) projection = null;
	}
	function sourceLineBreakAt(sourceText: string, from: number): number {
		const lineFeed = sourceText.indexOf('\n', from);
		const carriageReturn = sourceText.indexOf('\r', from);
		if (lineFeed < 0) return carriageReturn;
		if (carriageReturn < 0) return lineFeed;
		return Math.min(lineFeed, carriageReturn);
	}
	function sourceOffsetAtLineColumn(
		sourceText: string,
		position: { readonly line: number; readonly column: number }
	): number | null {
		if (!Number.isSafeInteger(position.line) || position.line < 1 ||
			!Number.isSafeInteger(position.column) || position.column < 1) return null;
		let lineStart = 0;
		for (let line = 1; line < position.line; line++) {
			const lineBreak = sourceLineBreakAt(sourceText, lineStart);
			if (lineBreak < 0) return null;
			lineStart = lineBreak + 1;
			if (sourceText.charCodeAt(lineBreak) === 0x0d &&
				sourceText.charCodeAt(lineBreak + 1) === 0x0a) lineStart++;
		}
		const lineBreak = sourceLineBreakAt(sourceText, lineStart);
		const lineEnd = lineBreak < 0 ? sourceText.length : lineBreak;
		const offset = lineStart + position.column - 1;
		return offset <= lineEnd ? offset : null;
	}
	function captureDraftSelection(): DraftSelectionSnapshot | null {
		const current = source;
		const owner = workspace;
		const path = sourceName;
		const view = sourceViewInstance;
		if (!current || !owner || !view || !path.toLowerCase().endsWith('.tex')) return null;
		const selected = view.getEditorSelection(current.documentId, current.version);
		if (!selected ||
			selected.documentId !== undefined && selected.documentId !== current.documentId ||
			selected.documentVersion !== undefined && selected.documentVersion !== current.version) return null;
		const sourceText = current.read();
		let from: number;
		let to: number;
		if (selected.selection) {
			const start = sourceOffsetAtLineColumn(sourceText, selected.selection.start);
			const end = sourceOffsetAtLineColumn(sourceText, selected.selection.end);
			if (start === null || end === null) return null;
			from = Math.min(start, end);
			to = Math.max(start, end);
		} else {
			const cursor = sourceOffsetAtLineColumn(sourceText, selected.cursor);
			if (cursor === null) return null;
			from = cursor;
			to = cursor;
		}
		if (source !== current || workspace !== owner || sourceName !== path ||
			sourceViewInstance !== view) return null;
		return Object.freeze({
			workspaceId: owner.id,
			entryPath: path,
			documentId: current.documentId,
			documentVersion: current.version,
			from,
			to
		});
	}
	function canOpenDraftPanel(): boolean {
		return isTauri() && !!desktop && !!source && !!workspace && revision !== null &&
			sourceName.toLowerCase().endsWith('.tex') &&
			!opening && !saving && !confirming && !compiling && !sourceMissingOnDisk() &&
			!lifetime.signal.aborted;
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
		if (!source || !pdfBytes || !synctexIndex || !pdfIdentity || !workspace ||
			workspace.id !== synctexIndex.identity.workspaceId) return false;
		if (!sameCompileIdentity(synctexIndex.identity, pdfIdentity)) return false;
		if (dirty) return false;
		if (sourceName === synctexIndex.identity.entryPath) {
			return source.documentId === synctexIndex.identity.documentId &&
				source.version === synctexIndex.identity.documentVersion &&
				revision === synctexIndex.identity.savedRevision;
		}
		return true;
	}
	function forwardSynctex() {
		if (opening || saving || compiling || !source) return;
		if (!canForwardSynctex() || !synctexIndex || !pdfIdentity) {
			errorState = ['文件已變更或預覽未就緒，無法定位。', 'Document changed or preview not ready. Cannot locate.'];
			return;
		}
		const sel = sourceViewInstance?.getEditorSelection(source.documentId, source.version);
		if (!sel) {
			errorState = ['無法取得游標位置，請將游標放在編輯器中再試。', 'Could not read the cursor position. Place the cursor in the editor and retry.'];
			return;
		}
		const line = sel.cursor.line;
		let loc: SynctexPdfLocation | null = null;
		try {
			loc = synctexIndex.forwardSearch(line, null, sourceName);
		} catch {
			loc = null;
		}
		if (!loc) {
			errorState = ['找不到此行在 PDF 中的對應位置。', 'Could not locate this line in the PDF.'];
			return;
		}
		pdfRevealSequence++;
		pdfReveal = {
			page: loc.page,
			x: loc.x,
			y: loc.y,
			requestId: pdfRevealSequence
		};
		workbenchPane = 'pdf';
	}
	async function handlePdfPoint(point: { page: number; x: number; y: number }) {
		if (opening || saving || confirming) return;
		if (!synctexIndex || !pdfIdentity || !sameCompileIdentity(synctexIndex.identity, pdfIdentity)) return;
		if (!workspace || workspace.id !== synctexIndex.identity.workspaceId) return;
		if (lifetime.signal.aborted) return;
		let loc: SynctexSourceLocation | null = null;
		try {
			loc = synctexIndex.inverseSearch(point.page, point.x, point.y);
		} catch {
			return;
		}
		if (!loc) return;
		const targetPath = safeWorkspaceDiagnosticPath(loc.path);
		if (!targetPath) return;
		const owner = workspace;
		const current = source;
		if (current && sourceName === targetPath) {
			const entryIdentity = synctexIndex.identity;
			if (dirty ||
				(sourceName === entryIdentity.entryPath &&
					(current.documentId !== entryIdentity.documentId ||
						current.version !== entryIdentity.documentVersion ||
						revision !== entryIdentity.savedRevision))) {
				errorState = ['文件已變更，無法定位。請重新編譯後再試。', 'The document changed. Recompile before locating.'];
				return;
			}
			diagnosticNavigation = {
				location: { line: loc.line, utf16Column: loc.column },
				documentId: current.documentId,
				documentVersion: current.version,
				sequence: ++diagnosticNavigationSequence
			};
			workbenchPane = 'document';
			route = 'workbench';
			window.location.hash = '#/workbench';
			return;
		}
		await openIncludedSynctex(loc, targetPath, owner);
	}
	async function openIncludedSynctex(
		loc: SynctexSourceLocation,
		targetPath: string,
		owner: WorkspaceInfo
	) {
		const port = desktop;
		const index = synctexIndex;
		if (!port || opening || saving || confirming || !index) return;
		if (!pdfIdentity || !sameCompileIdentity(index.identity, pdfIdentity)) return;
		if (workspace !== owner || owner.id !== index.identity.workspaceId) return;
		if (source && sourceName === index.identity.entryPath &&
			(source.documentId !== index.identity.documentId ||
				source.version !== index.identity.documentVersion ||
				revision !== index.identity.savedRevision)) {
			errorState = ['文件已變更，無法定位。請重新編譯後再試。', 'The document changed. Recompile before locating.'];
			return;
		}
		const sourceBefore = source;
		const sourceNameBefore = sourceName;
		const versionBefore = source?.version ?? null;
		const revisionBefore = revision;
		const dirtyBefore = dirty;
		const ticketBeforeConfirm = sourceTicket;
		if (!await allowReplacement()) {
			errorState = ['已取消切換至對應文件，草稿已保留。', 'Switching to the source document was cancelled. Your draft was preserved.'];
			return;
		}
		if (ticketBeforeConfirm !== sourceTicket ||
			lifetime.signal.aborted || opening || saving || workspace !== owner ||
			source !== sourceBefore || sourceName !== sourceNameBefore ||
			(source?.version ?? null) !== versionBefore ||
			revision !== revisionBefore || dirty !== dirtyBefore) return;
		if (!synctexIndex || synctexIndex !== index || !pdfIdentity || !sameCompileIdentity(index.identity, pdfIdentity)) return;
		const ticket = ++sourceTicket;
		opening = true;
		errorState = null;
		try {
			const receipt = await port.readFile({ workspaceId: owner.id, path: targetPath });
			if (lifetime.signal.aborted || ticket !== sourceTicket || workspace !== owner) return;
			if (!synctexIndex || synctexIndex !== index || !pdfIdentity || !sameCompileIdentity(index.identity, pdfIdentity)) return;
			if (source !== sourceBefore || sourceName !== sourceNameBefore ||
				(source?.version ?? null) !== versionBefore ||
				revision !== revisionBefore || dirty !== dirtyBefore) return;
			const reloaded = readSourceBytes(receipt.bytes);
			if (lifetime.signal.aborted || ticket !== sourceTicket || workspace !== owner) return;
			acceptDiskSource(reloaded, targetPath, receipt.revision);
			diagnosticNavigation = {
				location: { line: loc.line, utf16Column: loc.column },
				documentId: reloaded.documentId,
				documentVersion: reloaded.version,
				sequence: ++diagnosticNavigationSequence
			};
			workbenchPane = 'document';
			route = 'workbench';
			window.location.hash = '#/workbench';
		} catch (value) {
			if (ticket === sourceTicket && workspace === owner) {
				errorState = fileErrorDescriptor(value);
			}
		} finally {
			if (!lifetime.signal.aborted && ticket === sourceTicket) {
				opening = false;
				void drainWorkspaceWatch();
			}
		}
	}
	function isWorkspaceScopeCurrent(owner: WorkspaceInfo, generation: number): boolean {
		return workspaceFilesScopeMatches(
			workspace?.id ?? null,
			workspaceGeneration,
			owner.id,
			generation,
			lifetime.signal
		);
	}
	function cancelWorkspaceTreeTasks() {
		for (const task of workspaceTreeTasks) void task.cancel().catch(() => {});
		workspaceTreeTasks.clear();
	}
	function selectWorkspace(owner: WorkspaceInfo | null) {
		if (workspace === owner) return;
		workspaceGeneration++;
		workspaceEntriesTicket++;
		cancelWorkspaceTreeTasks();
		workspaceFilesOpen = false;
		workspaceFilesAvailability = owner && workspaceFiles ? 'checking' : 'unavailable';
		synctexIndex?.dispose();
		synctexIndex = null;
		pdfReveal = undefined;
		workspace = owner;
	}
	async function refreshWorkspaceEntries(
		owner: WorkspaceInfo,
		generation: number
	): Promise<readonly FileEntry[] | null> {
		const port = desktop;
		if (!port || !isWorkspaceScopeCurrent(owner, generation)) return null;
		const ticket = ++workspaceEntriesTicket;
		for (const pending of workspaceTreeTasks) void pending.cancel().catch(() => {});
		const files = workspaceFiles;
		if (files && workspaceFilesAvailability !== 'unavailable') {
			let task: WorkspaceFilesTask<readonly FileEntry[]> | null = null;
			try {
				task = files.startTree(owner.id);
				workspaceTreeTasks.add(task);
				const listed = await task.result;
				if (!isWorkspaceScopeCurrent(owner, generation) || ticket !== workspaceEntriesTicket) return null;
				workspaceFilesAvailability = 'available';
				entries = listed;
				return listed;
			} catch (value) {
				if (!isWorkspaceScopeCurrent(owner, generation) || ticket !== workspaceEntriesTicket) return null;
				if (isWorkspaceFilesCapabilityUnavailable(value)) {
					workspaceFilesAvailability = 'unavailable';
					workspaceFilesOpen = false;
				} else {
					workspaceFilesAvailability = 'available';
					errorState = fileErrorDescriptor(value);
				}
			} finally {
				if (task) workspaceTreeTasks.delete(task);
			}
		}
		try {
			const listed = await port.listFiles(owner.id);
			if (!isWorkspaceScopeCurrent(owner, generation) || ticket !== workspaceEntriesTicket) return null;
			entries = listed;
			return listed;
		} catch (value) {
			if (isWorkspaceScopeCurrent(owner, generation) && ticket === workspaceEntriesTicket) {
				errorState = fileErrorDescriptor(value);
			}
			return null;
		}
	}
	function setWorkspaceEntriesIfCurrent(
		owner: WorkspaceInfo,
		generation: number,
		listed: readonly FileEntry[]
	) {
		if (isWorkspaceScopeCurrent(owner, generation)) entries = listed;
	}
	function disableWorkspaceFilesIfCurrent(owner: WorkspaceInfo, generation: number) {
		if (!isWorkspaceScopeCurrent(owner, generation)) return;
		workspaceFilesAvailability = 'unavailable';
		workspaceFilesOpen = false;
		errorState = [
			'此桌面版本未提供完整的原生工作區檔案操作；一般檔案瀏覽與編輯仍可使用。',
			'This host does not provide the native workspace file operations. Regular file browsing and editing remain available.'
		];
		void refreshWorkspaceEntries(owner, generation);
	}
	function openWorkspaceFiles() {
		if (!workspace || !workspaceFiles || workspaceFilesAvailability !== 'available') return;
		workspaceFilesPanelVisited = true;
		workspaceFilesOpen = true;
	}
	function closeWorkspaceFiles() {
		workspaceFilesOpen = false;
		void tick()
			.then(() => {
				if (route === 'workbench' && workspaceFilesButton?.isConnected) workspaceFilesButton.focus();
			})
			.catch(() => {});
	}
	async function reloadWorkspaceSourceAtPath(
		owner: WorkspaceInfo,
		generation: number,
		previousPath: string,
		nextPath: string
	) {
		if (
			!isWorkspaceScopeCurrent(owner, generation) ||
			sourceName !== previousPath ||
			dirty ||
			opening ||
			saving ||
			confirming
		) {
			return;
		}
		await readDesktopFile(nextPath, owner);
	}
	function detachWorkspaceSourceAfterRemoval(
		owner: WorkspaceInfo,
		generation: number,
		path: string
	) {
		if (
			!isWorkspaceScopeCurrent(owner, generation) ||
			!source ||
			sourceName !== path ||
			dirty ||
			opening ||
			saving
		) {
			return;
		}
		abandonCompile();
		if (pdfIdentity?.workspaceId === owner.id && pdfIdentity.entryPath === path) {
			pdfBytes = null;
			pdfIdentity = null;
			pdfName = '';
			pageCount = 0;
			synctexIndex?.dispose();
			synctexIndex = null;
			pdfReveal = undefined;
		}
		sourceName = 'untitled.tex';
		revision = null;
		savedVersion = null;
		hasDiskCheckpoint = false;
		dirty = true;
		externalFileNotice = null;
	}
	async function compileWorkspaceFile(path: string, owner: WorkspaceInfo) {
		if (!desktop || opening || saving || compiling || workspace !== owner) return;
		let config;
		try {
			config = await desktop.getCompileConfig(owner.id);
		} catch {
			config = null;
		}
		if (workspace !== owner) return;
		const mainPath = config?.mainFile ?? null;
		if (mainPath && mainPath === path) {
			await compileSource();
			return;
		}
		if (sourceName !== path) {
			await readDesktopFile(path, owner);
		}
		if (workspace === owner && sourceName === path) {
			await compileSource();
		}
	}
	function compileErrorDescriptor(value: unknown): [string, string] {
		const code = value instanceof Error ? value.message : '';
		switch (code) {
			case 'ENGINE_UNAVAILABLE':
				return messages.ENGINE_UNAVAILABLE!;
			case 'BUSY':
				return ['操作未結束，請稍後編譯。', 'Busy. Retry.'];
			case 'FILE_CONFLICT':
				return ['磁碟文件已變更，未啟動編譯。請同步文件或保留草稿後再試。', 'The disk file changed, so compilation did not start. Reconcile the file or keep your draft, then try again.'];
			case 'FILE_CHANGED':
				return ['編譯輸入在讀取時已變更。請同步文件後再編譯。', 'A compile input changed while being read. Reconcile the file and try again.'];
			case 'LINK_NOT_ALLOWED':
				return ['編譯輸入包含連結路徑。請直接開啟實際文件後再試。', 'A compile input contains a linked path. Open the actual document directly and try again.'];
			case 'STALE_WORKSPACE':
				return ['工作區已關閉，編譯未完成。請重新開啟文件後再試。', 'The workspace was closed before compilation completed. Reopen the document and try again.'];
			case 'CANCELLED':
				return ['無法確認本次編譯結果，請稍後重試。', 'The compilation result could not be confirmed. Please try again shortly.'];
			case 'TIMEOUT':
				return ['編譯逾時。請檢查 TeX 記錄並修正文件後再試。', 'Compilation timed out. Review the TeX log, correct the document, and try again.'];
			case 'COMPILE_FAILED':
				return ['編譯失敗。請檢查編譯問題或 TeX 記錄，修正後重新編譯。', 'Compilation failed. Review the problems or TeX log, then compile again.'];
			case 'FILE_TOO_LARGE':
				return ['工作區的編譯輸入超過大小上限。請將快取或其他非文件資料移出工作區後重試。', 'Workspace compile inputs exceed the size limit. Move caches or unrelated data outside the workspace and retry.'];
			case 'TREE_TOO_LARGE':
			case 'TREE_TOO_DEEP':
				return ['工作區的檔案數或目錄深度超過上限。請開啟文件所在的較小資料夾後重試。', 'Workspace file count or directory depth exceeds the limit. Open a smaller document folder and retry.'];
			default:
				return ['無法啟動或完成編譯。請查看編譯詳細資料。', 'Compilation could not start or finish. Review the compilation details.'];
		}
	}
	function workspaceWatchIsCurrent(watch: WorkspaceWatch): boolean {
		return !lifetime.signal.aborted && watch.active && !watch.terminal &&
			activeWorkspaceWatch === watch &&
			workspace === watch.owner &&
			workspaceFilesScopeMatches(
				workspace?.id ?? null,
				workspaceGeneration,
				watch.owner.id,
				watch.generation,
				lifetime.signal
			);
	}
	function stopWorkspaceWatch(watch: WorkspaceWatch | null = activeWorkspaceWatch) {
		if (!watch) return;
		watch.active = false;
		watch.pending.clear();
		const unsubscribe = watch.unsubscribe;
		watch.unsubscribe = null;
		if (unsubscribe) {
			try { unsubscribe(); } catch { /* disposal must not interrupt workspace replacement */ }
		}
		if (activeWorkspaceWatch === watch) activeWorkspaceWatch = null;
	}
	function failWorkspaceWatch(watch: WorkspaceWatch) {
		if (!watch.active || watch.terminal) return;
		invalidateSynctexForWorkspaceWatchLoss(watch);
		watch.terminal = true;
		watch.pending.clear();
		const unsubscribe = watch.unsubscribe;
		watch.unsubscribe = null;
		if (unsubscribe) {
			try { unsubscribe(); } catch { /* the terminal subscription is already unusable */ }
		}
		if (!lifetime.signal.aborted && activeWorkspaceWatch === watch && workspace === watch.owner) {
			workspaceWatchIssue = 'offline';
		}
	}
	function suspendWorkspaceWatch(watch: WorkspaceWatch) {
		if (!workspaceWatchIsCurrent(watch)) return;
		invalidateSynctexForWorkspaceWatchLoss(watch);
		if (watch.overflowed) {
			watch.recoveryEvents = true;
			return;
		}
		watch.overflowed = true;
		watch.recoveryEvents = false;
		watch.pending.clear();
		workspaceWatchIssue = 'reconcile';
	}
	function setExternalFileNotice(
		watch: WorkspaceWatch,
		documentId: string,
		path: string,
		kind: 'changed' | 'missing'
	) {
		if (!workspaceWatchIsCurrent(watch) || source?.documentId !== documentId || sourceName !== path) return;
		externalFileNotice = { kind, documentId, path, acknowledged: false };
	}
	function clearExternalFileNotice(documentId: string, path: string) {
		if (externalFileNotice?.documentId === documentId && externalFileNotice.path === path) {
			externalFileNotice = null;
		}
	}
	function sourceMissingOnDisk(): boolean {
		return !!source && externalFileNotice?.kind === 'missing' &&
			externalFileNotice.documentId === source.documentId && externalFileNotice.path === sourceName;
	}
	function queueWorkspaceEvent(watch: WorkspaceWatch, queued: QueuedWorkspaceEvent) {
		if (!workspaceWatchIsCurrent(watch)) return;
		invalidateSynctexForWorkspaceEvent(watch, queued.event);
		if (watch.overflowed) {
			watch.recoveryEvents = true;
			return;
		}
		if (!watch.pending.has(queued.event.path) &&
			watch.pending.size >= MAX_RENDERER_PENDING_WATCH_EVENTS) {
			suspendWorkspaceWatch(watch);
			return;
		}
		watch.pending.set(queued.event.path, queued);
		void drainWorkspaceWatch(watch);
	}
	function startWorkspaceWatch(owner: WorkspaceInfo) {
		if (!desktop || workspace !== owner || lifetime.signal.aborted) return;
		const watch: WorkspaceWatch = {
			owner,
			generation: workspaceGeneration,
			pending: new Map(),
			active: true,
			terminal: false,
			overflowed: false,
			recoveryEvents: false,
			processing: false,
			resync: false,
			recovering: false,
			unsubscribe: null
		};
		activeWorkspaceWatch = watch;
		workspaceWatchIssue = null;
		try {
			void desktop.watchFiles(owner.id, (event) => {
				if (event.workspaceId !== owner.id || !workspaceWatchIsCurrent(watch)) return;
				queueWorkspaceEvent(watch, { event });
			}, () => failWorkspaceWatch(watch), (reason) => {
				if (reason !== 'PERIODIC_RECONCILE_DUE' || !workspaceWatchIsCurrent(watch)) return;
				if (watch.overflowed) {
					watch.recoveryEvents = true;
					return;
				}
				watch.resync = true;
				void drainWorkspaceWatch(watch);
			}).then((unsubscribe) => {
				if (!workspaceWatchIsCurrent(watch)) {
					try { unsubscribe(); } catch { /* a late subscription is immediately disposed */ }
					return;
				}
				watch.unsubscribe = unsubscribe;
				// The host baseline may include edits made between readFile and watch startup.
				watch.resync = true;
				void drainWorkspaceWatch(watch);
			}).catch(() => failWorkspaceWatch(watch));
		} catch {
			failWorkspaceWatch(watch);
		}
	}
	function ensureWorkspaceWatch(owner: WorkspaceInfo | null) {
		const current = activeWorkspaceWatch;
		if (current?.active && current.owner === owner) return;
		if (current) stopWorkspaceWatch(current);
		externalFileNotice = null;
		workspaceWatchIssue = null;
		if (owner && desktop) startWorkspaceWatch(owner);
	}
	function invalidateSynctexForSourceChange(path: string, nextRevision: string) {
		const index = synctexIndex;
		if (!index) return;
		if (path.toLowerCase() === index.identity.entryPath.toLowerCase() &&
			nextRevision === index.identity.savedRevision) return;
		invalidateSynctexIndex();
	}
	function invalidateSynctexIndex() {
		const index = synctexIndex;
		if (!index) return;
		index.dispose();
		if (synctexIndex === index) synctexIndex = null;
		pdfReveal = undefined;
	}
	function isSynctexDependencyPath(path: string): boolean {
		const filename = path.split('/').at(-1) ?? '';
		const dot = filename.lastIndexOf('.');
		return dot <= 0 || SYNCTEX_INPUT_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
	}
	function invalidateSynctexForWorkspacePath(workspaceId: string, path: string) {
		const index = synctexIndex;
		if (!index || index.identity.workspaceId !== workspaceId) return;
		if (path.toLowerCase() !== index.identity.entryPath.toLowerCase() &&
			!isSynctexDependencyPath(path)) return;
		invalidateSynctexIndex();
	}
	function invalidateSynctexForWorkspaceEvent(watch: WorkspaceWatch, event: FileEvent) {
		const index = synctexIndex;
		if (!index || index.identity.workspaceId !== watch.owner.id) return;
		const isEntry = event.path.toLowerCase() === index.identity.entryPath.toLowerCase();
		if (!isEntry && !isSynctexDependencyPath(event.path)) return;
		if (isEntry && event.kind === 'changed' && source &&
			sourceName.toLowerCase() === event.path.toLowerCase() && !dirty &&
			revision === index.identity.savedRevision) return;
		invalidateSynctexIndex();
	}
	function invalidateSynctexForWorkspaceWatchLoss(watch: WorkspaceWatch) {
		if (synctexIndex?.identity.workspaceId === watch.owner.id) invalidateSynctexIndex();
	}
	function acceptDiskSource(document: SourceDocument, path: string, nextRevision: string) {
		abandonCompile();
		draftSelectionSnapshot = null;
		draftSelectionWarning = null;
		source = document;
		sourceName = path;
		revision = nextRevision;
		savedVersion = null;
		hasDiskCheckpoint = true;
		dirty = false;
		projection = null;
		outline = [];
		outlineOwner = '';
		outlineFailed = false;
		navigation = null;
		externalFileNotice = null;
	}
	function requeueWorkspaceEvent(watch: WorkspaceWatch, queued: QueuedWorkspaceEvent | null) {
		if (!queued) {
			watch.recoveryEvents = true;
			return;
		}
		if (!watch.pending.has(queued.event.path)) queueWorkspaceEvent(watch, queued);
	}
	async function listWatchedFiles(watch: WorkspaceWatch) {
		const port = desktop;
		if (!port || !workspaceWatchIsCurrent(watch)) return null;
		try {
			const listed = await port.listFiles(watch.owner.id);
			return workspaceWatchIsCurrent(watch) ? listed : null;
		} catch { suspendWorkspaceWatch(watch); return null; }
	}
	async function reconcileSourceFromDisk(
		watch: WorkspaceWatch,
		documentId: string,
		path: string,
		queued: QueuedWorkspaceEvent | null
	) {
		const port = desktop;
		const snapshot = source;
		if (!port || !workspaceWatchIsCurrent(watch) || !snapshot ||
			snapshot.documentId !== documentId || sourceName !== path) return;
		if (opening || saving) {
			requeueWorkspaceEvent(watch, queued);
			return;
		}
		const snapshotVersion = snapshot.version;
		const dirtyAtRead = dirty;
		const revisionAtRead = revision;
		let receipt;
		try {
			receipt = await port.readFile({ workspaceId: watch.owner.id, path });
		} catch (value) {
			if (!workspaceWatchIsCurrent(watch) || source?.documentId !== documentId || sourceName !== path) return;
			if (opening || saving || revision !== revisionAtRead) {
				requeueWorkspaceEvent(watch, queued);
				return;
			}
			invalidateSynctexForWorkspacePath(watch.owner.id, path);
			const refreshed = await listWatchedFiles(watch);
			if (!refreshed || source?.documentId !== documentId || sourceName !== path) return;
			entries = refreshed;
			const exists = refreshed.some((entry) => entry.kind === 'file' && entry.path === path);
			setExternalFileNotice(watch, documentId, path, exists ? 'changed' : 'missing');
			errorState = fileErrorDescriptor(value);
			return;
		}
		if (!workspaceWatchIsCurrent(watch) || source?.documentId !== documentId || sourceName !== path) return;
		if (opening || saving || revision !== revisionAtRead) {
			requeueWorkspaceEvent(watch, queued);
			return;
		}
		// This revision check also recognizes our own save. A queued save event must not
		// become a conflict merely because the user typed again before it was drained.
		if (receipt.revision === revision) {
			clearExternalFileNotice(documentId, path);
			return;
		}
		invalidateSynctexForWorkspacePath(watch.owner.id, path);
		if (source !== snapshot || source.version !== snapshotVersion || dirty !== dirtyAtRead || dirtyAtRead) {
			setExternalFileNotice(watch, documentId, path, 'changed');
			return;
		}
		try {
			const reloaded = readSourceBytes(receipt.bytes);
			if (!workspaceWatchIsCurrent(watch) || source !== snapshot ||
				source?.documentId !== documentId || source.version !== snapshotVersion ||
				sourceName !== path || dirty || revision !== revisionAtRead) {
				setExternalFileNotice(watch, documentId, path, 'changed');
				return;
			}
			invalidateSynctexForSourceChange(path, receipt.revision);
			acceptDiskSource(reloaded, path, receipt.revision);
		} catch (value) {
			if (!workspaceWatchIsCurrent(watch) || source?.documentId !== documentId || sourceName !== path) return;
			setExternalFileNotice(watch, documentId, path, 'changed');
			errorState = fileErrorDescriptor(value);
		}
	}
	async function reconcileWorkspaceEvent(watch: WorkspaceWatch, queued: QueuedWorkspaceEvent | null, listed: readonly FileEntry[]) {
		if (!workspaceWatchIsCurrent(watch)) return;
		const currentSource = source;
		if (!currentSource) return;
		const currentPath = sourceName;
		const exists = listed.some((entry) => entry.kind === 'file' && entry.path === currentPath);
		if (!exists) {
			invalidateSynctexForWorkspacePath(watch.owner.id, currentPath);
			setExternalFileNotice(watch, currentSource.documentId, currentPath, 'missing');
			return;
		}
		const wasMissing = externalFileNotice?.kind === 'missing' &&
			externalFileNotice.documentId === currentSource.documentId && externalFileNotice.path === currentPath;
		// Watch events belong to a path, even when reopening creates a new source identity.
		if (queued && queued.event.path !== currentPath) {
			if (wasMissing) setExternalFileNotice(watch, currentSource.documentId, currentPath, 'changed');
			return;
		}
		await reconcileSourceFromDisk(watch, currentSource.documentId, currentPath, queued);
	}
	function workspaceWatchCanDrain(watch: WorkspaceWatch) {
		return !watch.overflowed && workspaceWatchIsCurrent(watch) && !opening && !saving && !confirming;
	}
	async function drainWorkspaceWatch(watch: WorkspaceWatch | null = activeWorkspaceWatch) {
		if (!watch || watch.processing || !workspaceWatchCanDrain(watch)) return;
		watch.processing = true;
		try {
			while ((watch.pending.size || watch.resync) && workspaceWatchCanDrain(watch)) {
				if (watch.resync) {
					if (source && !watch.pending.has(sourceName)) watch.pending.set(sourceName,
						{ event: { workspaceId: watch.owner.id, path: sourceName, kind: 'changed' } });
					watch.resync = false;
				}
				const batch = [...watch.pending.values()];
				const listed = await listWatchedFiles(watch);
				if (!listed || watch.overflowed) return;
				entries = listed;
				for (const queued of batch) {
					if (!workspaceWatchCanDrain(watch)) return;
					// Leave unprocessed and newer same-path events pending across awaited I/O.
					if (watch.pending.get(queued.event.path) !== queued) continue;
					watch.pending.delete(queued.event.path);
					await reconcileWorkspaceEvent(watch, queued, listed);
				}
			}
		} finally {
			watch.processing = false;
			if ((watch.pending.size || watch.resync) && workspaceWatchCanDrain(watch)) {
				void drainWorkspaceWatch(watch);
			}
		}
	}
	async function reconcileWorkspaceSnapshot(watch: WorkspaceWatch) {
		const listed = await listWatchedFiles(watch);
		if (!listed) return;
		entries = listed;
		await reconcileWorkspaceEvent(watch, null, listed);
	}
	async function recoverWorkspaceWatch() {
		const watch = activeWorkspaceWatch;
		if (watch?.recovering) return;
		if (workspaceWatchIssue === 'reconcile' && watch?.overflowed &&
			workspaceWatchIsCurrent(watch) && !opening && !saving) {
			watch.recovering = true;
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					watch.recoveryEvents = false;
					await reconcileWorkspaceSnapshot(watch);
					if (!workspaceWatchIsCurrent(watch)) return;
					if (!watch.recoveryEvents) {
						watch.overflowed = false;
						workspaceWatchIssue = null;
						void drainWorkspaceWatch(watch);
						return;
					}
				}
			} finally {
				watch.recovering = false;
			}
			return;
		}
		const owner = workspace;
		if (workspaceWatchIssue === 'offline' && owner && desktop) {
			if (watch) stopWorkspaceWatch(watch);
			workspaceWatchIssue = null;
			startWorkspaceWatch(owner);
		}
	}
	function keepExternalDraft() {
		if (!externalFileNotice || !source ||
			externalFileNotice.documentId !== source.documentId || externalFileNotice.path !== sourceName) return;
		externalFileNotice = { ...externalFileNotice, acknowledged: true };
	}
	async function reloadExternalSource() {
		const notice = externalFileNotice;
		const watch = activeWorkspaceWatch;
		const port = desktop;
		const snapshot = source;
		if (!notice || notice.kind !== 'changed' || !watch || !port || !snapshot ||
			!workspaceWatchIsCurrent(watch) || notice.documentId !== snapshot.documentId ||
			notice.path !== sourceName || opening || saving || confirming) return;
		const snapshotVersion = snapshot.version;
		const dirtyAtStart = dirty;
		const revisionAtStart = revision;
		if (!await allowReplacement()) return;
		// A confirmed dirty reload is allowed, but edits made after the confirmation are not.
		if (!workspaceWatchIsCurrent(watch) || source !== snapshot ||
			source?.documentId !== notice.documentId || source.version !== snapshotVersion ||
			sourceName !== notice.path || dirty !== dirtyAtStart || revision !== revisionAtStart) return;
		const ticket = ++sourceTicket;
		opening = true;
		errorState = null;
		try {
			const receipt = await port.readFile({ workspaceId: watch.owner.id, path: notice.path });
			if (lifetime.signal.aborted || ticket !== sourceTicket || !workspaceWatchIsCurrent(watch)) return;
			if (source !== snapshot || source?.documentId !== notice.documentId ||
				source.version !== snapshotVersion || sourceName !== notice.path ||
				dirty !== dirtyAtStart || revision !== revisionAtStart) {
				setExternalFileNotice(watch, notice.documentId, notice.path, 'changed');
				return;
			}
			const reloaded = readSourceBytes(receipt.bytes);
			if (lifetime.signal.aborted || ticket !== sourceTicket || !workspaceWatchIsCurrent(watch) ||
				source !== snapshot || source?.documentId !== notice.documentId ||
				source.version !== snapshotVersion || sourceName !== notice.path ||
				dirty !== dirtyAtStart || revision !== revisionAtStart) {
				setExternalFileNotice(watch, notice.documentId, notice.path, 'changed');
				return;
			}
			invalidateSynctexForSourceChange(notice.path, receipt.revision);
			acceptDiskSource(reloaded, notice.path, receipt.revision);
		} catch (value) {
			if (lifetime.signal.aborted || ticket !== sourceTicket || !workspaceWatchIsCurrent(watch)) return;
			let listed: readonly FileEntry[];
			try {
				listed = await port.listFiles(watch.owner.id);
			} catch {
				suspendWorkspaceWatch(watch);
				return;
			}
			if (lifetime.signal.aborted || ticket !== sourceTicket || !workspaceWatchIsCurrent(watch) ||
				source?.documentId !== notice.documentId || sourceName !== notice.path) return;
			entries = listed;
			const exists = listed.some((entry) => entry.kind === 'file' && entry.path === notice.path);
			setExternalFileNotice(watch, notice.documentId, notice.path, exists ? 'changed' : 'missing');
			errorState = fileErrorDescriptor(value);
		} finally {
			if (!lifetime.signal.aborted && ticket === sourceTicket) {
				opening = false;
				void drainWorkspaceWatch(watch);
			}
		}
	}
	onDestroy(() => {
		rootStateDisposed = true;
		stopWorkspaceWatch();
		workspaceGeneration++;
		workspaceEntriesTicket++;
		cancelWorkspaceTreeTasks();
		synctexIndex?.dispose();
		synctexIndex = null;
		lifetime.abort(); ++sourceTicket; ++pdfTicket;
		++compileTicket;
		if (workspace && desktop) void desktop.closeWorkspace(workspace.id).catch(() => {});
	});
	onMount(() => {
		const root = document.documentElement, previousTheme = root.dataset.theme, previousLanguage = root.getAttribute('lang');
		let closeRegistrationDisposed = false;
		let unlistenCloseRequested: (() => void) | null = null;
		if (isTauri()) {
			try {
				void getCurrentWindow().onCloseRequested((event) => {
					if (closeRegistrationDisposed || lifetime.signal.aborted ||
						closeIsConfirmedForCurrentSource() || !dirty || !source) return;
					event.preventDefault();
					showCloseDialog = true;
				}).then((unlisten) => {
					if (closeRegistrationDisposed || lifetime.signal.aborted) {
						unlisten();
						return;
					}
					unlistenCloseRequested = unlisten;
				}).catch(() => {
					if (!closeRegistrationDisposed) reportNativeCloseProtectionFailure();
				});
			} catch {
				if (!closeRegistrationDisposed) reportNativeCloseProtectionFailure();
			}
		}
		if (hasDesktopBridge) {
			void import('./features/files/desktop.ts').then(({ desktopFiles }) => {
				if (lifetime.signal.aborted) return;
				desktop = desktopFiles(lifetime.signal);
				workspaceFiles = tauriWorkspaceFiles(lifetime.signal);
				if (workspace && workspaceFiles) {
					const owner = workspace;
					const generation = workspaceGeneration;
					workspaceFilesAvailability = 'checking';
					void refreshWorkspaceEntries(owner, generation);
				}
				void refreshRecent();
			}).catch(() => {
				if (!lifetime.signal.aborted) errorState = ['無法載入桌面檔案功能，請重新開啟程式。', 'Desktop file access could not be loaded. Please reopen the application.'];
			}).finally(() => { if (!lifetime.signal.aborted) desktopLoading = false; });
		}
		let unsubscribe = () => {};
		if (isTauri()) {
			try {
				unsubscribe = subscribePreferences(window, () => {
					if (!nativePreferencesReady) {
						nativePreferencesReloadPending = true;
						return;
					}
					queueNativePreferenceRead(preferencesRevision);
				});
			} catch {
				// Native persistence remains available if the compatibility storage is blocked.
			}
			const initialPreferenceRevision = preferencesRevision;
			let legacyRecord: Readonly<Record<string, string>> = {};
			try { legacyRecord = legacyPreferenceRecord(window.localStorage); } catch { /* native settings can still be read */ }
			void nativePreferences.importLegacy(legacyRecord).then((result) => {
				if (lifetime.signal.aborted || preferencesRevision !== initialPreferenceRevision) return;
				preferences = result.preferences;
				preferencesNoticeState = nativeImportNotice(result);
			}).catch(() => {
				if (!lifetime.signal.aborted && preferencesRevision === initialPreferenceRevision) {
					preferencesNoticeState = ['無法讀取已保存的設定，目前使用預設值。', 'Saved settings could not be read. Using defaults.'];
				}
			}).finally(() => {
				if (!lifetime.signal.aborted) finishNativePreferenceInitialization();
			});
		} else {
			try {
				const saved = readPreferences(window.localStorage); preferences = saved.preferences;
				if (saved.invalid) preferencesNoticeState = ['部分設定無法讀取，已使用預設值。', 'Some settings could not be read and were reset to defaults.'];
				unsubscribe = subscribePreferences(window, (value, invalid) => {
					preferences = value;
					preferencesNoticeState = invalid ? ['部分設定無法讀取，已使用預設值。', 'Some settings could not be read and were reset to defaults.'] : null;
				});
			} catch { preferencesNoticeState = ['無法讀取已保存的設定，目前使用預設值。', 'Saved settings could not be read. Using defaults.']; }
		}
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const systemTheme = () => { systemDark = media.matches; }; systemTheme(); media.addEventListener('change', systemTheme);
		const routes = () => {
			const hash = window.location.hash;
			showLimitations = hash === '#/release-notes/limitations';
			selectedHelp = helpTopic(hash);
			route = hash === '#/help' || hash.startsWith('#/help/') ? 'help' : hash === '#/compile-settings' ? 'compile-settings' : hash === '#/settings' ? 'settings' : hash === '#/release-notes' || showLimitations ? 'release-notes' : hash === '#/workbench' || hash === '#/workspace' ? 'workbench' : 'home';
		}; routes(); window.addEventListener('hashchange', routes);
		const warn = (event: BeforeUnloadEvent) => {
			if (closeIsConfirmedForCurrentSource() || !dirty || !source) return;
			event.preventDefault();
			event.returnValue = '';
			if (!hasDesktopBridge) return;
			// The close dialog is already bundled; no network request can strand this hold.
			showCloseDialog = true;
		};
		window.addEventListener('beforeunload', warn);
		rootStateReady = true;
		return () => {
			closeRegistrationDisposed = true;
			const stopCloseListener = unlistenCloseRequested;
			unlistenCloseRequested = null;
			if (stopCloseListener) {
				try { stopCloseListener(); } catch { /* disposal must not interrupt App teardown */ }
			}
			rootStateDisposed = true;
			window.removeEventListener('beforeunload', warn); window.removeEventListener('hashchange', routes);
			media.removeEventListener('change', systemTheme); unsubscribe();
			if (previousTheme === undefined) delete root.dataset.theme; else root.dataset.theme = previousTheme;
			if (previousLanguage === null) root.removeAttribute('lang'); else root.setAttribute('lang', previousLanguage);
		};
	});
	async function allowReplacement(): Promise<boolean> {
		if (saving || opening || confirming) return false;
		if (!dirty) return true;
		confirming = true;
		try {
			if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
			const prompt = t(
				'編輯內容尚未儲存至磁碟。要捨棄變更並切換文件嗎？',
				'Edits are not saved to disk. Discard changes and switch documents?'
			);
			const result = await window.confirm(prompt);
			if (lifetime.signal.aborted) return false;
			return Boolean(result);
		} catch {
			if (!lifetime.signal.aborted) {
				errorState = [
					'無法確認是否捨棄變更，已保留目前編輯內容。',
					'Unable to confirm discarding changes. Current edits preserved.'
				];
			}
			return false;
		} finally {
			confirming = false;
		}
	}
	function cancelClose() {
		showCloseDialog = false;
	}
	function closeIsConfirmedForCurrentSource(): boolean {
		if (!closeConfirmed) return false;
		if (source === closeConfirmedSource && source?.version === closeConfirmedVersion) return true;
		closeConfirmed = false;
		closeConfirmedSource = null;
		closeConfirmedVersion = null;
		return false;
	}
	function reportNativeCloseProtectionFailure() {
		if (lifetime.signal.aborted) return;
		errorState = [
			'無法啟用原生關閉保護，請先保存文件後重新啟動程式。',
			'Native close protection could not be enabled. Save your document and restart the app.'
		];
	}
	async function discardAndClose() {
		if (saving || opening || !source) return;
		const snapshot = source;
		if (compiling) {
			abandonCompile();
		}
		showCloseDialog = false;
		closeConfirmed = true;
		closeConfirmedSource = snapshot;
		closeConfirmedVersion = snapshot.version;
		try {
			if (isTauri()) await getCurrentWindow().close();
			else window.close();
		} catch {
			closeConfirmed = false;
			closeConfirmedSource = null;
			closeConfirmedVersion = null;
			if (!lifetime.signal.aborted) {
				showCloseDialog = !!source && dirty;
				errorState = ['無法關閉程式，文件仍保留。請稍後再試。', 'Unable to close the app. Your document is preserved. Please try again.'];
			}
		}
	}
	async function saveAndClose() {
		if (!source || saving || opening) return;
		const snapshot = source;
		if (compiling) {
			abandonCompile();
		}
		await saveSource();
		if (dirty || source !== snapshot || source?.version !== snapshot.version ||
			savedVersion !== snapshot.version || lifetime.signal.aborted) {
			return;
		}
		showCloseDialog = false;
		closeConfirmed = true;
		closeConfirmedSource = snapshot;
		closeConfirmedVersion = snapshot.version;
		try {
			if (isTauri()) await getCurrentWindow().close();
			else window.close();
		} catch {
			closeConfirmed = false;
			closeConfirmedSource = null;
			closeConfirmedVersion = null;
			if (!lifetime.signal.aborted) {
				showCloseDialog = !!source && dirty;
				errorState = ['無法關閉程式，文件仍保留。請稍後再試。', 'Unable to close the app. Your document is preserved. Please try again.'];
			}
		}
	}
	function abandonCompile() {
		++compileTicket;
		compileCancellationRequestedFor = null;
		compileCancellationFailedFor = null;
		if (compileHandle) void compileHandle.cancel().catch(() => {});
		compiling = false; compileHandle = null; compileNoticeState = null; compileLog = '';
		diagnostics = []; diagnosticIdentity = null;
		diagnosticNavigation = null;
	}
	async function readDesktopFile(path: string, owner: WorkspaceInfo, manageBusy = true) {
		if (!desktop) return;
		if (manageBusy && (opening || confirming)) return;
		const pdf = path.toLowerCase().endsWith('.pdf');
		if (manageBusy && !pdf) {
			const previous = source;
			const previousVersion = previous?.version;
			const previousRevision = revision;
			if (!await allowReplacement()) return;
			if (lifetime.signal.aborted || workspace !== owner ||
				source !== previous || source?.version !== previousVersion || revision !== previousRevision) return;
		}
		if (!pdf) abandonCompile();
		const ticket = pdf ? ++pdfTicket : ++sourceTicket;
		if (manageBusy) opening = true;
		errorState = null;
		try {
			const receipt = await desktop.readFile({ workspaceId: owner.id, path });
			if (workspace !== owner || ticket !== (pdf ? pdfTicket : sourceTicket)) return;
			installDesktopReadReceipt(path, receipt);
		} catch (value) {
			if (workspace === owner && ticket === (pdf ? pdfTicket : sourceTicket)) errorState = fileErrorDescriptor(value);
		} finally {
			if (manageBusy && workspace === owner && ticket === (pdf ? pdfTicket : sourceTicket)) {
				opening = false;
				void drainWorkspaceWatch();
			}
		}
	}
	function installDesktopReadReceipt(path: string, receipt: ReadReceipt): { readonly source: boolean } {
		const pdf = path.toLowerCase().endsWith('.pdf');
		if (pdf) {
			draftPanelOpen = false;
			if (new TextDecoder('ascii').decode(receipt.bytes.subarray(0, 5)) !== '%PDF-') {
				throw new Error('PDF_HEADER');
			}
			pdfBytes = receipt.bytes;
			pdfIdentity = null;
			pdfName = path;
			pageCount = 0;
			synctexIndex?.dispose();
			synctexIndex = null;
			pdfReveal = undefined;
			workbenchPane = 'pdf';
		} else {
			draftSelectionSnapshot = null;
			draftSelectionWarning = null;
			const document = readSourceBytes(receipt.bytes);
			source = document;
			outlineFailed = false;
			sourceName = path;
			revision = receipt.revision;
			savedVersion = null;
			hasDiskCheckpoint = true;
			dirty = false;
			externalFileNotice = null;
			workbenchPane = 'document';
		}
		route = 'workbench';
		window.location.hash = '#/workbench';
		return { source: !pdf };
	}
	async function chooseSource(kind: 'file' | 'folder' = 'file', recentId?: string) {
		if (opening || saving || confirming) return;
		const previous = source, owner = workspace;
		const previousVersion = previous?.version;
		const previousRevision = revision;
		if (!await allowReplacement()) return;
		if (lifetime.signal.aborted || opening || saving ||
			source !== previous || workspace !== owner ||
			source?.version !== previousVersion || revision !== previousRevision) return;
		if (!desktop) { sourceInput.click(); return; }
		opening = true;
		errorState = null;
		try {
			const selected = recentId ? await desktop.openRecent(recentId) : await desktop.openWorkspace(kind);
			if (!selected) return;
			draftPanelOpen = false;
			stopWorkspaceWatch();
			workspaceWatchIssue = null;
			externalFileNotice = null;
			abandonCompile();
			selectWorkspace(selected);
			++sourceTicket; ++pdfTicket;
			source = null; sourceName = ''; dirty = false; revision = null; savedVersion = null; pdfBytes = null; pdfIdentity = null; pdfName = ''; pageCount = 0; entries = [];
			if (selected.entryPath) {
				entries = [{ path: selected.entryPath, kind: 'file' }];
				await readDesktopFile(selected.entryPath, selected, false);
			}
			await refreshWorkspaceEntries(selected, workspaceGeneration);
		} catch (value) { if (!lifetime.signal.aborted) errorState = fileErrorDescriptor(value); }
		finally {
			if (!lifetime.signal.aborted) {
				opening = false;
				void refreshRecent();
				void drainWorkspaceWatch();
			}
		}
	}
	async function openSource(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (opening || saving || confirming) { sourceInput.value = ''; return; }
		const previous = source, owner = workspace;
		const previousVersion = previous?.version;
		const previousRevision = revision;
		if (!await allowReplacement()) { sourceInput.value = ''; return; }
		if (lifetime.signal.aborted || opening || saving ||
			source !== previous || workspace !== owner ||
			source?.version !== previousVersion || revision !== previousRevision) {
			sourceInput.value = '';
			return;
		}
		const ticket = ++sourceTicket;
		opening = true;
		errorState = null;
		try {
			const document = await readSource(file);
			if (ticket === sourceTicket) {
				draftPanelOpen = false;
				draftSelectionSnapshot = null;
				draftSelectionWarning = null;
				diagnosticNavigation = null;
				source = document; outlineFailed = false;
				sourceName = file.name;
				revision = null; savedVersion = null;
				hasDiskCheckpoint = true;
				dirty = false;
				externalFileNotice = null;
				window.location.hash = '#/workbench';
			}
		} catch (value) {
			if (ticket === sourceTicket)
				errorState = fileErrorDescriptor(value);
		} finally {
			if (ticket === sourceTicket) {
				opening = false;
				void drainWorkspaceWatch();
			}
			sourceInput.value = '';
		}
	}
	async function saveSource() {
		if (!desktop || !source || saving || opening || sourceMissingOnDisk()) return;
		if (!revision || !workspace) { await saveSourceAs(); return; }
		const snapshot = source;
		const owner = workspace;
		const path = sourceName;
		saving = true; errorState = null;
		try {
			const receipt = await desktop.writeFile({ workspaceId: owner.id, path, bytes: snapshot.toBytes(),
				expectedRevision: revision, documentId: snapshot.documentId, documentVersion: snapshot.version });
			if (workspace === owner && source?.documentId === snapshot.documentId) {
				if (receipt.revision !== revision) invalidateSynctexForSourceChange(path, receipt.revision);
				revision = receipt.revision;
				if (source.version === snapshot.version) {
					savedVersion = snapshot.version;
					dirty = false;
				}
			}
		} catch (value) { if (!lifetime.signal.aborted && workspace === owner) errorState = fileErrorDescriptor(value); }
		finally {
			if (!lifetime.signal.aborted) {
				saving = false;
				void drainWorkspaceWatch();
			}
		}
	}
	function updateOperationBusy(): boolean {
		return opening || saving || compiling || confirming || draftPanelOpen;
	}
	function canInstallUpdate(): boolean {
		return rootStateReady && !lifetime.signal.aborted && !dirty && !updateOperationBusy();
	}
	async function prepareUpdateInstall(): Promise<boolean> {
		if (!rootStateReady || lifetime.signal.aborted || updateOperationBusy()) return false;
		let savedSnapshotIsCurrent = true;
		if (dirty) {
			const snapshot = source;
			if (!snapshot) return false;
			const documentId = snapshot.documentId;
			const version = snapshot.version;
			await saveSource();
			if (lifetime.signal.aborted) return false;
			await tick();
			savedSnapshotIsCurrent = source === snapshot &&
				snapshot.documentId === documentId &&
				snapshot.version === version &&
				savedVersion === version &&
				revision !== null &&
				!dirty;
		}
		const canInstallNow = canInstallUpdate();
		return savedSnapshotIsCurrent && canInstallNow;
	}
	async function saveSourceForDraft(): Promise<boolean> {
		const port = desktop;
		const snapshot = source;
		const owner = workspace;
		const path = sourceName;
		if (!port || !snapshot || !owner || !revision ||
			!path.toLowerCase().endsWith('.tex') ||
			opening || saving || confirming || compiling || sourceMissingOnDisk()) return false;
		const version = snapshot.version;
		await saveSource();
		if (lifetime.signal.aborted) return false;
		await tick();
		return desktop === port && workspace === owner && source === snapshot &&
			source.documentId === snapshot.documentId && source.version === version &&
			sourceName === path && revision !== null && savedVersion === version &&
			!dirty && !sourceMissingOnDisk();
	}
	async function saveSourceAs() {
		if (!desktop || !source || saving || opening || compiling) return;
		const snapshot = source, owner = workspace;
		saving = true; errorState = null;
		try {
			const images = snapshot.read().includes('modutex-image-') ? await (await import('./features/images/store.ts')).saveAsImages({ desktop, workspaceId: owner?.id ?? null, path: sourceName, documentId: snapshot.documentId, documentVersion: snapshot.version }, snapshot) : [];
			const result = await desktop.saveAs({ workspaceId: owner?.id ?? null, bytes: snapshot.toBytes(),
				documentId: snapshot.documentId, documentVersion: snapshot.version, ...(images.length ? { images } : {}) });
			if (!result) return;
			if (lifetime.signal.aborted || workspace !== owner || source !== snapshot) {
				if (activeWorkspaceWatch?.owner === owner) stopWorkspaceWatch(activeWorkspaceWatch);
				await desktop.closeWorkspace(result.workspace.id); return;
			}
			if (activeWorkspaceWatch?.owner === owner) stopWorkspaceWatch(activeWorkspaceWatch);
			// Keep the editor's source snapshot and history; only its disk checkpoint changes.
			abandonCompile(); ++sourceTicket; ++pdfTicket;
			selectWorkspace(result.workspace); sourceName = result.write.path; revision = result.write.revision;
			externalFileNotice = null;
			workspaceWatchIssue = null;
			void refreshRecent();
			savedVersion = snapshot.version; hasDiskCheckpoint = true; dirty = false;
			entries = [{ path: sourceName, kind: 'file' }];
			// A previous preview belongs to the former workspace, even if the filename matches.
			if (pdfIdentity) {
				pdfBytes = null;
				pdfIdentity = null;
				pdfName = '';
				pageCount = 0;
				synctexIndex?.dispose();
				synctexIndex = null;
				pdfReveal = undefined;
			}
			const selected = result.workspace;
			await refreshWorkspaceEntries(selected, workspaceGeneration);
		} catch (value) {
			if (!lifetime.signal.aborted && workspace === owner) errorState = fileErrorDescriptor(value);
		} finally {
			if (!lifetime.signal.aborted) {
				saving = false;
				void drainWorkspaceWatch();
			}
		}
	}
	async function newDocument(template: TemplateId) {
		if (opening || saving || compiling || confirming) return;
		const previous = source, owner = workspace;
		const previousVersion = previous?.version;
		const previousRevision = revision;
		if (!await allowReplacement()) return;
		if (lifetime.signal.aborted || opening || saving || compiling ||
			source !== previous || workspace !== owner ||
			source?.version !== previousVersion || revision !== previousRevision) return;
		opening = true; errorState = null;
		try {
			const { createDraft } = await import('./features/files/templates.ts');
			const draft = createDraft(template);
			if (lifetime.signal.aborted || source !== previous || workspace !== owner ||
				source?.version !== previousVersion || revision !== previousRevision) return;
			if (desktop && owner) {
				if (activeWorkspaceWatch?.owner === owner) stopWorkspaceWatch(activeWorkspaceWatch);
				await desktop.closeWorkspace(owner.id);
			}
			if (lifetime.signal.aborted || source !== previous || workspace !== owner ||
				source?.version !== previousVersion || revision !== previousRevision) return;
			abandonCompile(); ++sourceTicket; ++pdfTicket;
			draftPanelOpen = false;
			draftSelectionSnapshot = null;
			draftSelectionWarning = null;
			selectWorkspace(null); entries = []; source = draft; sourceName = 'untitled.tex';
			externalFileNotice = null; workspaceWatchIssue = null;
			projection = null; outline = []; outlineOwner = ''; outlineFailed = false; navigation = null;
			revision = null; savedVersion = null; hasDiskCheckpoint = false; dirty = true;
			pdfBytes = null; pdfIdentity = null; pdfName = ''; pageCount = 0;
			window.location.hash = '#/workbench';
		} catch {
			if (!lifetime.signal.aborted) {
				errorState = ['無法建立文件，原編輯內容已保留。請稍後再試。', 'Unable to create document. Previous edits are preserved. Try again shortly.'];
				if (owner && workspace === owner && !activeWorkspaceWatch) startWorkspaceWatch(owner);
			}
		}
		finally {
			if (!lifetime.signal.aborted) {
				opening = false;
				void drainWorkspaceWatch();
			}
		}
	}
	async function openFromHome(kind: 'file' | 'folder') {
		await chooseSource(kind);
		if (!lifetime.signal.aborted && (workspace || source)) window.location.hash = '#/workbench';
	}
	async function openRecent(id: string) {
		await chooseSource('file', id);
		if (!lifetime.signal.aborted && (workspace || source)) window.location.hash = '#/workbench';
	}
	async function openNewWindow() {
		if (!isTauri() || openingWindow) return;
		openingWindow = true;
		try {
			await invoke('frontend_new_window');
		} catch (value) {
			if (!lifetime.signal.aborted) {
				const message = value instanceof Error
					? value.message
					: typeof value === 'string'
						? value
						: value && typeof value === 'object' && 'message' in value && typeof (value as { message: unknown }).message === 'string'
							? (value as { message: string }).message
							: value
								? String(value)
								: '';
				errorState = message ? { raw: message } : ['無法開啟新視窗。', 'Unable to open new window.'];
			}
		} finally {
			if (!lifetime.signal.aborted) openingWindow = false;
		}
	}
	async function compileSource() {
		const port = desktop;
		if (!port || !source || compiling || saving || opening || sourceMissingOnDisk()) return;
		draftPanelOpen = false;
		let owner = workspace;
		if (!owner) {
			errorState = ['請先開啟已儲存的工作區文件。', 'Open a saved workspace document first.'];
			return;
		}
		let config;
		try {
			config = await port.getCompileConfig(owner.id);
		} catch (value) {
			if (!lifetime.signal.aborted) errorState = fileErrorDescriptor(value);
			return;
		}
		if (lifetime.signal.aborted || desktop !== port || workspace !== owner) return;
		const path = config.mainFile ?? (
			sourceName?.toLowerCase().endsWith('.tex') ? sourceName : null
		);
		if (!path) {
			errorState = ['請開啟 TeX 文件或在編譯設定中選擇主文件。', 'Open a TeX file or choose a main file in Compile settings.'];
			return;
		}
		if (!revision || dirty) await saveSource();
		if (desktop !== port || lifetime.signal.aborted || !workspace || saving || opening || compiling) return;
		if (workspace !== owner) return;
		if (!source || !sourceName || !revision || dirty || sourceMissingOnDisk() ||
			saving || opening || compiling) return;
		if (config.profile === 'custom' && !config.canSetCommand) {
			errorState = ['自訂編譯命令權限已停用。', 'Custom compile command permission is disabled.'];
			return;
		}
		const snapshot = source;
		const editorPath = sourceName;
		const editorRevision = revision;
		let compileRevision: string;
		try {
			compileRevision = (await port.readFile({ workspaceId: owner.id, path })).revision;
		} catch (value) {
			if (!lifetime.signal.aborted && workspace === owner && desktop === port) {
				errorState = fileErrorDescriptor(value);
			}
			return;
		}
		if (lifetime.signal.aborted || desktop !== port || workspace !== owner) return;
		const editorSnapshotIsCurrent = () =>
			!lifetime.signal.aborted &&
			desktop === port &&
			workspace === owner &&
			source === snapshot &&
			sourceName === editorPath &&
			revision === editorRevision &&
			!dirty &&
			!saving &&
			!opening &&
			!sourceMissingOnDisk() &&
			compileSnapshotIsCurrent(snapshot, owner, editorPath, editorRevision);
		if (
			(path === editorPath && compileRevision !== editorRevision) ||
			!editorSnapshotIsCurrent()
		) {
			compileNoticeState = ['文件已變更，請重新編譯。', 'The document changed. Please compile again.'];
			return;
		}
		const compileInputsAreCurrent = async () => {
			if (!editorSnapshotIsCurrent()) return false;
			try {
				const currentMain = await port.readFile({ workspaceId: owner.id, path });
				return currentMain.revision === compileRevision && editorSnapshotIsCurrent();
			} catch {
				return false;
			}
		};
		const own = ++compileTicket;
		const previewTicket = pdfTicket;
		compileCancellationRequestedFor = null;
		compileCancellationFailedFor = null;
		compiling = true;
		errorState = null;
		compileNoticeState = null;
		compileLog = '';
		showCompileDetails = false;
		diagnostics = [];
		diagnosticIdentity = null;
		let handleReturned = false;
		try {
			const handle = await port.compile({
				workspaceId: owner.id,
				entryPath: path,
				documentId: snapshot.documentId,
				documentVersion: snapshot.version,
				savedRevision: compileRevision,
				engine: config.engine
			});
			handleReturned = true;
			if (own !== compileTicket || workspace !== owner || desktop !== port) {
				await handle.cancel();
				return;
			}
			compileHandle = handle;
			if (compileCancellationRequestedFor === own) {
				try { await handle.cancel(); }
				catch { noteCompileCancellationFailure(own); }
			}
			if (own !== compileTicket || workspace !== owner || desktop !== port) return;
			const result = await handle.finished;
			if (own !== compileTicket || workspace !== owner || desktop !== port) return;
			if (compileCancellationRequestedFor === own) {
				if (compileCancellationFailedFor !== own) {
					compileNoticeState = result.status === 'cancelled'
						? ['編譯已取消', 'Compilation cancelled']
						: ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
				}
				return;
			}
			const inputsCurrent = await compileInputsAreCurrent();
			if (own !== compileTicket || workspace !== owner || desktop !== port || lifetime.signal.aborted) return;
			if (compileCancellationRequestedFor === own) {
				if (compileCancellationFailedFor !== own) {
					compileNoticeState = result.status === 'cancelled'
						? ['編譯已取消', 'Compilation cancelled']
						: ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
				}
				return;
			}
			if (!inputsCurrent) {
				compileNoticeState = ['文件已變更，本次編譯結果未載入。請重新編譯。', 'The document changed, so this compile result was not loaded. Please compile again.'];
				return;
			}
			compileLog = result.log;
			diagnostics = result.diagnostics;
			diagnosticIdentity = result.identity;
			if (result.status === 'cancelled') {
				compileNoticeState = ['編譯已取消', 'Compilation cancelled'];
				return;
			}
			if (result.status === 'failure') {
				showCompileDetails = true;
				if (!compileLog && !diagnostics.length) {
					compileLog = t('編譯器回報失敗，但未提供記錄。請重試；若仍失敗，請檢查編譯引擎。', 'The compiler reported failure without a log. Retry; if it fails again, check the compile engine.');
				}
				const diag = result.diagnostics[0]?.message;
				errorState = diag ? { raw: diag } : compileErrorDescriptor(new Error('COMPILE_FAILED'));
				compileNoticeState = ['編譯失敗。請檢查編譯問題或 TeX 記錄，修正後重新編譯。', 'Compilation failed. Review the problems or TeX log, then compile again.'];
				workbenchPane = 'document';
				return;
			}
			if (result.status !== 'success') return;
			if (pdfTicket !== previewTicket) {
				compileNoticeState = ['文件或預覽已變更，請重新編譯。', 'Document or preview has changed. Please compile again.'];
				return;
			}
			pdfReveal = undefined;
			pdfBytes = result.pdf;
			pdfName = path.replace(/\.tex$/i, '.pdf');
			pageCount = 0;
			pdfIdentity = result.identity;
			compileNoticeState = ['編譯完成', 'Compilation completed'];
			workbenchPane = 'pdf';

			let newSynctex: BoundSynctexIndex | null = null;
			if (desktop?.takeCompileSynctex) {
				try {
					const bytes = await desktop.takeCompileSynctex(result.identity);
					if (bytes) {
						if (own === compileTicket && workspace === owner && desktop === port && !lifetime.signal.aborted) {
							newSynctex = new BoundSynctexIndex(result.identity, bytes);
						} else {
							bytes.fill(0);
						}
					}
				} catch {
					newSynctex = null;
					if (own === compileTicket && workspace === owner && desktop === port && !lifetime.signal.aborted) {
						compileNoticeState = ['PDF 已顯示，但無法建立 SyncTeX 對應。', 'The PDF is shown, but SyncTeX mappings could not be loaded.'];
					}
				}
			}
			if (own !== compileTicket || workspace !== owner || desktop !== port || lifetime.signal.aborted) {
				newSynctex?.dispose();
				return;
			}
			synctexIndex?.dispose();
			synctexIndex = newSynctex;
		} catch (value) {
			if (own === compileTicket && workspace === owner && desktop === port) {
				if (handleReturned && compileCancellationRequestedFor === own) {
					if (compileCancellationFailedFor !== own) {
						compileNoticeState = ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
					}
				} else {
					const inputsCurrent = await compileInputsAreCurrent();
					if (own !== compileTicket || workspace !== owner || desktop !== port || lifetime.signal.aborted) return;
					if (handleReturned && compileCancellationRequestedFor === own) {
						if (compileCancellationFailedFor !== own) {
							compileNoticeState = ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
						}
					} else if (!inputsCurrent) {
						compileNoticeState = ['文件已變更，本次編譯結果未載入。請重新編譯。', 'The document changed, so this compile result was not loaded. Please compile again.'];
					} else {
						errorState = compileErrorDescriptor(value);
						const reason = value instanceof Error ? value.message : typeof value === 'string' ? value : t('未取得失敗詳細資料。', 'No failure details were returned.');
						compileLog = [handleReturned ? t('編譯執行失敗', 'Compilation execution failed') : t('編譯啟動前檢查失敗', 'Compilation preflight failed'), path, t(...compileErrorDescriptor(value)), reason].join('\n').slice(0, 256 * 1024);
						showCompileDetails = true;
						compileNoticeState = ['編譯失敗，請查看錯誤訊息。', 'Compilation failed. Review the error message.'];
					}
				}
			}
		} finally {
			if (own === compileTicket) {
				compiling = false;
				compileHandle = null;
				if (compileCancellationRequestedFor === own) compileCancellationRequestedFor = null;
				if (compileCancellationFailedFor === own) compileCancellationFailedFor = null;
			}
		}
	}
	async function cancelCompile() {
		if (!compiling || compileCancellationRequestedFor === compileTicket) return;
		const own = compileTicket;
		compileCancellationRequestedFor = own;
		const handle = compileHandle;
		if (!handle) return;
		try { await handle.cancel(); }
		catch { noteCompileCancellationFailure(own); }
	}
function compileSnapshotIsCurrent(
		snapshot: SourceDocument,
		owner: WorkspaceInfo,
		path: string,
		savedRevision: string
	): boolean {
		const current = source;
		return workspace === owner && current !== null && current === snapshot &&
			current.documentId === snapshot.documentId && current.version === snapshot.version &&
			sourceName === path && revision === savedRevision;
	}
	function noteCompileCancellationFailure(ticket: number) {
		if (ticket !== compileTicket || compileCancellationRequestedFor !== ticket) return;
		compileCancellationFailedFor = ticket;
		errorState = ['無法取消編譯。請等待目前執行完成。', 'Unable to cancel compilation. Wait for the current run to finish.'];
	}
	async function goToDiagnostic(diagnostic: Diagnostic) {
		if (!source || !diagnosticIdentity || saving || opening) return;
		const owner = source, identity = diagnosticIdentity, path = sourceName, sequence = ++navigationSequence;
		const helper = await import('./features/compile/diagnostic-span.ts').catch(() => null);
		if (source !== owner || diagnosticIdentity !== identity || sourceName !== path || saving || opening || sequence !== navigationSequence) return;
		const span = helper?.diagnosticSpan(owner, path, identity, diagnostic);
		if (span) { route = 'workbench'; workbenchPane = 'document'; window.location.hash = '#/workbench'; navigation = { span, sequence: ++navigationSequence, sourceOnly: true }; }
		else errorState = ['錯誤位置已無法對應此文件，請查看編譯記錄。', 'Error location can no longer be mapped to this document. See compilation log.'];
	}
	function hasDiagnosticLocation(diagnostic: Diagnostic): diagnostic is LineDiagnostic {
		return diagnostic.path !== null && diagnostic.line !== null &&
			Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0;
	}
	function safeWorkspaceDiagnosticPath(path: string): string | null {
		if (!path || path.trim() === '' || /[\u0000-\u001f\u007f-\u009f]/.test(path) ||
			path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.includes(':')) return null;
		const segments = path.split(/[\\/]/);
		const normalized: string[] = [];
		for (const segment of segments) {
			if (!segment) return null;
			if (segment === '.') continue;
			if (segment === '..') return null;
			const windowsSegment = segment.replace(/[ .]+$/g, '');
			if (!windowsSegment || windowsSegment === '.' || windowsSegment === '..') return null;
			normalized.push(segment);
		}
		return normalized.length ? normalized.join('/') : null;
	}
	function captureDiagnosticContext(): DiagnosticContext | null {
		const identity = diagnosticIdentity;
		const owner = workspace;
		const current = source;
		const currentRevision = revision;
		if (!desktop || lifetime.signal.aborted || opening || saving || compiling ||
			!identity || !owner || !current || !currentRevision ||
			identity.workspaceId !== owner.id || identity.entryPath !== sourceName ||
			identity.documentId !== current.documentId || identity.documentVersion !== current.version ||
			identity.savedRevision !== currentRevision) return null;
		return { identity, owner, source: current, sourceName, revision: currentRevision };
	}
	function diagnosticContextIsCurrent(context: DiagnosticContext, ticket?: number): boolean {
		const owner = workspace;
		const current = source;
		if (lifetime.signal.aborted || !desktop || !owner || owner !== context.owner ||
			owner.id !== context.identity.workspaceId || !current || current !== context.source ||
			current.documentId !== context.identity.documentId ||
			current.version !== context.identity.documentVersion ||
			sourceName !== context.sourceName || context.identity.entryPath !== context.sourceName ||
			revision !== context.revision || context.identity.savedRevision !== context.revision ||
			diagnosticIdentity !== context.identity) return false;
		return ticket === undefined || ticket === sourceTicket;
	}
	function canNavigateDiagnostic(diagnostic: Diagnostic): boolean {
		if (!hasDiagnosticLocation(diagnostic)) return false;
		const context = captureDiagnosticContext();
		return !!context &&
			safeWorkspaceDiagnosticPath(diagnostic.path) !== null &&
			safeWorkspaceDiagnosticPath(context.sourceName) !== null;
	}
	function navigateToDiagnostic(diagnostic: Diagnostic) {
		if (opening || saving) return;
		if (!hasDiagnosticLocation(diagnostic)) {
			errorState = ['錯誤位置已無法對應此文件，請查看編譯記錄。', 'Error location can no longer be mapped to this document. See compilation log.'];
			return;
		}
		const context = captureDiagnosticContext();
		const targetPath = safeWorkspaceDiagnosticPath(diagnostic.path);
		const currentPath = context ? safeWorkspaceDiagnosticPath(context.sourceName) : null;
		if (!context || !targetPath || !currentPath) {
			errorState = ['錯誤位置已無法對應此文件，請查看編譯記錄。', 'Error location can no longer be mapped to this document. See compilation log.'];
			return;
		}
		if (targetPath === currentPath) {
			goToDiagnostic(diagnostic);
			return;
		}
		void openIncludedDiagnostic(diagnostic, context, targetPath);
	}
	async function openIncludedDiagnostic(diagnostic: LineDiagnostic, context: DiagnosticContext, path: string) {
		const port = desktop;
		if (!port || opening || saving || confirming || !diagnosticContextIsCurrent(context)) return;
		if (!await allowReplacement()) {
			errorState = ['已取消切換至診斷文件，草稿已保留。', 'Switching to the diagnostic file was cancelled. Your draft was preserved.'];
			return;
		}
		if (!diagnosticContextIsCurrent(context)) return;
		const ticket = ++sourceTicket;
		opening = true;
		errorState = null;
		try {
			const receipt = await port.readFile({ workspaceId: context.owner.id, path });
			if (!diagnosticContextIsCurrent(context, ticket)) return;
			const reloaded = readSourceBytes(receipt.bytes);
			if (!diagnosticContextIsCurrent(context, ticket)) return;
			acceptDiskSource(reloaded, path, receipt.revision);
			diagnosticNavigation = {
				location: { line: diagnostic.line, utf16Column: null },
				documentId: reloaded.documentId,
				documentVersion: reloaded.version,
				sequence: ++diagnosticNavigationSequence
			};
			workbenchPane = 'document';
			route = 'workbench';
			window.location.hash = '#/workbench';
		} catch (value) {
			if (ticket === sourceTicket && diagnosticContextIsCurrent(context, ticket)) {
				errorState = fileErrorDescriptor(value);
			}
		} finally {
			if (!lifetime.signal.aborted && ticket === sourceTicket) {
				opening = false;
				void drainWorkspaceWatch();
			}
		}
	}
	function shortcuts(event: KeyboardEvent) {
		const command = documentCommand(event, preferences.compileShortcut);
		if (!command || lifetime.signal.aborted) return;
		if (command !== 'open' && route !== 'workbench') return;
		event.preventDefault();
		if (opening || saving || confirming) return;
		if (command === 'open') {
			void chooseSource().then(() => {
				if (!lifetime.signal.aborted && (source || workspace)) window.location.hash = '#/workbench';
			});
		} else if (command === 'save') void saveSource();
		else void compileSource();
	}
	async function openPdf(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		const ticket = ++pdfTicket;
		errorState = null;
		try {
			const bytes = await (await import('./features/files/pdf-read.ts')).readPdf(file);
			if (!lifetime.signal.aborted && ticket === pdfTicket) {
				draftPanelOpen = false;
				pdfBytes = bytes;
				pdfIdentity = null;
				pdfName = file.name;
				pageCount = 0;
				synctexIndex?.dispose();
				synctexIndex = null;
				pdfReveal = undefined;
			}
		} catch (value) {
			if (!lifetime.signal.aborted && ticket === pdfTicket) {
				errorState = fileErrorDescriptor(value);
			}
		} finally {
			if (!lifetime.signal.aborted && ticket === pdfTicket) pdfInput.value = '';
		}
	}
</script>

<svelte:head><title>{sourceName ? sourceName + ' — ' : ''}ModuTeX</title></svelte:head>
<svelte:window onkeydown={shortcuts} />
<input class="file-input" bind:this={sourceInput} type="file" accept=".tex" aria-label={t('開啟 TeX 文件', 'Open TeX document')} onchange={openSource} />
<input class="file-input" bind:this={pdfInput} type="file" accept=".pdf" aria-label={t('開啟 PDF 文件', 'Open PDF')} onchange={openPdf} />
<div class="app" lang={preferences.language} style:--source-font-size={`${preferences.sourceFontSize}px`}>
	<header class="global-bar">
		<a class="brand" href="#/">ModuTeX</a>
		<nav aria-label={t('主要導覽', 'Main navigation')}>
			<a href="#/" aria-current={route === 'home' ? 'page' : undefined}>{t('首頁', 'Home')}</a>
			<a href="#/workbench" aria-current={route === 'workbench' ? 'page' : undefined}>{t('工作台', 'Workbench')}</a>
			<a href="#/settings" aria-current={route === 'settings' ? 'page' : undefined}>{t('設定', 'Settings')}</a>
			<a href="#/release-notes" aria-current={route === 'release-notes' ? 'page' : undefined}>{t('版本紀錄', 'Release notes')}</a>
			<a href="#/help" aria-current={route === 'help' ? 'page' : undefined}>{t('說明', 'Help')}</a>
			<a href="#/compile-settings" aria-current={route === 'compile-settings' ? 'page' : undefined}>{t('編譯設定', 'Compile settings')}</a>
			{#if isTauri()}
				<button type="button" class="text-button" onclick={openNewWindow} disabled={openingWindow}>{t('開新視窗', 'New window')}</button>
			{/if}
			{#await import('./components/LanguageMenu.svelte') then { default: LanguageMenu }}<LanguageMenu locale={preferences.language} onChange={language => changePreference('language', language)} />{/await}
		</nav>
		<div class="global-actions" hidden={route !== 'workbench'} inert={desktopLoading}>
			{#if route === 'workbench'}
				{#await import('./components/WorkbenchActions.svelte') then { default: WorkbenchActions }}
					<WorkbenchActions locale={preferences.language} desktop={!!desktop} hasSource={!!source} {opening} {saving} {compiling} {dirty}
						missing={sourceMissingOnDisk()} cancellationPending={compileCancellationRequestedFor === compileTicket}
						onFolder={() => chooseSource('folder')} onOpen={() => chooseSource()} onNew={() => newDocument('blank')}
						onSave={saveSource} onSaveAs={saveSourceAs} onCompile={compileSource} onCancel={cancelCompile} />
				{/await}
			{/if}
		</div>
	</header>
	{#if isTauri() && rootStateReady}
		<UpdateNotice
			language={preferences.language}
			installAllowed={!opening && !saving && !compiling && !confirming && !draftPanelOpen}
			needsSave={dirty}
			busyReason={compiling ? 'compiling' : (opening || saving || confirming || draftPanelOpen ? 'busy' : null)}
			beforeInstall={prepareUpdateInstall}
			canInstall={canInstallUpdate}
		/>
	{/if}
	{#if route === 'workbench' && (compiling || compileNotice)}
		<div class="compile-status" role="status" aria-live="polite">
			{compiling ? t('編譯中…', 'Compiling…') : compileNotice}
			{#if compileLog || diagnostics.length}<button class="text-button" onclick={() => showCompileDetails = !showCompileDetails}>{showCompileDetails ? t('隱藏詳細資料', 'Hide details') : t('查看編譯記錄', 'View compilation log')}</button>{/if}
			{#if !compiling && compileNoticeState?.[1] === 'Compilation completed'}
				 · {pdfDisplayFailed ? t('PDF 無法顯示，請查看錯誤訊息。', 'PDF could not be displayed. Review the error message.') : pdfRendered ? t('PDF 已更新', 'PDF updated') : t('正在顯示 PDF…', 'Displaying PDF…')}
			{/if}
			{#if compiling || compileNoticeState?.[1] === 'Compilation completed' && !pdfRendered && !pdfDisplayFailed}
				<div class="compile-progress" role="progressbar" aria-label={t('編譯進度', 'Compilation progress')}
					aria-valuetext={compiling ? compileCancellationRequestedFor === compileTicket ? t('正在取消編譯', 'Cancelling compilation') : t('編譯中', 'Compiling') : t('正在顯示 PDF', 'Displaying PDF')}><span></span></div>
			{/if}
		</div>
	{/if}
	{#if route === 'home'}{#key homeLoadKey}{#await import('./pages/Home.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟首頁…', 'Loading home…')}</p></main>{:then { default: Home }}<Home locale={preferences.language} desktop={!!desktop} busy={opening || saving || compiling || desktopLoading} currentName={sourceName} {dirty} {recent} {recentNotice} onRecent={openRecent} onRemoveRecent={removeRecent} onOpen={openFromHome} onCreate={newDocument} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入首頁，文件內容已保留。', 'Home could not be loaded. Your document is preserved.')}</p><button onclick={() => homeLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	{#if route === 'compile-settings'}
		{#key settingsLoadKey}
		{#await import('./pages/CompileSettings.svelte')}
			<main class="empty-state" role="status"><p>{t('正在讀取編譯設定…', 'Loading compile settings…')}</p></main>
		{:then { default: CompileSettings }}
			<CompileSettings {desktop} {workspace} {entries} locale={preferences.language} />
		{:catch}
			<main class="empty-state" role="alert"><p>{t('無法載入編譯設定。', 'Compile settings could not be loaded.')}</p><button onclick={() => settingsLoadKey++}>{t('重試', 'Retry')}</button></main>
		{/await}
		{/key}
	{/if}
	{#if route === 'settings'}
		{#key settingsLoadKey}
			{#await import('./pages/Settings.svelte')}
				<main class="empty-state" role="status"><p>{t('正在開啟設定…', 'Loading settings…')}</p></main>
			{:then { default: Settings }}
				<Settings
					{preferences}
					locale={preferences.language}
					notice={preferencesNotice}
					onChange={changePreference}
					onRestore={restoreDefaults}
				/>
			{:catch}
				<main class="empty-state" role="alert"><p>{t('無法載入設定，文件內容已保留。', 'Settings could not be loaded. Your document is preserved.')}</p><button onclick={() => settingsLoadKey++}>{t('重試', 'Retry')}</button></main>
			{/await}
		{/key}
	{/if}
	{#if route === 'release-notes'}{#key releaseLoadKey}{#await import('./pages/ReleaseNotes.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟版本紀錄…', 'Loading release notes…')}</p></main>{:then { default: ReleaseNotes }}<ReleaseNotes locale={preferences.language} {showLimitations} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入版本紀錄，文件內容已保留。', 'Release notes could not be loaded. Your document is preserved.')}</p><button onclick={() => releaseLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	{#if route === 'help'}{#key helpLoadKey}{#await import('./pages/Help.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟說明…', 'Loading help…')}</p></main>{:then { default: Help }}<Help locale={preferences.language} topic={selectedHelp} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入說明，文件內容已保留。', 'Help could not be loaded. Your document is preserved.')}</p><button onclick={() => helpLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	<main class="workbench" hidden={route !== 'workbench'} inert={route !== 'workbench'}>
		{#if externalFileNotice && source && externalFileNotice.documentId === source.documentId && externalFileNotice.path === sourceName}
			<section class="error-strip file-change-notice" data-kind={externalFileNotice.kind}
				role={externalFileNotice.acknowledged ? 'status' : 'alert'} aria-live="polite">
				<span>
					{#if externalFileNotice.kind === 'missing'}
						{externalFileNotice.acknowledged
							? t('磁碟上的文件已刪除。草稿已保留；請另存新檔以儲存。', 'The disk file was deleted. Your draft is kept; use Save as to save it.')
							: t('磁碟上的「' + externalFileNotice.path + '」已刪除。草稿仍保留，不能儲存至原位置。', 'The disk file "' + externalFileNotice.path + '" was deleted. Your draft is preserved and cannot be saved to that path.')}
					{:else}
						{externalFileNotice.acknowledged
							? t('磁碟文件已變更。草稿已保留；如要載入磁碟版本，請重新載入。', 'The disk file changed. Your draft is kept; reload to use the disk version.')
							: t('磁碟上的「' + externalFileNotice.path + '」已變更。草稿仍保留；重新載入會取代草稿。', 'The disk file "' + externalFileNotice.path + '" changed. Your draft is preserved; reloading will replace it.')}
					{/if}
				</span>
				{#if externalFileNotice.kind === 'missing'}
					{#if desktop}<button class="text-button" onclick={saveSourceAs} disabled={opening || saving || compiling}>{t('另存新檔', 'Save as')}</button>{/if}
				{:else}
					<button class="text-button" onclick={reloadExternalSource} disabled={opening || saving}>{t('從磁碟重新載入', 'Reload from disk')}</button>
				{/if}
				{#if !externalFileNotice.acknowledged}
					<button class="text-button" onclick={keepExternalDraft}>{t('保留草稿', 'Keep draft')}</button>
				{/if}
			</section>
		{/if}
		{#if workspaceWatchIssue}
			<section class="error-strip watch-recovery-notice" role="status" aria-live="polite">
				<span>{workspaceWatchIssue === 'reconcile'
					? t('檔案變更尚未完全同步。請重新同步後再繼續。', 'File changes could not be fully synchronized. Reconcile before continuing.')
					: t('無法監看資料夾變更。文件仍可編輯；請重新連線以同步檔案。', 'Folder changes cannot be monitored. You can keep editing; reconnect to sync files.')}</span>
				<button class="text-button" onclick={recoverWorkspaceWatch} disabled={opening || saving}>
					{workspaceWatchIssue === 'reconcile' ? t('重新同步', 'Reconcile now') : t('重新連線', 'Reconnect')}
				</button>
			</section>
		{/if}
		{#if workbenchVisited}
		{#key workbenchLoadKey}
		{#await Promise.all([import('./components/WorkbenchLayout.svelte'), import('./features/source-editor/outline.ts'), import('./features/compile/preview-status.ts')])}
			<div class="empty-state" role="status"><p>{t('正在開啟工作台…', 'Loading workbench…')}</p></div>
		{:then [{ default: WorkbenchLayout }, { sourceOutline }, { previewStatus }]}
		<WorkbenchLayout
			locale={preferences.language}
			bind:activePane={workbenchPane}
			bind:splitRatio={workbenchSplitRatio}
		>
			{#snippet sidebarContent()}
				<aside class="files" aria-label={t('文件與大綱', 'Files and outline')}>
					<section class="explorer-section" aria-label={t('檔案總管', 'Explorer')}>
						<div class="sidebar-heading">
							<span>{t('檔案總管', 'Explorer')}</span>
							<div>
								{#if workspace && workspaceFiles && workspaceFilesAvailability === 'available'}
									<button class="text-button" bind:this={workspaceFilesButton} title={t('工作區檔案操作', 'Workspace file operations')} onclick={openWorkspaceFiles} disabled={opening || saving || compiling}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
								{/if}
								<button class="text-button" title={t('開啟資料夾', 'Open folder')} onclick={() => chooseSource('folder')} disabled={!desktop || opening || saving}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h6l2 2h10v12H3ZM12 11v6m-3-3h6" /></svg></button>
							</div>
						</div>
						<div class="sidebar-scroll">
							{#await import('./components/FileTree.svelte') then { default: FileTree }}
							{#if workspace}
								{@const sidebarOwner = workspace}
								<div class="workspace-name" title={sidebarOwner.label}>{sidebarOwner.label}</div>
								<FileTree {entries} locale={preferences.language} selected={sourceName} disabled={opening || saving || compiling} onOpen={async (path) => { await readDesktopFile(path, sidebarOwner); }} onCompile={async (path) => { await compileWorkspaceFile(path, sidebarOwner); }} />
							{:else if source}
								<FileTree entries={[{ path: sourceName, kind: 'file' }]} selected={sourceName} disabled={true} onOpen={() => {}} />
							{:else}<p class="sidebar-empty">{t('尚未開啟文件', 'No document open')}</p>{/if}
							{/await}
						</div>
					</section>
					<section class="outline-section" aria-label={t('大綱', 'Outline')}>
						<div class="sidebar-heading">{t('大綱', 'Outline')}</div>
						<div class="sidebar-scroll">
						{#if source && outlineOwner === source.documentId && outline.length}
							{#each outline as heading (heading.span.from)}
								<button class="outline-row" style:padding-left={`${16 + heading.level * 12}px`}
									disabled={saving || opening || !projection || !projectionIsCurrent(source, projection)}
									onclick={() => navigation = { span: heading.span, sequence: ++navigationSequence }}>{heading.label}</button>
							{/each}
						{:else}<p class="sidebar-empty">{!source ? t('開啟文件後顯示章節', 'Open a document to view sections') : outlineFailed ? t('大綱暫停更新', 'Outline updates paused') : !projection ? t('正在更新大綱…', 'Updating outline…') : t('此文件沒有章節', 'This document has no sections')}</p>{/if}
						</div>
					</section>
					<GitPanel workspaceId={workspace?.id ?? null} locale={preferences.language} />
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
									onclick={forwardSynctex}
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
							{#key source.documentId + ':' + editorLoadKey}
							{#await import('./features/source-editor/SourceView.svelte')}
								<div class="empty-state" role="status"><p>{t('正在開啟編輯器…', 'Loading editor…')}</p></div>
							{:then { default: SourceView }}
								<SourceView bind:this={sourceViewInstance} document={source} label={sourceName} saving={saving || opening} {savedVersion} active={route === 'workbench' && active}
									viewMode={sourceViewMode} onViewModeChange={setSourceViewMode}
									fontSize={preferences.sourceFontSize} showLineNumbers={preferences.showLineNumbers} wrapLines={preferences.wrapLines}
									locale={preferences.language}
									imageContext={async writing => {
										const owner = source;
										if (writing && desktop && !workspace) await saveSourceAs();
										if (!source || source !== owner || desktop && !workspace) throw new Error('IMAGE_OWNER');
										return { desktop, workspaceId: workspace?.id ?? null, path: sourceName, documentId: source.documentId, documentVersion: source.version };
									}}
									diagnosticNavigation={diagnosticNavigation?.documentId === source.documentId && diagnosticNavigation?.documentVersion === source.version ? diagnosticNavigation : null}
									navigation={navigation?.span.documentId === source.documentId ? navigation : null}
									onChange={handleSourceChange}
								onProjection={(parsed) => { if (source && projectionIsCurrent(source, parsed)) { projection = parsed; outline = sourceOutline(source, parsed); outlineOwner = source.documentId; outlineFailed = false; } }}
								onParserFailure={() => { projection = null; outlineFailed = true; }}
								onVisualRejected={() => { errorState = ['這次編輯未套用，請重新選取內容後再試。', 'This edit was not applied. Select the content again and retry.']; }}
								onRejected={(reason) => { errorState = reason === 'SOURCE_TOO_LARGE' ? ['修改將超過 5 MiB，請減少插入內容。', 'Edit exceeds 5 MiB. Reduce the inserted text.'] : ['這次編輯未套用，請重新選取內容後再試。', 'Edit not applied. Reselect the content and retry.']; }} />
							{:catch}
								<div class="empty-state" role="alert"><p>{t('無法載入編輯器。文件內容已保留。', 'The editor could not be loaded. Your document is preserved.')}</p><button onclick={() => editorLoadKey++}>{t('重試', 'Retry')}</button></div>
							{/await}
							{/key}
						{:else}
							<div class="empty-state">
								<h1>{t('開啟 TeX 文件', 'Open a TeX document')}</h1>
								<p>{t('開啟或新增文件。', 'Open or create a document.')}</p>
								<button onclick={() => chooseSource()} disabled={opening}>{t('選擇文件', 'Choose document')}</button>
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
						<button class="text-button" onclick={() => pdfInput.click()}>{t('開啟 PDF', 'Open PDF')}</button>
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
									locale={preferences.language}
									selection={draftPanelSelection}
									getSelection={captureDraftSelection}
									onSave={saveSourceForDraft}
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
								{#key pdfLoadKey}{#await import('./features/pdf/PdfView.svelte')}
									<div class="empty-state" role="status"><p>{t('正在開啟 PDF 預覽…', 'Loading PDF preview…')}</p></div>
								{:then { default: PdfView }}
								{#key pdfBytes}<PdfView
										bytes={pdfBytes}
										active={route === 'workbench' && active}
										locale={preferences.language}
										reveal={pdfReveal}
										onPoint={handlePdfPoint}
										onPageCount={(count) => (pageCount = count)}
										onRendered={() => { pdfRendered = true; pdfDisplayFailed = false; }}
										onError={(code) => { pdfDisplayFailed = true; errorState = fileErrorDescriptor(new Error(code)); }}
									/>{/key}
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
		{#if desktop && workspace}
			<TerminalPanel workspaceId={workspace.id} locale={preferences.language} />
		{/if}
		{:catch}
			<div class="empty-state" role="alert">
				<p>{t('無法載入工作台，文件內容已保留。', 'Workbench could not be loaded. Your document is preserved.')}</p>
				<button onclick={() => workbenchLoadKey++}>{t('重試', 'Retry')}</button>
			</div>
		{/await}
		{/key}
		{/if}
	</main>
	{#if error}<div class="error-strip" role="alert">{error}<button class="text-button" onclick={() => (errorState = null)}>{t('關閉', 'Close')}</button></div>{/if}
	{#if route === 'workbench' && showCompileDetails && (diagnostics.length || compileLog)}
		<section class="compile-details" aria-label={t('編譯詳細資料', 'Compilation details')}>
		{#await import('./components/CompileFeedback.svelte') then { default: CompileFeedback }}
			<CompileFeedback locale={preferences.language} {diagnostics} {compileLog} expanded={true} {canNavigateDiagnostic} {navigateToDiagnostic} />
		{/await}
		</section>
	{/if}
	<footer class="status-bar" aria-live="polite">
		<span>{opening ? t('讀取中…', 'Reading…') : source ? sourceName + (dirty ? t(' · 未儲存', ' · Unsaved') : '') : t('尚未開啟文件', 'No document open')}</span>
		<span>{compiling
			? compileCancellationRequestedFor === compileTicket
				? t('正在取消編譯…', 'Cancelling compilation…')
				: t('編譯中…', 'Compiling…')
			: compileNotice}</span>
		{#if source && projection && projectionIsCurrent(source, projection) && projection.issues.length}
			<span>{projection.issues.some((issue) => issue.code === 'BUDGET') ? t('文件超出解析上限，可繼續編輯原始碼。', 'Parsing limit reached. You can continue editing the source.') : t('有 ' + projection.issues.length + ' 項語法需檢查。', projection.issues.length + ' syntax issues to review.')}</span>
		{/if}
	</footer>
	{#if workspace && workspaceFiles && (workspaceFilesOpen || workspaceFilesPanelVisited)}
		{@const panelOwner = workspace}
		{@const panelGeneration = workspaceGeneration}
		{#await import('./components/WorkspaceFilesPanel.svelte') then { default: WorkspaceFilesPanel }}
			<WorkspaceFilesPanel
				open={workspaceFilesOpen}
				workspaceId={panelOwner.id}
				workspaceLabel={panelOwner.label}
				scope={panelGeneration}
				files={workspaceFiles}
				{entries}
				selected={sourceName}
				disabled={opening || saving || compiling}
				sourcePath={sourceName}
				sourceDirty={dirty}
				locale={preferences.language}
				onOpen={async (path) => { await readDesktopFile(path, panelOwner); }}
				onCompile={async (path) => { await compileWorkspaceFile(path, panelOwner); }}
				onClose={closeWorkspaceFiles}
				onRefresh={() => refreshWorkspaceEntries(panelOwner, panelGeneration)}
				onEntries={(listed) => setWorkspaceEntriesIfCurrent(panelOwner, panelGeneration, listed)}
				onCapabilityLost={() => disableWorkspaceFilesIfCurrent(panelOwner, panelGeneration)}
				onPathChanged={(prev, next) => reloadWorkspaceSourceAtPath(panelOwner, panelGeneration, prev, next)}
				onSourceRemoved={(path) => detachWorkspaceSourceAfterRemoval(panelOwner, panelGeneration, path)}
			/>
		{/await}
	{/if}
	{#if showCloseDialog && source}
		<CloseDialog {t} name={sourceName} {saving} {error} save={saveAndClose} discard={discardAndClose} cancel={cancelClose} />
	{/if}
</div>
