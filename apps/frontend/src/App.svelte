<script lang="ts">
	import { SourceDocument, projectionIsCurrent, type SourceProjection, type SourceSpan } from '@modutex/document-core';
	import { sourceOutline, type OutlineEntry } from './features/source-editor/outline.ts';
	import { onDestroy, onMount } from 'svelte';
	import { text } from './i18n/text.ts';
	import { documentCommand } from './features/shortcuts/keyboard.ts';
	import { helpTopic, type HelpTopic } from './features/help/topics.ts';
	import { DEFAULT_PREFERENCES, readPreferences, savePreference, restorePreferences, subscribePreferences, decodePreference, effectiveAppearance, type Preferences } from './state/preferences.ts';
	import type { WorkspaceInfo, FileEntry, FileEvent, CompileHandle, CompileIdentity, Diagnostic } from '@modutex/frontend-contracts';
	import { diagnosticSpan, previewStatus } from './features/compile/navigation.ts';
	import type { DiagnosticNavigationRequest } from './features/source-editor/diagnostics.ts';
	import type { FileDesktopPort } from './features/files/desktop.ts';
	import type { RecentDocument } from './features/files/recent.ts';
	import { readSource, readSourceBytes, readPdf } from './features/files/read.ts';
	import type { TemplateId } from './features/files/templates.ts';
	let workbenchPane = $state<'document' | 'pdf'>('document');
	let workbenchSplitRatio = $state(0.5);
	let workbenchVisited = $state(false);
	let workbenchLoadKey = $state(0);
	let source = $state.raw<SourceDocument | null>(null);
	let projection = $state.raw<SourceProjection | null>(null);
	let sourceName = $state('');
	let dirty = $state(false);
	let revision = $state<string | null>(null);
	let saving = $state(false);
	let savedVersion = $state<number | null>(null);
	let hasDiskCheckpoint = $state(true);
	let compiling = $state(false);
	let compileHandle = $state.raw<CompileHandle | null>(null);
	let compileLog = $state('');
	let compileTicket = $state(0);
	let compileCancellationRequestedFor = $state<number | null>(null);
	let compileCancellationFailedFor: number | null = null;
	let diagnostics = $state.raw<readonly Diagnostic[]>([]);
	let diagnosticIdentity = $state.raw<CompileIdentity | null>(null);
	let pdfIdentity = $state.raw<CompileIdentity | null>(null);
	let pdfBytes = $state.raw<Uint8Array | null>(null);
	let pdfName = $state('');
	let pdfLoadKey = $state(0);
	let pageCount = $state(0);
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
	let route = $state<'home' | 'workbench' | 'settings' | 'release-notes' | 'help'>('home');
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
	const t = (zh: string, en: string) => text(preferences.language, zh, en);
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
	type LineDiagnostic = Diagnostic & { readonly path: string; readonly line: number };
	interface WorkspaceWatch {
		readonly owner: WorkspaceInfo;
		readonly pending: Map<string, QueuedWorkspaceEvent>;
		active: boolean;
		terminal: boolean;
		overflowed: boolean;
		recoveryEvents: boolean;
		processing: boolean;
		recovering: boolean;
		unsubscribe: (() => void) | null;
	}
	const MAX_RENDERER_PENDING_WATCH_EVENTS = 128;
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
		let next: Preferences | null = null;
		try {
			next = { ...preferences, [key]: decodePreference(key, value) };
			savePreference(window.localStorage, key, value);
			preferences = readPreferences(window.localStorage).preferences;
			preferencesNoticeState = ['設定已儲存', 'Settings saved'];
		} catch {
			if (next) preferences = next;
			preferencesNoticeState = next ? ['已套用，但無法保存設定。重啟後可能恢復預設值。', 'Applied, but settings could not be saved. They may reset after restarting.'] : ['設定值無效，請重新輸入。', 'Invalid setting. Enter a supported value.'];
		}
	}
	function restoreDefaults() {
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
	const hasDesktopBridge = Boolean((window as Window & { modutexFiles?: unknown }).modutexFiles);
	let desktop = $state.raw<FileDesktopPort | null>(null);
	let desktopLoading = $state(hasDesktopBridge);
	let workspace = $state.raw<WorkspaceInfo | null>(null);
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
		FILE_TYPE: ['請選擇 TeX 或 PDF 文件。', 'Please choose a TeX or PDF document.'],
		SOURCE_TOO_LARGE: ['文件超過 5 MiB，無法開啟；請選擇較小的文件。', 'Document exceeds 5 MiB limit. Choose a smaller file.'],
		PDF_TOO_LARGE: ['PDF 超過 32 MB 上限。', 'PDF exceeds 32 MB limit.'],
		PDF_HEADER: ['檔案不是有效的 PDF。', 'The file is not a valid PDF.'],
		PDF_LOAD: ['無法讀取 PDF。請確認檔案未損壞。', 'Unable to read PDF. Verify the file is not corrupted.'],
		PDF_RENDER: ['無法顯示此 PDF 頁面。', 'Unable to display this PDF page.'],
		STALE_WORKSPACE: ['工作區已關閉，請重新開啟文件。', 'Workspace has been closed. Please reopen the document.'],
		LINK_NOT_ALLOWED: ['此檔案包含連結路徑，請直接開啟實際文件。', 'This file contains link paths. Please open the actual document directly.'],
		FILE_CHANGED: ['檔案在讀取時已變更，請重新開啟。', 'The file changed while being read. Please reopen it.'],
		FILE_CONFLICT: ['磁碟文件已變更，未覆寫。請先保留編輯內容，再重新開啟文件。', 'Disk file changed externally; not overwritten. Keep your edits and reopen.'],
		ENGINE_UNAVAILABLE: ['無法啟動內建編譯引擎，請確認桌面程式的引擎檔案完整。', 'Unable to start built-in compile engine. Verify application files are complete.'],
		BUSY: ['上一個操作尚未結束，請稍後再試。', 'Previous operation is still running. Please try again shortly.'],
		FILE_TOO_LARGE: ['檔案過大，無法開啟；TeX 上限 5 MB，PDF 上限 32 MB。', 'File too large to open; TeX limit is 5 MB, PDF limit is 32 MB.'],
		TREE_TOO_LARGE: ['工作區檔案過多，請開啟較小的資料夾或直接選擇 TeX 文件。', 'Too many files in workspace. Open a smaller folder or choose a TeX file directly.'],
		TREE_TOO_DEEP: ['資料夾層級過深，請直接開啟需要的子資料夾。', 'Folder depth too deep. Please open the required subfolder directly.']
	};
	function fileErrorDescriptor(value: unknown): [string, string] {
		const code = value instanceof Error ? value.message : '';
		const entry = messages[code];
		return entry ?? ['無法開啟文件，請確認檔案仍存在且可讀取。', 'Unable to open document. Make sure the file exists and is readable.'];
	}
	function fileError(value: unknown): string {
		const entry = fileErrorDescriptor(value);
		return t(entry[0], entry[1]);
	}
	function compileErrorDescriptor(value: unknown): [string, string] {
		const code = value instanceof Error ? value.message : '';
		switch (code) {
			case 'ENGINE_UNAVAILABLE':
				return ['無法啟動內建編譯引擎。請確認桌面程式檔案完整，然後重試。', 'Unable to start the built-in compile engine. Verify the application files are complete, then try again.'];
			case 'BUSY':
				return ['另一個操作尚未結束，無法開始編譯。請稍後再試。', 'Another operation is still running, so compilation did not start. Try again shortly.'];
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
			default:
				return ['無法完成編譯。請檢查 TeX 記錄並修正文件後再試。', 'Unable to complete compilation. Review the TeX log, correct the document, and try again.'];
		}
	}
	function workspaceWatchIsCurrent(watch: WorkspaceWatch): boolean {
		return !lifetime.signal.aborted && watch.active && !watch.terminal &&
			activeWorkspaceWatch === watch && workspace === watch.owner;
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
			pending: new Map(),
			active: true,
			terminal: false,
			overflowed: false,
			recoveryEvents: false,
			processing: false,
			recovering: false,
			unsubscribe: null
		};
		activeWorkspaceWatch = watch;
		workspaceWatchIssue = null;
		try {
			void desktop.watchFiles(owner.id, (event) => {
				if (event.workspaceId !== owner.id || !workspaceWatchIsCurrent(watch)) return;
				queueWorkspaceEvent(watch, { event });
			}, () => failWorkspaceWatch(watch)).then((unsubscribe) => {
				if (!workspaceWatchIsCurrent(watch)) {
					try { unsubscribe(); } catch { /* a late subscription is immediately disposed */ }
					return;
				}
				watch.unsubscribe = unsubscribe;
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
	function acceptDiskSource(document: SourceDocument, path: string, nextRevision: string) {
		abandonCompile();
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
			let refreshed: readonly FileEntry[];
			try {
				refreshed = await port.listFiles(watch.owner.id);
			} catch {
				suspendWorkspaceWatch(watch);
				return;
			}
			if (!workspaceWatchIsCurrent(watch) || source?.documentId !== documentId || sourceName !== path) return;
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
			acceptDiskSource(reloaded, path, receipt.revision);
		} catch (value) {
			if (!workspaceWatchIsCurrent(watch) || source?.documentId !== documentId || sourceName !== path) return;
			setExternalFileNotice(watch, documentId, path, 'changed');
			errorState = fileErrorDescriptor(value);
		}
	}
	async function reconcileWorkspaceEvent(watch: WorkspaceWatch, queued: QueuedWorkspaceEvent) {
		const port = desktop;
		if (!port || !workspaceWatchIsCurrent(watch)) return;
		let listed: readonly FileEntry[];
		try {
			listed = await port.listFiles(watch.owner.id);
		} catch {
			suspendWorkspaceWatch(watch);
			return;
		}
		if (!workspaceWatchIsCurrent(watch)) return;
		entries = listed;
		const currentSource = source;
		if (!currentSource) return;
		const currentPath = sourceName;
		const exists = listed.some((entry) => entry.kind === 'file' && entry.path === currentPath);
		if (!exists) {
			setExternalFileNotice(watch, currentSource.documentId, currentPath, 'missing');
			return;
		}
		const wasMissing = externalFileNotice?.kind === 'missing' &&
			externalFileNotice.documentId === currentSource.documentId && externalFileNotice.path === currentPath;
		// Watch events belong to a path, even when reopening creates a new source identity.
		if (queued.event.path !== currentPath) {
			if (wasMissing) setExternalFileNotice(watch, currentSource.documentId, currentPath, 'changed');
			return;
		}
		await reconcileSourceFromDisk(watch, currentSource.documentId, currentPath, queued);
	}
	async function drainWorkspaceWatch(watch: WorkspaceWatch | null = activeWorkspaceWatch) {
		if (!watch || watch.processing || watch.overflowed || !workspaceWatchIsCurrent(watch) || opening || saving) return;
		watch.processing = true;
		try {
			while (watch.pending.size && !watch.overflowed && workspaceWatchIsCurrent(watch) && !opening && !saving) {
				const queued = watch.pending.values().next().value as QueuedWorkspaceEvent | undefined;
				if (!queued) break;
				watch.pending.delete(queued.event.path);
				await reconcileWorkspaceEvent(watch, queued);
			}
		} finally {
			watch.processing = false;
			if (watch.pending.size && !watch.overflowed && workspaceWatchIsCurrent(watch) && !opening && !saving) {
				void drainWorkspaceWatch(watch);
			}
		}
	}
	async function reconcileWorkspaceSnapshot(watch: WorkspaceWatch) {
		const port = desktop;
		if (!port || !workspaceWatchIsCurrent(watch)) return;
		let listed: readonly FileEntry[];
		try {
			listed = await port.listFiles(watch.owner.id);
		} catch {
			suspendWorkspaceWatch(watch);
			return;
		}
		if (!workspaceWatchIsCurrent(watch)) return;
		entries = listed;
		const currentSource = source;
		if (!currentSource) return;
		const path = sourceName;
		if (!listed.some((entry) => entry.kind === 'file' && entry.path === path)) {
			setExternalFileNotice(watch, currentSource.documentId, path, 'missing');
			return;
		}
		await reconcileSourceFromDisk(watch, currentSource.documentId, path, null);
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
			notice.path !== sourceName || opening || saving) return;
		const snapshotVersion = snapshot.version;
		const dirtyAtStart = dirty;
		const revisionAtStart = revision;
		if (!allowReplacement()) return;
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
		lifetime.abort(); ++sourceTicket; ++pdfTicket;
		++compileTicket;
		if (workspace && desktop) void desktop.closeWorkspace(workspace.id).catch(() => {});
	});
	onMount(() => {
		const root = document.documentElement, previousTheme = root.dataset.theme, previousLanguage = root.getAttribute('lang');
		if (hasDesktopBridge) {
			void import('./features/files/desktop.ts').then(({ desktopFiles }) => {
				if (lifetime.signal.aborted) return;
				desktop = desktopFiles(lifetime.signal);
				void refreshRecent();
			}).catch(() => {
				if (!lifetime.signal.aborted) errorState = ['無法載入桌面檔案功能，請重新開啟程式。', 'Desktop file access could not be loaded. Please reopen the application.'];
			}).finally(() => { if (!lifetime.signal.aborted) desktopLoading = false; });
		}
		let unsubscribe = () => {};
		try {
			const saved = readPreferences(window.localStorage); preferences = saved.preferences;
			if (saved.invalid) preferencesNoticeState = ['部分設定無法讀取，已使用預設值。', 'Some settings could not be read and were reset to defaults.'];
			unsubscribe = subscribePreferences(window, (value, invalid) => {
				preferences = value;
				preferencesNoticeState = invalid ? ['部分設定無法讀取，已使用預設值。', 'Some settings could not be read and were reset to defaults.'] : null;
			});
		} catch { preferencesNoticeState = ['無法讀取已保存的設定，目前使用預設值。', 'Saved settings could not be read. Using defaults.']; }
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const systemTheme = () => { systemDark = media.matches; }; systemTheme(); media.addEventListener('change', systemTheme);
		const routes = () => {
			const hash = window.location.hash;
			showLimitations = hash === '#/release-notes/limitations';
			selectedHelp = helpTopic(hash);
			route = hash === '#/help' || hash.startsWith('#/help/') ? 'help' : hash === '#/settings' ? 'settings' : hash === '#/release-notes' || showLimitations ? 'release-notes' : hash === '#/workbench' || hash === '#/workspace' ? 'workbench' : 'home';
		}; routes(); window.addEventListener('hashchange', routes);
		const warn = (event: BeforeUnloadEvent) => {
			if (!dirty) return;
			event.preventDefault(); event.returnValue = '';
		};
		window.addEventListener('beforeunload', warn);
		rootStateReady = true;
		return () => {
			rootStateDisposed = true;
			window.removeEventListener('beforeunload', warn); window.removeEventListener('hashchange', routes);
			media.removeEventListener('change', systemTheme); unsubscribe();
			if (previousTheme === undefined) delete root.dataset.theme; else root.dataset.theme = previousTheme;
			if (previousLanguage === null) root.removeAttribute('lang'); else root.setAttribute('lang', previousLanguage);
		};
	});
	function allowReplacement(): boolean {
		if (saving) return false;
		return !dirty || window.confirm(t('編輯內容尚未儲存至磁碟。要捨棄變更並切換文件嗎？', 'Edits are not saved to disk. Discard changes and switch documents?'));
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
		if (manageBusy && opening) return;
		if (manageBusy && !path.toLowerCase().endsWith('.pdf') && !allowReplacement()) return;
		if (!path.toLowerCase().endsWith('.pdf')) abandonCompile();
		const pdf = path.toLowerCase().endsWith('.pdf');
		const ticket = pdf ? ++pdfTicket : ++sourceTicket;
		if (manageBusy) opening = true;
		errorState = null;
		try {
			const receipt = await desktop.readFile({ workspaceId: owner.id, path });
			if (workspace !== owner || ticket !== (pdf ? pdfTicket : sourceTicket)) return;
			if (pdf) {
				if (new TextDecoder('ascii').decode(receipt.bytes.subarray(0, 5)) !== '%PDF-') throw new Error('PDF_HEADER');
				pdfBytes = receipt.bytes;
				pdfIdentity = null;
				pdfName = path;
				pageCount = 0;
			} else {
				source = readSourceBytes(receipt.bytes); outlineFailed = false;
				sourceName = path;
				revision = receipt.revision; savedVersion = null;
				hasDiskCheckpoint = true;
				dirty = false;
				externalFileNotice = null;
			}
		} catch (value) {
			if (workspace === owner && ticket === (pdf ? pdfTicket : sourceTicket)) errorState = fileErrorDescriptor(value);
		} finally {
			if (manageBusy && workspace === owner && ticket === (pdf ? pdfTicket : sourceTicket)) {
				opening = false;
				void drainWorkspaceWatch();
			}
		}
	}
	async function chooseSource(kind: 'file' | 'folder' = 'file', recentId?: string) {
		if (!allowReplacement()) return;
		if (!desktop) { sourceInput.click(); return; }
		if (opening) return;
		opening = true;
		errorState = null;
		try {
			const selected = recentId ? await desktop.openRecent(recentId) : await desktop.openWorkspace(kind);
			if (!selected) return;
			stopWorkspaceWatch();
			workspaceWatchIssue = null;
			externalFileNotice = null;
			abandonCompile();
			workspace = selected;
			++sourceTicket; ++pdfTicket;
			source = null; sourceName = ''; dirty = false; revision = null; savedVersion = null; pdfBytes = null; pdfIdentity = null; pdfName = ''; pageCount = 0; entries = [];
			if (selected.entryPath) {
				entries = [{ path: selected.entryPath, kind: 'file' }];
				await readDesktopFile(selected.entryPath, selected, false);
			}
			try {
				const listed = await desktop.listFiles(selected.id);
				if (workspace === selected) entries = listed;
			} catch (value) { if (!lifetime.signal.aborted && workspace === selected) errorState = fileErrorDescriptor(value); }
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
		if (!allowReplacement()) { sourceInput.value = ''; return; }
		const ticket = ++sourceTicket;
		opening = true;
		errorState = null;
		try {
			const document = await readSource(file);
			if (ticket === sourceTicket) {
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
				revision = receipt.revision;
				if (source.version === snapshot.version) { savedVersion = snapshot.version; dirty = false; }
			}
		} catch (value) { if (!lifetime.signal.aborted && workspace === owner) errorState = fileErrorDescriptor(value); }
		finally {
			if (!lifetime.signal.aborted) {
				saving = false;
				void drainWorkspaceWatch();
			}
		}
	}
	async function saveSourceAs() {
		if (!desktop || !source || saving || opening || compiling) return;
		const snapshot = source, owner = workspace;
		saving = true; errorState = null;
		try {
			const result = await desktop.saveAs({ workspaceId: owner?.id ?? null, bytes: snapshot.toBytes(),
				documentId: snapshot.documentId, documentVersion: snapshot.version });
			if (!result) return;
			if (lifetime.signal.aborted || workspace !== owner || source !== snapshot) {
				if (activeWorkspaceWatch?.owner === owner) stopWorkspaceWatch(activeWorkspaceWatch);
				await desktop.closeWorkspace(result.workspace.id); return;
			}
			if (activeWorkspaceWatch?.owner === owner) stopWorkspaceWatch(activeWorkspaceWatch);
			// Keep the editor's source snapshot and history; only its disk checkpoint changes.
			abandonCompile(); ++sourceTicket; ++pdfTicket;
			workspace = result.workspace; sourceName = result.write.path; revision = result.write.revision;
			externalFileNotice = null;
			workspaceWatchIssue = null;
			void refreshRecent();
			savedVersion = snapshot.version; hasDiskCheckpoint = true; dirty = false;
			entries = [{ path: sourceName, kind: 'file' }];
			// A previous preview belongs to the former workspace, even if the filename matches.
			if (pdfIdentity) { pdfBytes = null; pdfIdentity = null; pdfName = ''; pageCount = 0; }
			const selected = result.workspace;
			try { const listed = await desktop.listFiles(selected.id); if (workspace === selected) entries = listed; }
			catch { if (!lifetime.signal.aborted && workspace === selected) errorState = ['文件已儲存，但無法讀取資料夾清單。請重新開啟資料夾。', 'Document saved, but unable to read folder file list. Please reopen the folder.']; }
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
		if (opening || saving || compiling || !allowReplacement()) return;
		const previous = source, owner = workspace;
		opening = true; errorState = null;
		try {
			const { createDraft } = await import('./features/files/templates.ts');
			const draft = createDraft(template);
			if (lifetime.signal.aborted || source !== previous || workspace !== owner) return;
			if (desktop && owner) {
				if (activeWorkspaceWatch?.owner === owner) stopWorkspaceWatch(activeWorkspaceWatch);
				await desktop.closeWorkspace(owner.id);
			}
			if (lifetime.signal.aborted || source !== previous || workspace !== owner) return;
			abandonCompile(); ++sourceTicket; ++pdfTicket;
			workspace = null; entries = []; source = draft; sourceName = 'untitled.tex';
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
		const previous = workspace;
		await chooseSource(kind);
		if (!lifetime.signal.aborted && desktop && workspace && workspace !== previous) window.location.hash = '#/workbench';
	}
	async function openRecent(id: string) {
		const previous = workspace;
		await chooseSource('file', id);
		if (!lifetime.signal.aborted && workspace && workspace !== previous) window.location.hash = '#/workbench';
	}
	async function compileSource() {
		if (!desktop || !workspace || !source || !revision || compiling || saving || opening || sourceMissingOnDisk()) return;
		const snapshot = source;
		const owner = workspace;
		const path = sourceName;
		if (dirty) await saveSource();
		// Saving yields to native I/O: do not compile another document selected
		// between save completion and this continuation.
		if (dirty || source !== snapshot || workspace !== owner || sourceName !== path || saving || opening || compiling || lifetime.signal.aborted || !revision || sourceMissingOnDisk()) return;
		const compileRevision = revision;
		if (!compileRevision) return;
		const own = ++compileTicket;
		const previewTicket = pdfTicket;
		compileCancellationRequestedFor = null;
		compileCancellationFailedFor = null;
		compiling = true; errorState = null; compileNoticeState = null; compileLog = '';
		diagnostics = []; diagnosticIdentity = null;
		let handleReturned = false;
		try {
			const handle = await desktop.compile({ workspaceId: owner.id, entryPath: path, documentId: snapshot.documentId,
				documentVersion: snapshot.version, savedRevision: compileRevision, engine: 'managed' });
			handleReturned = true;
			if (own !== compileTicket || workspace !== owner) { await handle.cancel(); return; }
			compileHandle = handle;
			// A cancel request made while startCompile was awaiting its native reply
			// belongs to this ticket and must be applied before observing its result.
			if (compileCancellationRequestedFor === own) {
				try { await handle.cancel(); }
				catch { noteCompileCancellationFailure(own); }
			}
			if (own !== compileTicket || workspace !== owner) return;
			const result = await handle.finished;
			if (own !== compileTicket || workspace !== owner) return;
			if (compileCancellationRequestedFor === own) {
				if (compileCancellationFailedFor !== own) {
					compileNoticeState = result.status === 'cancelled'
						? ['編譯已取消', 'Compilation cancelled']
						: ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
				}
				return;
			}
			if (!compileSnapshotIsCurrent(snapshot, owner, path, compileRevision)) {
				compileNoticeState = ['文件已變更，本次編譯結果未載入。請重新編譯。', 'The document changed, so this compile result was not loaded. Please compile again.'];
				return;
			}
			compileLog = result.log;
			diagnostics = result.diagnostics; diagnosticIdentity = result.identity;
			if (result.status === 'cancelled') { compileNoticeState = ['編譯已取消', 'Compilation cancelled']; return; }
			if (result.status === 'failure') {
				const diag = result.diagnostics[0]?.message;
				errorState = diag ? { raw: diag } : compileErrorDescriptor(new Error('COMPILE_FAILED'));
				compileNoticeState = ['編譯失敗。請檢查編譯問題或 TeX 記錄，修正後重新編譯。', 'Compilation failed. Review the problems or TeX log, then compile again.'];
				return;
			}
			if (result.status !== 'success') return;
			if (pdfTicket !== previewTicket) { compileNoticeState = ['文件或預覽已變更，請重新編譯。', 'Document or preview has changed. Please compile again.']; return; }
			pdfBytes = result.pdf; pdfName = path.replace(/\.tex$/i, '.pdf'); pageCount = 0;
			pdfIdentity = result.identity;
			compileNoticeState = ['編譯完成', 'Compilation completed'];
		} catch (value) {
			if (own === compileTicket && workspace === owner) {
				if (handleReturned && compileCancellationRequestedFor === own) {
					if (compileCancellationFailedFor !== own) compileNoticeState = ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
				} else if (!compileSnapshotIsCurrent(snapshot, owner, path, compileRevision)) {
					compileNoticeState = ['文件已變更，本次編譯結果未載入。請重新編譯。', 'The document changed, so this compile result was not loaded. Please compile again.'];
				} else {
					errorState = compileErrorDescriptor(value);
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
	function goToDiagnostic(diagnostic: Diagnostic) {
		if (!source || !diagnosticIdentity || saving || opening) return;
		const span = diagnosticSpan(source, sourceName, diagnosticIdentity, diagnostic);
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
		if (!port || opening || saving || !diagnosticContextIsCurrent(context)) return;
		if (!allowReplacement()) {
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
		if (opening || saving) return;
		if (command === 'open') {
			const previous = source;
			void chooseSource().then(() => {
				if (!lifetime.signal.aborted && source && source !== previous) window.location.hash = '#/workbench';
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
			const bytes = await readPdf(file);
			if (!lifetime.signal.aborted && ticket === pdfTicket) {
				pdfBytes = bytes;
				pdfIdentity = null;
				pdfName = file.name;
				pageCount = 0;
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
			<a href="#/workbench" aria-current={route === 'workbench' ? 'page' : undefined}>{t('工作台', 'Workbench')}</a>
			<a href="#/settings" aria-current={route === 'settings' ? 'page' : undefined}>{t('設定', 'Settings')}</a>
			<a href="#/release-notes" aria-current={route === 'release-notes' ? 'page' : undefined}>{t('版本紀錄', 'Release notes')}</a>
			<a href="#/help" aria-current={route === 'help' ? 'page' : undefined}>{t('說明', 'Help')}</a>
		</nav>
		<div class="global-actions" hidden={route !== 'workbench'} inert={desktopLoading}>
			{#if desktop}<button onclick={() => chooseSource('folder')} disabled={opening || saving}>{t('開啟資料夾', 'Open folder')}</button>{/if}
			<button onclick={() => chooseSource()} disabled={opening || saving}>{t('開啟文件', 'Open document')}</button>
			<button onclick={() => newDocument('blank')} disabled={opening || saving || compiling}>{t('新文件', 'New document')}</button>
			{#if desktop && source}<button onclick={saveSource} disabled={opening || saving || !dirty || sourceMissingOnDisk()}>{saving ? t('儲存中…', 'Saving…') : t('儲存', 'Save')}</button>{/if}
			{#if desktop && source}<button onclick={saveSourceAs} disabled={opening || saving || compiling}>{t('另存新檔', 'Save as')}</button>{/if}
			{#if desktop && source && revision && !sourceMissingOnDisk()}
				{#if compiling}<button onclick={cancelCompile} disabled={compileCancellationRequestedFor === compileTicket}>{compileCancellationRequestedFor === compileTicket ? t('正在取消…', 'Cancelling…') : t('取消編譯', 'Cancel compilation')}</button>
				{:else}<button onclick={compileSource} disabled={opening || saving}>{t('編譯 PDF', 'Compile PDF')}</button>{/if}
			{/if}
		</div>
	</header>
	{#if route === 'home'}{#key homeLoadKey}{#await import('./pages/Home.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟首頁…', 'Loading home…')}</p></main>{:then { default: Home }}<Home locale={preferences.language} desktop={!!desktop} busy={opening || saving || compiling || desktopLoading} currentName={sourceName} {dirty} {recent} {recentNotice} onRecent={openRecent} onRemoveRecent={removeRecent} onOpen={openFromHome} onCreate={newDocument} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入首頁，文件內容已保留。', 'Home could not be loaded. Your document is preserved.')}</p><button onclick={() => homeLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	{#if route === 'settings'}{#key settingsLoadKey}{#await import('./pages/Settings.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟設定…', 'Loading settings…')}</p></main>{:then { default: Settings }}<Settings {preferences} locale={preferences.language} notice={preferencesNotice} onChange={changePreference} onRestore={restoreDefaults} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入設定，文件內容已保留。', 'Settings could not be loaded. Your document is preserved.')}</p><button onclick={() => settingsLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
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
		{#await import('./components/WorkbenchLayout.svelte')}
			<div class="empty-state" role="status"><p>{t('正在開啟工作台…', 'Loading workbench…')}</p></div>
		{:then { default: WorkbenchLayout }}
		<WorkbenchLayout
			locale={preferences.language}
			bind:activePane={workbenchPane}
			bind:splitRatio={workbenchSplitRatio}
		>
			{#snippet sidebarContent()}
				<aside class="files" aria-label={t('文件與大綱', 'Files and outline')}>
					<div class="pane-title" role="group" aria-label={t('側欄內容', 'Sidebar content')}>
						<button class="text-button" aria-pressed={sidebar === 'files'} onclick={() => sidebar = 'files'}>{t('文件', 'Files')}</button>
						<button class="text-button" aria-pressed={sidebar === 'outline'} onclick={() => sidebar = 'outline'}>{t('大綱', 'Outline')}</button>
					</div>
					{#if sidebar === 'outline'}
						{#if source && outlineOwner === source.documentId && outline.length}
							{#each outline as heading (heading.span.from)}
								<button class="outline-row" style:padding-left={`${16 + heading.level * 12}px`}
									disabled={saving || opening || !projection || !projectionIsCurrent(source, projection)}
									onclick={() => navigation = { span: heading.span, sequence: ++navigationSequence }}>{heading.label}</button>
							{/each}
						{:else}<p class="sidebar-empty">{!source ? t('開啟文件後顯示章節', 'Open a document to view sections') : outlineFailed ? t('大綱暫停更新', 'Outline updates paused') : !projection ? t('正在更新大綱…', 'Updating outline…') : t('此文件沒有章節', 'This document has no sections')}</p>{/if}
					{:else if workspace}
						<div class="file-meta">{workspace.label}</div>
						{#each entries.filter((entry) => entry.kind === 'file') as entry (entry.path)}
							<button class="file-row" aria-current={entry.path === sourceName || entry.path === pdfName ? 'true' : undefined}
								disabled={opening || saving} onclick={() => workspace && readDesktopFile(entry.path, workspace)}>{entry.path}</button>
						{/each}
					{:else if source}
						<div class="file-row">{sourceName}</div>
						<div class="file-meta">UTF-8{source.profile.bom ? ' · BOM' : ''}</div>
					{:else}
						<p class="sidebar-empty">{t('尚未開啟文件', 'No document open')}</p>
					{/if}
				</aside>
			{/snippet}
			{#snippet editor({ active, hidden, inert })}
				<section class="editor-pane" aria-label={t('文件編輯', 'Document editor')} {hidden} {inert}>
					<div class="pane-title"><span>{sourceName || t('原始碼', 'Source')}</span><span class="mode-label">LaTeX</span></div>
					<div class="editor-bar"><span>{t('文件', 'Document')}</span><span class="muted">{dirty ? t('未儲存至磁碟', 'Not saved to disk') : 'UTF-8'}</span></div>
					<div class="editor-content">
						{#if source}
							{#key source.documentId + ':' + editorLoadKey}
							{#await import('./features/source-editor/SourceView.svelte')}
								<div class="empty-state" role="status"><p>{t('正在開啟編輯器…', 'Loading editor…')}</p></div>
							{:then { default: SourceView }}
								<SourceView document={source} label={sourceName} saving={saving || opening} {savedVersion} active={route === 'workbench' && active}
									fontSize={preferences.sourceFontSize} showLineNumbers={preferences.showLineNumbers} wrapLines={preferences.wrapLines}
									locale={preferences.language}
									diagnosticNavigation={diagnosticNavigation?.documentId === source.documentId && diagnosticNavigation?.documentVersion === source.version ? diagnosticNavigation : null}
									navigation={navigation?.span.documentId === source.documentId ? navigation : null}
									onChange={(document, changed) => { source = document; dirty = changed || !hasDiskCheckpoint; if (projection && !projectionIsCurrent(document, projection)) projection = null; }}
								onProjection={(parsed) => { if (source && projectionIsCurrent(source, parsed)) { projection = parsed; outline = sourceOutline(source, parsed); outlineOwner = source.documentId; outlineFailed = false; } }}
								onParserFailure={() => { projection = null; outlineFailed = true; }}
								onVisualRejected={() => { errorState = ['這項修改無法套用。請切換至原始碼模式；內容已保留。', 'This edit could not be applied. Switch to source mode; your content is preserved.']; }}
								onRejected={(reason) => { errorState = reason === 'SOURCE_TOO_LARGE' ? ['修改後文件將超過 5 MiB，內容已保留。請減少插入內容。', 'The document would exceed 5 MiB after this edit. Content is preserved. Reduce the inserted text.'] : ['無法套用此修改，文件內容已保留。請重新選取完整字元。', 'Could not apply this edit. Content is preserved. Select complete characters and try again.']; }} />
							{:catch}
								<div class="empty-state" role="alert"><p>{t('無法載入編輯器。文件內容已保留。', 'The editor could not be loaded. Your document is preserved.')}</p><button onclick={() => editorLoadKey++}>{t('重試', 'Retry')}</button></div>
							{/await}
							{/key}
						{:else}
							<div class="empty-state">
								<h1>{t('開啟 TeX 文件', 'Open a TeX document')}</h1>
								<p>{t('在工作台檢視原始碼，並開啟 PDF 對照。', 'Edit the source alongside its PDF.')}</p>
								<button onclick={() => chooseSource()} disabled={opening}>{t('選擇文件', 'Choose document')}</button>
							</div>
						{/if}
					</div>
				</section>
			{/snippet}
			{#snippet preview({ active, hidden, inert })}
				<section class="preview-pane" aria-label={t('PDF 預覽', 'PDF preview')} {hidden} {inert}>
					<div class="pane-title">
						<span>{pdfName || 'PDF'}</span><button class="text-button" onclick={() => pdfInput.click()}>{t('開啟 PDF', 'Open PDF')}</button>
					</div>
					<div class="editor-bar">
						<span>{!pdfBytes ? t('預覽', 'Preview') : previewStatus(source, sourceName, pdfIdentity) === 'stale' ? t('文件已變更，顯示上次編譯 PDF', 'Document changed; showing the previous PDF') : previewStatus(source, sourceName, pdfIdentity) === 'current' ? t('目前文件的編譯 PDF', 'PDF compiled from this document') : t('外部 PDF', 'External PDF')}</span>{#if pageCount}<span class="muted">{t(`共 ${pageCount} 頁`, `${pageCount} pages`)}</span>{/if}
					</div>
					<div class="preview-content">
						{#if pdfBytes}
							{#key pdfLoadKey}{#await import('./features/pdf/PdfView.svelte')}
								<div class="empty-state" role="status"><p>{t('正在開啟 PDF 預覽…', 'Loading PDF preview…')}</p></div>
							{:then { default: PdfView }}
							{#key pdfBytes}<PdfView
									bytes={pdfBytes}
									active={route === 'workbench' && active}
									locale={preferences.language}
									onPageCount={(count) => (pageCount = count)}
									onError={(code) => (errorState = fileErrorDescriptor(new Error(code)))}
								/>{/key}
							{:catch}
								<div class="empty-state" role="alert"><p>{t('無法載入 PDF 預覽。', 'The PDF preview could not be loaded.')}</p><button onclick={() => pdfLoadKey++}>{t('重試', 'Retry')}</button></div>
							{/await}{/key}
						{:else}<div class="empty-state">
								<h2>{t('PDF 預覽', 'PDF preview')}</h2>
								<p>{t('開啟 PDF，與原始碼對照。', 'Open a PDF alongside the source.')}</p>
							</div>{/if}
					</div>
				</section>
			{/snippet}
		</WorkbenchLayout>
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
	{#if diagnostics.length}<section class="compile-problems" aria-label={t('編譯問題', 'Compilation problems')}><h2>{t('編譯問題', 'Compilation problems')}</h2><ul>{#each diagnostics as diagnostic}<li><span>{diagnostic.message}</span>{#if diagnostic.line !== null}<button class="text-button" disabled={!canNavigateDiagnostic(diagnostic)} onclick={() => navigateToDiagnostic(diagnostic)}>{diagnostic.path}:{diagnostic.line} · {t('前往原始碼', 'Go to source')}</button>{/if}</li>{/each}</ul></section>{/if}
	{#if compileLog}<details class="compile-log"><summary>{t('TeX 編譯記錄', 'TeX compilation log')}</summary><pre>{compileLog}</pre></details>{/if}
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
</div>
