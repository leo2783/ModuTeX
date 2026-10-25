<script lang="ts">
import type { SourceDocument, SourcePatch, SourceProjection, SourceSpan } from './features/document-core/core.ts';
	import { projectionIsCurrent } from './features/document-core/projection-state.ts';
	import type { OutlineEntry } from './features/source-editor/outline.ts';
	import { onDestroy, onMount, tick } from 'svelte';
	import CloseDialog from './components/CloseDialog.svelte';
	import AppMenu from './components/AppMenu.svelte';
	import { text } from './i18n/text.ts';
	import { documentCommand } from './features/shortcuts/keyboard.ts';
	import { helpTopic, type HelpTopic } from './features/help/route.ts';
	import { DEFAULT_PREFERENCES, announcePreferenceChange, legacyPreferenceRecord, readPreferences, savePreference, restorePreferences, subscribePreferences, decodePreference, effectiveAppearance, type Preferences } from './state/preferences.ts';
	import { createNativePreferencesAdapter, type NativePreferencesImport, type NativePreferencesSnapshot } from './state/native-preferences.ts';
	import type { WorkspaceInfo, FileEntry, FileEvent, CompileHandle, CompileIdentity, Diagnostic } from '@modutex/frontend-contracts';
	import type { DiagnosticNavigationRequest } from './features/source-editor/diagnostics.ts';
	import type { FileDesktopPort } from './features/files/desktop.ts';
	import type { WorkspaceFilesPort, WorkspaceFilesTask } from './features/files/workspace-files.ts';
	import type { RecentDocument } from './features/files/recent.ts';
	import type { TemplateId } from './features/files/templates.ts';
	import { invoke, isTauri } from '@tauri-apps/api/core';
	import type { BoundSynctexIndex } from './features/compile/synctex.ts';
	import { sameCompileIdentity } from './features/compile/identity.ts';
	import type {
		DraftSelectionSnapshot,
		NoticeDescriptor,
		QueuedWorkspaceEvent,
		SourceViewHandle,
		WorkbenchRuntimeHost,
		WorkbenchWatchLike
	} from './features/compile/workbench-runtime.ts';

	type WorkbenchRuntimeModule = typeof import('./features/compile/workbench-runtime.ts');
	// Cache the deferred runtime so handlers stay synchronous up to their first real await
	// (for example, the replacement confirmation) once the workbench has loaded it.
	let workbenchRuntime: WorkbenchRuntimeModule | null = null;
	let workbenchRuntimeLoad: Promise<WorkbenchRuntimeModule> | null = null;
	function loadWorkbenchRuntime(): Promise<WorkbenchRuntimeModule> {
		if (workbenchRuntime) return Promise.resolve(workbenchRuntime);
		workbenchRuntimeLoad ??= import('./features/compile/workbench-runtime.ts').then((module) => {
			workbenchRuntime = module;
			return module;
		}, (error) => {
			workbenchRuntimeLoad = null;
			throw error;
		});
		return workbenchRuntimeLoad;
	}

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
	let activeDockTab = $state<null | 'problems' | 'output' | 'terminal'>(null);
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
	let outline = $state.raw<readonly OutlineEntry[]>([]);
	let outlineOwner = $state('');
	let outlineFailed = $state(false);
	let navigation = $state.raw<{ readonly span: SourceSpan; readonly sequence: number; readonly sourceOnly?: boolean } | null>(null);
	let diagnosticNavigation = $state.raw<DiagnosticNavigationRequest | null>(null);
	let diagnosticNavigationSequence = 0;
	let navigationSequence = 0;
	type SettingsSection = 'general-preferences' | 'appearance' | 'editor-preferences' | 'shortcut-preferences' | 'compile-settings' | 'restore-preferences';
	let route = $state<'home' | 'workbench' | 'settings' | 'release-notes' | 'help'>('home');
	let settingsSection = $state<SettingsSection>('general-preferences');
	function updateSettingsSection(section: SettingsSection) {
		settingsSection = section;
		const hash = section === 'compile-settings' ? '#/compile-settings' : '#/settings';
		if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
	}
	function applySettingsSourcePatches(identity: { readonly documentId: string; readonly version: number }, patches: readonly SourcePatch[]): boolean {
		if (saving || opening || confirming || compiling) return false;
		if (!source || source.documentId !== identity.documentId || source.version !== identity.version) return false;
		return sourceViewInstance?.applySourcePatches?.(identity, patches) ?? false;
	}
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
	type WorkspaceWatchIssue = 'offline' | 'reconcile';
	interface WorkspaceWatch extends WorkbenchWatchLike {
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
	const SYNCTEX_INPUT_EXTENSIONS = new Set(
		'tex,ltx,sty,cls,clo,def,dtx,ins,inc,bib,bbl,bst,ist,cfg,fd,bbx,cbx,lbx,aux,toc,lof,lot,eps,ps,pdf,png,jpg,jpeg,gif,bmp,tif,tiff,webp,svg,tikz,pgf,mps,mp,mf,txt,csv,dat'.split(',')
	);
	function renderNotice(notice: NoticeDescriptor | null, lang: import('./i18n/text.ts').Language): string {
		if (!notice) return '';
		if ('raw' in notice) return notice.raw;
		return text(lang, notice[0], notice[1]);
	}
	let compileNoticeState = $state<[string, string] | null>(null);
	let compileNotice = $derived(compileNoticeState ? text(preferences.language, compileNoticeState[0], compileNoticeState[1]) : '');
	let errorState = $state<NoticeDescriptor | null>(null);
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
		if (result.invalid) return ['部分設定無法讀取。已使用預設值。', 'Some settings could not be read. Defaults were used.'];
		if (result.remainingElectronSettings.length) {
			return [
				'部分舊版設定尚未匯入。原設定檔已保留。',
				'Some legacy settings were not imported. The original settings file was preserved.'
			];
		}
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
	let pendingOpenArmed = $state(false);
	let pendingOpenTask: Promise<void> | null = null;
	let pendingOpenListenerDisposed = false;
	let unlistenPendingOpen: (() => void) | null = null;
	let workspaceFiles = $state.raw<WorkspaceFilesPort | null>(null);
	let workspaceFilesAvailability = $state<'checking' | 'available' | 'unavailable'>('unavailable');
	let workspaceFilesOpen = $state(false);
	let workspaceFilesPanelVisited = $state(false);
	let workspaceFilesInitialTool = $state<'create-file' | 'create-directory' | null>(null);
	let workspaceFilesInitialPath = $state('');
	let workspaceFilesOpenSequence = $state(0);
	let workspaceFilesButton: HTMLButtonElement | null = $state(null);
	let workspaceGeneration = $state(0);
	let sourceViewInstance = $state.raw<SourceViewHandle | null>(null);
	let draftSelectionSnapshot = $state.raw<DraftSelectionSnapshot | null>(null);
	let draftSelectionWarning = $state<[string, string] | null>(null);
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
	$effect(() => {
		if (pendingOpenArmed && desktop && isTauri() &&
			!opening && !saving && !confirming && !compiling &&
			!lifetime.signal.aborted) {
			void drainPendingOpenRequests();
		}
	});
	let sourceInput: HTMLInputElement;
	let pdfInput: HTMLInputElement;
	let sourceTicket = 0;
	let pdfTicket = 0;
	function setSourceViewMode(mode: 'source' | 'visual') {
		sourceViewMode = mode;
	}
	$effect(() => {
		if (draftPanelOpen && (!source || !workspace || !revision ||
			!sourceName.toLowerCase().endsWith('.tex') || !isTauri())) {
			draftPanelOpen = false;
		}
	});
	function resetDraftSelection() {
		draftSelectionSnapshot = null;
		draftSelectionWarning = null;
	}
	function handleSourceChange(document: SourceDocument, changed: boolean) {
		const nextDirty = changed || !hasDiskCheckpoint;
		if (nextDirty) invalidateSynctexIndex();
		if (draftSelectionSnapshot &&
			(draftSelectionSnapshot.documentId !== document.documentId ||
				draftSelectionSnapshot.documentVersion !== document.version)) {
			resetDraftSelection();
		}
		source = document;
		dirty = nextDirty;
		if (projection && !projectionIsCurrent(document, projection)) projection = null;
	}
	function isWorkspaceScopeCurrent(owner: WorkspaceInfo, generation: number): boolean {
		return !lifetime.signal.aborted &&
			(workspace?.id ?? null) === owner.id &&
			workspaceGeneration === generation;
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
		const { runRefreshWorkspaceEntries } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		return runRefreshWorkspaceEntries(runtimeHost, owner, generation);
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
			'此桌面版本未提供完整的原生工作區檔案操作，一般檔案瀏覽與編輯仍可使用。',
			'This host does not provide the native workspace file operations. Regular file browsing and editing remain available.'
		];
		void refreshWorkspaceEntries(owner, generation);
	}
	function openWorkspaceFilesWithTool(
		tool: 'create-file' | 'create-directory' | null = null,
		initialPath = ''
	) {
		if (!workspace || !workspaceFiles || workspaceFilesAvailability !== 'available') return;
		workspaceFilesPanelVisited = true;
		workspaceFilesOpen = true;
		workspaceFilesInitialTool = tool;
		workspaceFilesInitialPath = initialPath;
		workspaceFilesOpenSequence++;
	}
	function openWorkspaceFiles() {
		openWorkspaceFilesWithTool();
	}
	function openWorkspaceFileCreate(parentPath?: string) {
		if (!workspace) {
			void newDocument('blank');
			return;
		}
		if (!workspaceFiles || workspaceFilesAvailability !== 'available') {
			errorState = [
				'工作區檔案操作目前無法使用，無法在工作區新增文件。',
				'Workspace file operations are unavailable. A document cannot be created in this workspace.'
			];
			return;
		}
		if (route !== 'workbench') window.location.hash = '#/workbench';
		const parent = parentPath?.replace(/\\+$/, '').replace(/\/+$/, '') ?? '';
		openWorkspaceFilesWithTool('create-file', parent ? `${parent}/untitled.tex` : 'untitled.tex');
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
		const { runCompileWorkspaceFile } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runCompileWorkspaceFile(runtimeHost, path, owner);
	}
	function workspaceWatchIsCurrent(watch: WorkspaceWatch): boolean {
		return !lifetime.signal.aborted && watch.active && !watch.terminal &&
			activeWorkspaceWatch === watch &&
			workspace === watch.owner &&
			(workspace?.id ?? null) === watch.owner.id &&
			workspaceGeneration === watch.generation;
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
	function disposePendingOpenListener() {
		pendingOpenListenerDisposed = true;
		const stop = unlistenPendingOpen;
		unlistenPendingOpen = null;
		if (stop) {
			try { stop(); } catch { /* disposal must not interrupt App teardown */ }
		}
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
		resetDraftSelection();
		editorLoadKey++;
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
	function workspaceWatchCanDrain(watch: WorkspaceWatch) {
		return !watch.overflowed && workspaceWatchIsCurrent(watch) && !opening && !saving && !confirming;
	}
	async function drainWorkspaceWatch(watch: WorkspaceWatch | null = activeWorkspaceWatch) {
		if (!watch || watch.processing || !workspaceWatchCanDrain(watch)) return;
		watch.processing = true;
		try {
			const { runDrainWorkspaceWatchLoop } = (workbenchRuntime ?? await loadWorkbenchRuntime());
			await runDrainWorkspaceWatchLoop(runtimeHost, watch);
		} finally {
			watch.processing = false;
			if ((watch.pending.size || watch.resync) && workspaceWatchCanDrain(watch)) {
				void drainWorkspaceWatch(watch);
			}
		}
	}
	async function recoverWorkspaceWatch() {
		const { runRecoverWorkspaceWatch } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runRecoverWorkspaceWatch(runtimeHost);
	}
	function keepExternalDraft() {
		if (!externalFileNotice || !source ||
			externalFileNotice.documentId !== source.documentId || externalFileNotice.path !== sourceName) return;
		externalFileNotice = { ...externalFileNotice, acknowledged: true };
	}
	async function reloadExternalSource() {
		const { runReloadExternalSource } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runReloadExternalSource(runtimeHost);
	}
	onDestroy(() => {
		disposePendingOpenListener();
		pendingOpenArmed = false;
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
			pendingOpenListenerDisposed = false;
			void import('@tauri-apps/api/event').then(({ listen }) =>
				listen('frontend://open/pending', () => {
					if (!pendingOpenListenerDisposed && !lifetime.signal.aborted) {
						pendingOpenArmed = true;
					}
				})
			).then((unlisten) => {
				if (pendingOpenListenerDisposed || lifetime.signal.aborted) {
					unlisten();
					return;
				}
				unlistenPendingOpen = unlisten;
				pendingOpenArmed = true;
			}).catch(() => {
				if (!pendingOpenListenerDisposed && !lifetime.signal.aborted) {
					pendingOpenArmed = true;
				}
			});
			void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
				getCurrentWindow().onCloseRequested((event) => {
					if (closeRegistrationDisposed || lifetime.signal.aborted ||
						closeIsConfirmedForCurrentSource() || !dirty || !source) return;
					event.preventDefault();
					showCloseDialog = true;
				})
			).then((unlisten) => {
				if (closeRegistrationDisposed || lifetime.signal.aborted) {
					unlisten();
					return;
				}
				unlistenCloseRequested = unlisten;
			}).catch(() => {
				if (!closeRegistrationDisposed) reportNativeCloseProtectionFailure();
			});
		}
		if (hasDesktopBridge) {
			void Promise.all([
				import('./features/files/desktop.ts'),
				import('./features/files/workspace-files.ts')
			]).then(([{ desktopFiles }, { tauriWorkspaceFiles }]) => {
				if (lifetime.signal.aborted) return;
				desktop = desktopFiles(lifetime.signal);
				workspaceFiles = tauriWorkspaceFiles(lifetime.signal);
				if (isTauri()) pendingOpenArmed = true;
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
			settingsSection = hash === '#/compile-settings' ? 'compile-settings' : 'general-preferences';
			route = hash === '#/help' || hash.startsWith('#/help/') ? 'help' : hash === '#/compile-settings' || hash === '#/settings' ? 'settings' : hash === '#/release-notes' || showLimitations ? 'release-notes' : hash === '#/workbench' || hash === '#/workspace' ? 'workbench' : 'home';
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
			disposePendingOpenListener();
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
	async function closeApplicationWindow() {
		if (isTauri()) await (await import('@tauri-apps/api/window')).getCurrentWindow().close();
		else window.close();
	}
	async function discardAndClose() {
		if (saving || opening || !source) return;
		const snapshot = source;
		if (compiling) abandonCompile();
		showCloseDialog = false;
		closeConfirmed = true;
		closeConfirmedSource = snapshot;
		closeConfirmedVersion = snapshot.version;
		try {
			await closeApplicationWindow();
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
		if (compiling) abandonCompile();
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
			await closeApplicationWindow();
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
		const { runReadDesktopFile } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runReadDesktopFile(runtimeHost, path, owner, manageBusy);
	}
	async function chooseSource(kind: 'file' | 'folder' = 'file', recentId?: string) {
		const { runChooseSource } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runChooseSource(runtimeHost, kind, recentId);
	}
	async function drainPendingOpenRequests() {
		if (pendingOpenTask || !pendingOpenArmed || !desktop || !isTauri()) return;
		const task = (async () => {
			const { runDrainPendingOpenRequests, fileErrorDescriptor } = (workbenchRuntime ?? await loadWorkbenchRuntime());
			try {
				await runDrainPendingOpenRequests(runtimeHost);
			} catch (value) {
				if (!lifetime.signal.aborted) errorState = fileErrorDescriptor(value);
				pendingOpenArmed = false;
			}
		})();
		pendingOpenTask = task;
		try {
			await task;
		} finally {
			if (pendingOpenTask === task) pendingOpenTask = null;
		}
	}
	async function openSource(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		const { runOpenSource } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runOpenSource(runtimeHost, file, () => { sourceInput.value = ''; });
	}
	async function saveSource() {
		const { runSaveSource } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runSaveSource(runtimeHost);
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
		return savedSnapshotIsCurrent && canInstallUpdate();
	}
	async function saveSourceForDraft(): Promise<boolean> {
		const { runSaveSourceForDraft } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		return runSaveSourceForDraft(runtimeHost);
	}
	async function saveSourceAs() {
		const { runSaveSourceAs } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runSaveSourceAs(runtimeHost);
	}
	async function newDocument(template: TemplateId) {
		const { runNewDocument } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runNewDocument(runtimeHost, template);
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
				const { windowErrorNotice } = (workbenchRuntime ?? await loadWorkbenchRuntime());
				if (!lifetime.signal.aborted) errorState = windowErrorNotice(value);
			}
		} finally {
			if (!lifetime.signal.aborted) openingWindow = false;
		}
	}
	async function compileSource() {
		const { runCompileSource } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runCompileSource(runtimeHost);
	}
	async function cancelCompile() {
		if (!compiling || compileCancellationRequestedFor === compileTicket) return;
		const own = compileTicket;
		compileCancellationRequestedFor = own;
		const handle = compileHandle;
		if (!handle) return;
		try { await handle.cancel(); }
		catch {
			if (own === compileTicket && compileCancellationRequestedFor === own) {
				compileCancellationFailedFor = own;
				errorState = ['無法取消編譯。請等待目前執行完成。', 'Unable to cancel compilation. Wait for the current run to finish.'];
			}
		}
	}
	async function forwardSynctex() {
		const { runForwardSynctex } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		runForwardSynctex(runtimeHost);
	}
	async function handlePdfPoint(point: { page: number; x: number; y: number }) {
		const { runHandlePdfPoint } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runHandlePdfPoint(runtimeHost, point);
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
		const { runOpenPdf } = (workbenchRuntime ?? await loadWorkbenchRuntime());
		await runOpenPdf(runtimeHost, file, () => { pdfInput.value = ''; });
	}
	const runtimeHost: WorkbenchRuntimeHost = {
		get lifetime() { return lifetime; },
		get desktop() { return desktop; },
		set desktop(value) { desktop = value; },
		get workspace() { return workspace; },
		set workspace(value) { workspace = value; },
		get workspaceGeneration() { return workspaceGeneration; },
		get workspaceFiles() { return workspaceFiles; },
		set workspaceFiles(value) { workspaceFiles = value; },
		get workspaceFilesAvailability() { return workspaceFilesAvailability; },
		set workspaceFilesAvailability(value) { workspaceFilesAvailability = value; },
		get workspaceFilesOpen() { return workspaceFilesOpen; },
		set workspaceFilesOpen(value) { workspaceFilesOpen = value; },
		get workspaceTreeTasks() { return workspaceTreeTasks; },
		nextWorkspaceEntriesTicket: () => ++workspaceEntriesTicket,
		get workspaceEntriesTicket() { return workspaceEntriesTicket; },
		get source() { return source; },
		set source(value) { source = value; },
		get sourceName() { return sourceName; },
		set sourceName(value) { sourceName = value; },
		get revision() { return revision; },
		set revision(value) { revision = value; },
		get savedVersion() { return savedVersion; },
		set savedVersion(value) { savedVersion = value; },
		get hasDiskCheckpoint() { return hasDiskCheckpoint; },
		set hasDiskCheckpoint(value) { hasDiskCheckpoint = value; },
		get dirty() { return dirty; },
		set dirty(value) { dirty = value; },
		get opening() { return opening; },
		set opening(value) { opening = value; },
		get saving() { return saving; },
		set saving(value) { saving = value; },
		get confirming() { return confirming; },
		set confirming(value) { confirming = value; },
		get compiling() { return compiling; },
		set compiling(value) { compiling = value; },
		get compileHandle() { return compileHandle; },
		set compileHandle(value) { compileHandle = value; },
		get compileLog() { return compileLog; },
		set compileLog(value) { compileLog = value; },
		openCompileTab: (tab) => { activeDockTab = tab; },
		get compileTicket() { return compileTicket; },
		set compileTicket(value) { compileTicket = value; },
		get compileCancellationRequestedFor() { return compileCancellationRequestedFor; },
		set compileCancellationRequestedFor(value) { compileCancellationRequestedFor = value; },
		get compileCancellationFailedFor() { return compileCancellationFailedFor; },
		set compileCancellationFailedFor(value) { compileCancellationFailedFor = value; },
		get diagnostics() { return diagnostics; },
		set diagnostics(value) { diagnostics = value; },
		get diagnosticIdentity() { return diagnosticIdentity; },
		set diagnosticIdentity(value) { diagnosticIdentity = value; },
		get pdfIdentity() { return pdfIdentity; },
		set pdfIdentity(value) { pdfIdentity = value; },
		get pdfBytes() { return pdfBytes; },
		set pdfBytes(value) { pdfBytes = value; },
		get pdfName() { return pdfName; },
		set pdfName(value) { pdfName = value; },
		get pageCount() { return pageCount; },
		set pageCount(value) { pageCount = value; },
		get pdfReveal() { return pdfReveal; },
		set pdfReveal(value) { pdfReveal = value; },
		get synctexIndex() { return synctexIndex; },
		set synctexIndex(value) { synctexIndex = value; },
		get workbenchPane() { return workbenchPane; },
		set workbenchPane(value) { workbenchPane = value; },
		get route() { return route; },
		set route(value) { route = value; },
		get draftPanelOpen() { return draftPanelOpen; },
		set draftPanelOpen(value) { draftPanelOpen = value; },
		get outlineFailed() { return outlineFailed; },
		set outlineFailed(value) { outlineFailed = value; },
		get entries() { return entries; },
		set entries(value) { entries = value; },
		get errorState() { return errorState; },
		set errorState(value) { errorState = value; },
		get compileNoticeState() { return compileNoticeState; },
		set compileNoticeState(value) { compileNoticeState = value; },
		get externalFileNotice() { return externalFileNotice; },
		set externalFileNotice(value) { externalFileNotice = value; },
		get workspaceWatchIssue() { return workspaceWatchIssue; },
		set workspaceWatchIssue(value) { workspaceWatchIssue = value; },
		get pendingOpenArmed() { return pendingOpenArmed; },
		set pendingOpenArmed(value) { pendingOpenArmed = value; },
		get sourceViewInstance() { return sourceViewInstance; },
		set sourceViewInstance(value) { sourceViewInstance = value; },
		get navigation() { return navigation; },
		set navigation(value) { navigation = value; },
		get diagnosticNavigation() { return diagnosticNavigation; },
		set diagnosticNavigation(value) { diagnosticNavigation = value; },
		get activeWorkspaceWatch() { return activeWorkspaceWatch; },
		nextSourceTicket: () => ++sourceTicket,
		get sourceTicket() { return sourceTicket; },
		nextPdfTicket: () => ++pdfTicket,
		get pdfTicket() { return pdfTicket; },
		nextNavigationSequence: () => ++navigationSequence,
		get navigationSequence() { return navigationSequence; },
		nextDiagnosticNavigationSequence: () => ++diagnosticNavigationSequence,
		nextPdfRevealSequence: () => ++pdfRevealSequence,
		t,
		isWorkspaceScopeCurrent,
		sourceMissingOnDisk,
		allowReplacement,
		saveSource,
		abandonCompile,
		acceptDiskSource,
		onSourceReplaced: () => { editorLoadKey++; },
		selectWorkspace,
		readDesktopFile,
		refreshWorkspaceEntries,
		refreshRecent,
		drainWorkspaceWatch: (watch) => drainWorkspaceWatch((watch as WorkspaceWatch | null | undefined) ?? activeWorkspaceWatch),
		stopWorkspaceWatch: (watch) => stopWorkspaceWatch((watch as WorkspaceWatch | null | undefined) ?? activeWorkspaceWatch),
		startWorkspaceWatch,
		workspaceWatchIsCurrent: (watch) => workspaceWatchIsCurrent(watch as WorkspaceWatch),
		workspaceWatchCanDrain: (watch) => workspaceWatchCanDrain(watch as WorkspaceWatch),
		suspendWorkspaceWatch: (watch) => suspendWorkspaceWatch(watch as WorkspaceWatch),
		queueWorkspaceEvent: (watch, queued) => queueWorkspaceEvent(watch as WorkspaceWatch, queued),
		setExternalFileNotice: (watch, documentId, path, kind) => setExternalFileNotice(watch as WorkspaceWatch, documentId, path, kind),
		clearExternalFileNotice,
		invalidateSynctexForSourceChange,
		invalidateSynctexForWorkspacePath,
		resetDraftSelection,
		clickSourceInput: () => sourceInput.click()
	};
</script>

<svelte:head><title>{sourceName ? sourceName + ' — ' : ''}ModuTeX</title></svelte:head>
<svelte:window onkeydown={shortcuts} />
<input class="file-input" bind:this={sourceInput} type="file" accept=".tex" aria-label={t('開啟 TeX 文件', 'Open TeX document')} onchange={openSource} />
<input class="file-input" bind:this={pdfInput} type="file" accept=".pdf" aria-label={t('開啟 PDF 文件', 'Open PDF')} onchange={openPdf} />
<div class="app" class:workbench-active={route === 'workbench'} lang={preferences.language} style:--source-font-size={`${preferences.sourceFontSize}px`}>
	<header class="global-bar">
		<nav class="global-navigation" aria-label={t('導覽', 'Main navigation')}>
			<a class="brand" href="#/">ModuTeX</a>
			<a class="secondary-navigation" href="#/" aria-current={route === 'home' ? 'page' : undefined}>{t('首頁', 'Home')}</a>
			<a class="secondary-navigation" href="#/workbench" aria-current={route === 'workbench' ? 'page' : undefined}>{t('工作台', 'Workbench')}</a>
			<AppMenu label={t('檔案', 'File')} menuClass="secondary-navigation file-menu">
				<button type="button" onclick={() => newDocument('blank')} disabled={opening || saving || compiling || confirming}>{t('新增文件', 'New document')}</button>
				<button type="button" onclick={() => openWorkspaceFileCreate()} disabled={opening || saving || compiling || confirming}>{t('新增工作區檔案', 'New workspace file')}</button>
				<button type="button" onclick={() => void chooseSource()} disabled={opening || saving}>{t('開啟文件', 'Open document')}</button>
				{#if desktop}<button type="button" onclick={() => void chooseSource('folder')} disabled={opening || saving}>{t('開啟資料夾', 'Open folder')}</button>{/if}
				<hr />
				{#if desktop && source}
					<button type="button" onclick={saveSource} disabled={opening || saving || compiling || confirming || !dirty || sourceMissingOnDisk()}>{saving ? t('儲存中…', 'Saving…') : t('儲存', 'Save')}</button>
					<button type="button" onclick={saveSourceAs} disabled={opening || saving || compiling || confirming}>{t('另存新檔', 'Save as')}</button>
				{/if}
			</AppMenu>
			<div class="global-actions">
				{#if route === 'workbench' && desktop && source && !sourceMissingOnDisk()}
					<div class="global-compile-primary" inert={desktopLoading}>
						{#if compiling}
							<button type="button" class="primary" onclick={cancelCompile} disabled={compileCancellationRequestedFor === compileTicket}>{compileCancellationRequestedFor === compileTicket ? t('正在取消…', 'Cancelling…') : t('取消編譯', 'Cancel compilation')}</button>
						{:else}
							<button type="button" class="primary" onclick={compileSource} disabled={opening || saving || confirming}>{t('編譯 PDF', 'Compile PDF')}</button>
						{/if}
					</div>
				{/if}
				<AppMenu label={t('更多', 'More')} menuClass="more-menu">
					<div class="compact-menu-group">
						<a href="#/" aria-current={route === 'home' ? 'page' : undefined}>{t('首頁', 'Home')}</a>
						<a href="#/workbench" aria-current={route === 'workbench' ? 'page' : undefined}>{t('工作台', 'Workbench')}</a>
						<button type="button" onclick={() => newDocument('blank')} disabled={opening || saving || compiling || confirming}>{t('新增文件', 'New document')}</button>
						<button type="button" onclick={() => openWorkspaceFileCreate()} disabled={opening || saving || compiling || confirming}>{t('新增工作區檔案', 'New workspace file')}</button>
						<button type="button" onclick={() => void chooseSource()} disabled={opening || saving}>{t('開啟文件', 'Open document')}</button>
						{#if desktop}<button type="button" onclick={() => void chooseSource('folder')} disabled={opening || saving}>{t('開啟資料夾', 'Open folder')}</button>{/if}
						{#if desktop && source}
							<button type="button" onclick={saveSource} disabled={opening || saving || compiling || confirming || !dirty || sourceMissingOnDisk()}>{t('儲存', 'Save')}</button>
							<button type="button" onclick={saveSourceAs} disabled={opening || saving || compiling || confirming}>{t('另存新檔', 'Save as')}</button>
						{/if}
					</div>
					<hr class="compact-menu-separator" />
					<a href="#/settings" aria-current={route === 'settings' ? 'page' : undefined}>{t('設定', 'Settings')}</a>
					<a href="#/help" aria-current={route === 'help' ? 'page' : undefined}>{t('說明', 'Help')}</a>
					<a href="#/release-notes" aria-current={route === 'release-notes' ? 'page' : undefined}>{t('版本紀錄', 'Release notes')}</a>
					{#await import('./components/LanguageMenu.svelte') then { default: LanguageMenu }}<LanguageMenu locale={preferences.language} onChange={language => changePreference('language', language)} />{/await}
					{#if isTauri()}<hr /><button type="button" onclick={openNewWindow} disabled={openingWindow}>{t('新增視窗', 'New window')}</button>{/if}
				</AppMenu>
			</div>
		</nav>
	</header>
	{#if isTauri() && rootStateReady}
		{#await import('./features/updates/UpdateNotice.svelte') then { default: UpdateNotice }}
			<UpdateNotice
				language={preferences.language}
				installAllowed={!opening && !saving && !compiling && !confirming && !draftPanelOpen}
				needsSave={dirty}
				busyReason={compiling ? 'compiling' : (opening || saving || confirming || draftPanelOpen ? 'busy' : null)}
				beforeInstall={prepareUpdateInstall}
				canInstall={canInstallUpdate}
			/>
		{/await}
	{/if}
	{#if route === 'workbench' && (compiling || compileNotice)}
		<div class="compile-status" role="status" aria-live="polite">
			{compiling ? t('編譯中…', 'Compiling…') : compileNotice}
			{#if !compiling && (compileLog || diagnostics.length)}
				<button class="text-button" type="button" onclick={() => activeDockTab = diagnostics.length ? 'problems' : 'output'}>
					{diagnostics.length ? t('查看問題', 'View problems') : t('查看輸出', 'View output')}
				</button>
			{/if}
			{#if !compiling && compileNoticeState?.[1] === 'Compilation completed'}
				 · {pdfDisplayFailed ? t('PDF 無法顯示，請查看錯誤訊息。', 'PDF could not be displayed. Review the error message.') : pdfRendered ? t('PDF 已更新', 'PDF updated') : t('正在顯示 PDF…', 'Displaying PDF…')}
			{/if}
			{#if compiling || compileNoticeState?.[1] === 'Compilation completed' && !pdfRendered && !pdfDisplayFailed}
				<div class="compile-progress" role="progressbar" aria-label={t('編譯進度', 'Compilation progress')}
					aria-valuetext={compiling ? compileCancellationRequestedFor === compileTicket ? t('正在取消編譯', 'Cancelling compilation') : t('編譯中', 'Compiling') : t('正在顯示 PDF', 'Displaying PDF')}><span></span></div>
			{/if}
		</div>
	{/if}
	{#if route !== 'workbench'}
	<div class="app-page-content">
	{#if route === 'home'}{#key homeLoadKey}{#await import('./pages/Home.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟首頁…', 'Loading home…')}</p></main>{:then { default: Home }}<Home locale={preferences.language} desktop={!!desktop} busy={opening || saving || compiling || desktopLoading} currentName={sourceName} {dirty} {recent} {recentNotice} onRecent={openRecent} onRemoveRecent={removeRecent} onOpen={openFromHome} onCreate={newDocument} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入首頁，文件內容已保留。', 'Home could not be loaded. Your document is preserved.')}</p><button onclick={() => homeLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	{#if route === 'settings'}
		{#key settingsLoadKey}
			{#await import('./pages/Settings.svelte')}
				<main class="empty-state" role="status"><p>{t('正在開啟設定…', 'Loading settings…')}</p></main>
			{:then { default: Settings }}
				<Settings
					{preferences}
					{desktop}
					{workspace}
					{entries}
					source={source}
					sourcePath={sourceName}
					sourceDirty={dirty}
					sourceCommandDisabled={opening || saving || confirming || compiling}
					onApplySourcePatches={applySettingsSourcePatches}
					activeSection={settingsSection}
					locale={preferences.language}
					notice={preferencesNotice}
					onChange={changePreference}
					onRestore={restoreDefaults}
					onSectionChange={updateSettingsSection}
				/>
			{:catch}
				<main class="empty-state" role="alert"><p>{t('無法載入設定，文件內容已保留。', 'Settings could not be loaded. Your document is preserved.')}</p><button onclick={() => settingsLoadKey++}>{t('重試', 'Retry')}</button></main>
			{/await}
		{/key}
	{/if}
	{#if route === 'release-notes'}{#key releaseLoadKey}{#await import('./pages/ReleaseNotes.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟版本紀錄…', 'Loading release notes…')}</p></main>{:then { default: ReleaseNotes }}<ReleaseNotes locale={preferences.language} {showLimitations} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入版本紀錄，文件內容已保留。', 'Release notes could not be loaded. Your document is preserved.')}</p><button onclick={() => releaseLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	{#if route === 'help'}{#key helpLoadKey}{#await import('./pages/Help.svelte')}<main class="empty-state" role="status"><p>{t('正在開啟說明…', 'Loading help…')}</p></main>{:then { default: Help }}<Help locale={preferences.language} topic={selectedHelp} />{:catch}<main class="empty-state" role="alert"><p>{t('無法載入說明，文件內容已保留。', 'Help could not be loaded. Your document is preserved.')}</p><button onclick={() => helpLoadKey++}>{t('重試', 'Retry')}</button></main>{/await}{/key}{/if}
	</div>
	{/if}
	<main class="workbench" hidden={route !== 'workbench'} inert={route !== 'workbench'}>
		{#if externalFileNotice && source && externalFileNotice.documentId === source.documentId && externalFileNotice.path === sourceName}
			<section class="error-strip file-change-notice" data-kind={externalFileNotice.kind}
				role={externalFileNotice.acknowledged ? 'status' : 'alert'} aria-live="polite">
				<span>
					{#if externalFileNotice.kind === 'missing'}
						{externalFileNotice.acknowledged
							? t('磁碟上的文件已刪除。草稿已保留。請使用另存新檔儲存。', 'The disk file was deleted. Your draft is kept. Use Save as to preserve it.')
							: t('「' + externalFileNotice.path + '」已被刪除。', 'The disk file "' + externalFileNotice.path + '" was deleted. Your draft is preserved and cannot be saved to that path.')}
					{:else}
						{externalFileNotice.acknowledged
							? t('磁碟文件已變更。草稿已保留。如要載入磁碟版本，請重新載入。', 'The disk file changed. Your draft is kept. Reload to use the disk version.')
							: t('磁碟上的「' + externalFileNotice.path + '」已變更。草稿仍保留。重新載入會取代草稿。', 'The disk file "' + externalFileNotice.path + '" changed. Your draft is preserved. Reloading will replace it.')}
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
					: t('無法監看資料夾變更。文件仍可編輯。請重新連線以同步檔案。', 'Folder changes cannot be monitored. You can keep editing. Reconnect to sync files.')}</span>
				<button class="text-button" onclick={recoverWorkspaceWatch} disabled={opening || saving}>
					{workspaceWatchIssue === 'reconcile' ? t('重新同步', 'Reconcile now') : t('重新連線', 'Reconnect')}
				</button>
			</section>
		{/if}
		{#if workbenchVisited}
		{#key workbenchLoadKey}
		{#await Promise.all([import('./components/WorkbenchChrome.svelte'), import('./features/source-editor/outline.ts'), loadWorkbenchRuntime()])}
			<div class="empty-state" role="status"><p>{t('正在開啟工作台…', 'Loading workbench…')}</p></div>
		{:then [{ default: WorkbenchChrome }, { sourceOutline }, { fileErrorDescriptor }]}
		<WorkbenchChrome
			locale={preferences.language}
			{route}
			bind:workbenchPane
			bind:workbenchSplitRatio
			bind:draftPanelOpen
			bind:workspaceFilesButton
			bind:pdfLoadKey
			bind:pageCount
			bind:pdfRendered
			bind:pdfDisplayFailed
			bind:draftSelectionSnapshot
			bind:draftSelectionWarning
			bind:activeDockTab
			desktop={!!desktop}
			{workspace}
			{workspaceFiles}
			{workspaceFilesAvailability}
			{entries}
			{source}
			{sourceName}
			{revision}
			{dirty}
			{opening}
			{saving}
			{compiling}
			{diagnostics}
			{compileLog}
			canNavigateDiagnostic={(diagnostic) => workbenchRuntime?.canNavigateDiagnosticState(runtimeHost, diagnostic) ?? false}
			navigateToDiagnostic={(diagnostic) => workbenchRuntime?.runNavigateToDiagnostic(runtimeHost, diagnostic)}
			{confirming}
			missingOnDisk={sourceMissingOnDisk()}
			aborted={lifetime.signal.aborted}
			{projection}
			{outline}
			{outlineOwner}
			{outlineFailed}
			{pdfBytes}
			{pdfName}
			{pdfIdentity}
			{pdfReveal}
			{synctexIndex}
			{sourceViewInstance}
			onOpenWorkspaceFiles={openWorkspaceFiles}
			onNewWorkspaceFile={openWorkspaceFileCreate}
			onChooseSource={chooseSource}
			onReadDesktopFile={(path, owner) => readDesktopFile(path, owner)}
			onCompileWorkspaceFile={compileWorkspaceFile}
			onNavigateHeading={(span) => { navigation = { span, sequence: ++navigationSequence }; }}
			onForwardSynctex={forwardSynctex}
			onPdfPoint={handlePdfPoint}
			onPdfError={(code) => { errorState = fileErrorDescriptor(new Error(code)); }}
			onOpenPdfClick={() => pdfInput.click()}
			onSaveSourceForDraft={saveSourceForDraft}
		>
			{#snippet sourceEditor({ active })}
				{#if source}
					{#key source.documentId + ':' + editorLoadKey}
					{#await import('./features/source-editor/SourceView.svelte')}
						<div class="empty-state" role="status"><p>{t('正在開啟編輯器…', 'Loading editor…')}</p></div>
					{:then { default: SourceView }}
						<SourceView bind:this={sourceViewInstance} document={source} label={sourceName} saving={saving || opening} {savedVersion} active={route === 'workbench' && active} formatWorkspaceId={workspace?.id ?? null}
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
				{/if}
			{/snippet}
		</WorkbenchChrome>
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
				initialTool={workspaceFilesInitialTool}
				initialPath={workspaceFilesInitialPath}
				openSequence={workspaceFilesOpenSequence}
				onOpen={async (path) => { await readDesktopFile(path, panelOwner); }}
				onCompile={async (path) => { await compileWorkspaceFile(path, panelOwner); }}
				onCreatedFile={async (path) => {
					if (workspace !== panelOwner || !isWorkspaceScopeCurrent(panelOwner, panelGeneration)) return false;
					const previousSource = source;
					await readDesktopFile(path, panelOwner);
					return workspace === panelOwner && isWorkspaceScopeCurrent(panelOwner, panelGeneration) &&
						!!source && source !== previousSource && sourceName === path && revision !== null && !dirty;
				}}
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
