// SPDX-License-Identifier: Apache-2.0
import { invoke, isTauri } from '@tauri-apps/api/core';
import { tick } from 'svelte';
import type {
	CompileHandle,
	CompileIdentity,
	Diagnostic,
	FileEntry,
	FileEvent,
	ReadReceipt,
	WorkspaceInfo
} from '@modutex/frontend-contracts';
import type { SourceDocument, SourceSpan } from '../document-core/core.ts';
import type { FileDesktopPort } from '../files/desktop.ts';
import type { TemplateId } from '../files/templates.ts';
import type { WorkspaceFilesPort, WorkspaceFilesTask } from '../files/workspace-files.ts';
import type { DiagnosticNavigationRequest } from '../source-editor/diagnostics.ts';
import type { BoundSynctexIndex, SynctexPdfLocation, SynctexSourceLocation } from './synctex.ts';
import { sameCompileIdentity } from './identity.ts';

export type NoticeDescriptor = [string, string] | { readonly raw: string };
export type LineDiagnostic = Diagnostic & { readonly path: string; readonly line: number };

export interface SourceViewHandle {
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

export interface DraftSelectionSnapshot {
	readonly workspaceId: string;
	readonly entryPath: string;
	readonly documentId: string;
	readonly documentVersion: number;
	readonly from: number;
	readonly to: number;
}

export interface DiagnosticContext {
	readonly identity: CompileIdentity;
	readonly owner: WorkspaceInfo;
	readonly source: SourceDocument;
	readonly sourceName: string;
	readonly revision: string;
}

export interface PendingOpenReceipt {
	readonly workspace: WorkspaceInfo;
	readonly path: string;
}

export interface ExternalFileNoticeState {
	readonly kind: 'changed' | 'missing';
	readonly documentId: string;
	readonly path: string;
	readonly acknowledged: boolean;
}

export interface QueuedWorkspaceEvent {
	readonly event: FileEvent;
}

export interface WorkbenchWatchLike {
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

export interface WorkbenchRuntimeHost {
	readonly lifetime: AbortController;
	desktop: FileDesktopPort | null;
	workspace: WorkspaceInfo | null;
	readonly workspaceGeneration: number;
	workspaceFiles: WorkspaceFilesPort | null;
	workspaceFilesAvailability: 'checking' | 'available' | 'unavailable';
	workspaceFilesOpen: boolean;
	readonly workspaceTreeTasks: Set<WorkspaceFilesTask<readonly FileEntry[]>>;
	nextWorkspaceEntriesTicket(): number;
	readonly workspaceEntriesTicket: number;
	source: SourceDocument | null;
	sourceName: string;
	revision: string | null;
	savedVersion: number | null;
	hasDiskCheckpoint: boolean;
	dirty: boolean;
	opening: boolean;
	saving: boolean;
	confirming: boolean;
	compiling: boolean;
	compileHandle: CompileHandle | null;
	compileLog: string;
	showCompileDetails: boolean;
	compileTicket: number;
	compileCancellationRequestedFor: number | null;
	compileCancellationFailedFor: number | null;
	diagnostics: readonly Diagnostic[];
	diagnosticIdentity: CompileIdentity | null;
	pdfIdentity: CompileIdentity | null;
	pdfBytes: Uint8Array | null;
	pdfName: string;
	pageCount: number;
	pdfReveal: { page: number; x: number; y: number; requestId: number } | undefined;
	synctexIndex: BoundSynctexIndex | null;
	workbenchPane: 'document' | 'pdf';
	route: 'home' | 'workbench' | 'settings' | 'compile-settings' | 'release-notes' | 'help';
	draftPanelOpen: boolean;
	outlineFailed: boolean;
	entries: readonly FileEntry[];
	errorState: NoticeDescriptor | null;
	compileNoticeState: [string, string] | null;
	externalFileNotice: ExternalFileNoticeState | null;
	workspaceWatchIssue: 'offline' | 'reconcile' | null;
	pendingOpenArmed: boolean;
	sourceViewInstance: SourceViewHandle | null;
	navigation: { readonly span: SourceSpan; readonly sequence: number; readonly sourceOnly?: boolean } | null;
	diagnosticNavigation: DiagnosticNavigationRequest | null;
	readonly activeWorkspaceWatch: WorkbenchWatchLike | null;
	nextSourceTicket(): number;
	readonly sourceTicket: number;
	nextPdfTicket(): number;
	readonly pdfTicket: number;
	nextNavigationSequence(): number;
	readonly navigationSequence: number;
	nextDiagnosticNavigationSequence(): number;
	nextPdfRevealSequence(): number;
	t(zh: string, en: string): string;
	isWorkspaceScopeCurrent(owner: WorkspaceInfo, generation: number): boolean;
	sourceMissingOnDisk(): boolean;
	allowReplacement(): Promise<boolean>;
	saveSource(): Promise<void>;
	abandonCompile(): void;
	acceptDiskSource(document: SourceDocument, path: string, nextRevision: string): void;
	selectWorkspace(owner: WorkspaceInfo | null): void;
	readDesktopFile(path: string, owner: WorkspaceInfo, manageBusy?: boolean): Promise<void>;
	refreshWorkspaceEntries(owner: WorkspaceInfo, generation: number): Promise<readonly FileEntry[] | null>;
	refreshRecent(): Promise<void>;
	drainWorkspaceWatch(watch?: WorkbenchWatchLike | null): Promise<void>;
	stopWorkspaceWatch(watch?: WorkbenchWatchLike | null): void;
	startWorkspaceWatch(owner: WorkspaceInfo): void;
	workspaceWatchIsCurrent(watch: WorkbenchWatchLike): boolean;
	workspaceWatchCanDrain(watch: WorkbenchWatchLike): boolean;
	suspendWorkspaceWatch(watch: WorkbenchWatchLike): void;
	queueWorkspaceEvent(watch: WorkbenchWatchLike, queued: QueuedWorkspaceEvent): void;
	setExternalFileNotice(
		watch: WorkbenchWatchLike,
		documentId: string,
		path: string,
		kind: 'changed' | 'missing'
	): void;
	clearExternalFileNotice(documentId: string, path: string): void;
	invalidateSynctexForSourceChange(path: string, nextRevision: string): void;
	invalidateSynctexForWorkspacePath(workspaceId: string, path: string): void;
	resetDraftSelection(): void;
	clickSourceInput(): void;
}

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

export function fileErrorDescriptor(value: unknown): [string, string] {
	const code = value instanceof Error ? value.message : '';
	const entry = messages[code];
	return entry ?? ['無法開啟文件，請檢查檔案與讀取權限。', 'Unable to open document. Check the file and access.'];
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

export function captureDraftSelectionSnapshot(
	current: SourceDocument | null,
	owner: WorkspaceInfo | null,
	path: string,
	view: SourceViewHandle | null
): DraftSelectionSnapshot | null {
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
	return Object.freeze({
		workspaceId: owner.id,
		entryPath: path,
		documentId: current.documentId,
		documentVersion: current.version,
		from,
		to
	});
}

export function canForwardSynctexState(
	source: SourceDocument | null,
	pdfBytes: Uint8Array | null,
	synctexIndex: BoundSynctexIndex | null,
	pdfIdentity: CompileIdentity | null,
	workspace: WorkspaceInfo | null,
	dirty: boolean,
	sourceName: string,
	revision: string | null
): boolean {
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

export function hasDiagnosticLocation(diagnostic: Diagnostic): diagnostic is LineDiagnostic {
	return diagnostic.path !== null && diagnostic.line !== null &&
		Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0;
}

export function safeWorkspaceDiagnosticPath(path: string): string | null {
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

export function captureDiagnosticContext(host: WorkbenchRuntimeHost): DiagnosticContext | null {
	const identity = host.diagnosticIdentity;
	const owner = host.workspace;
	const current = host.source;
	const currentRevision = host.revision;
	if (!host.desktop || host.lifetime.signal.aborted || host.opening || host.saving || host.compiling ||
		!identity || !owner || !current || !currentRevision ||
		identity.workspaceId !== owner.id || identity.entryPath !== host.sourceName ||
		identity.documentId !== current.documentId || identity.documentVersion !== current.version ||
		identity.savedRevision !== currentRevision) return null;
	return { identity, owner, source: current, sourceName: host.sourceName, revision: currentRevision };
}

export function diagnosticContextIsCurrent(
	host: WorkbenchRuntimeHost,
	context: DiagnosticContext,
	ticket?: number
): boolean {
	const owner = host.workspace;
	const current = host.source;
	if (host.lifetime.signal.aborted || !host.desktop || !owner || owner !== context.owner ||
		owner.id !== context.identity.workspaceId || !current || current !== context.source ||
		current.documentId !== context.identity.documentId ||
		current.version !== context.identity.documentVersion ||
		host.sourceName !== context.sourceName || context.identity.entryPath !== context.sourceName ||
		host.revision !== context.revision || context.identity.savedRevision !== context.revision ||
		host.diagnosticIdentity !== context.identity) return false;
	return ticket === undefined || ticket === host.sourceTicket;
}

export function canNavigateDiagnosticState(
	host: WorkbenchRuntimeHost,
	diagnostic: Diagnostic
): boolean {
	if (!hasDiagnosticLocation(diagnostic)) return false;
	const context = captureDiagnosticContext(host);
	return !!context &&
		safeWorkspaceDiagnosticPath(diagnostic.path) !== null &&
		safeWorkspaceDiagnosticPath(context.sourceName) !== null;
}

export function compileErrorDescriptor(value: unknown): [string, string] {
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

export function windowErrorNotice(value: unknown): NoticeDescriptor {
	const message = value instanceof Error
		? value.message
		: typeof value === 'string'
			? value
			: value && typeof value === 'object' && 'message' in value && typeof (value as { message: unknown }).message === 'string'
				? (value as { message: string }).message
				: value
					? String(value)
					: '';
	return message ? { raw: message } : ['無法開啟新視窗。', 'Unable to open new window.'];
}

export async function runRefreshWorkspaceEntries(
	host: WorkbenchRuntimeHost,
	owner: WorkspaceInfo,
	generation: number
): Promise<readonly FileEntry[] | null> {
	const port = host.desktop;
	if (!port || !host.isWorkspaceScopeCurrent(owner, generation)) return null;
	const ticket = host.nextWorkspaceEntriesTicket();
	for (const pending of host.workspaceTreeTasks) void pending.cancel().catch(() => {});
	const files = host.workspaceFiles;
	if (files && host.workspaceFilesAvailability !== 'unavailable') {
		let task: WorkspaceFilesTask<readonly FileEntry[]> | null = null;
		try {
			task = files.startTree(owner.id);
			host.workspaceTreeTasks.add(task);
			const listed = await task.result;
			if (!host.isWorkspaceScopeCurrent(owner, generation) || ticket !== host.workspaceEntriesTicket) return null;
			host.workspaceFilesAvailability = 'available';
			host.entries = listed;
			return listed;
		} catch (value) {
			const { isWorkspaceFilesCapabilityUnavailable } = await import('../files/workspace-files.ts');
			if (!host.isWorkspaceScopeCurrent(owner, generation) || ticket !== host.workspaceEntriesTicket) return null;
			if (isWorkspaceFilesCapabilityUnavailable(value)) {
				host.workspaceFilesAvailability = 'unavailable';
				host.workspaceFilesOpen = false;
			} else {
				host.workspaceFilesAvailability = 'available';
				host.errorState = fileErrorDescriptor(value);
			}
		} finally {
			if (task) host.workspaceTreeTasks.delete(task);
		}
	}
	try {
		const listed = await port.listFiles(owner.id);
		if (!host.isWorkspaceScopeCurrent(owner, generation) || ticket !== host.workspaceEntriesTicket) return null;
		host.entries = listed;
		return listed;
	} catch (value) {
		if (host.isWorkspaceScopeCurrent(owner, generation) && ticket === host.workspaceEntriesTicket) {
			host.errorState = fileErrorDescriptor(value);
		}
		return null;
	}
}

export async function runCompileWorkspaceFile(
	host: WorkbenchRuntimeHost,
	path: string,
	owner: WorkspaceInfo
): Promise<void> {
	if (!host.desktop || host.opening || host.saving || host.compiling || host.workspace !== owner) return;
	let config;
	try {
		config = await host.desktop.getCompileConfig(owner.id);
	} catch {
		config = null;
	}
	if (host.workspace !== owner) return;
	const mainPath = config?.mainFile ?? null;
	if (mainPath && mainPath === path) {
		await runCompileSource(host);
		return;
	}
	if (host.sourceName !== path) {
		await runReadDesktopFile(host, path, owner);
	}
	if (host.workspace === owner && host.sourceName === path) {
		await runCompileSource(host);
	}
}

export async function runReadDesktopFile(
	host: WorkbenchRuntimeHost,
	path: string,
	owner: WorkspaceInfo,
	manageBusy = true
): Promise<void> {
	if (!host.desktop) return;
	if (manageBusy && (host.opening || host.confirming)) return;
	const pdf = path.toLowerCase().endsWith('.pdf');
	if (manageBusy && !pdf) {
		const previous = host.source;
		const previousVersion = previous?.version;
		const previousRevision = host.revision;
		if (!await host.allowReplacement()) return;
		if (host.lifetime.signal.aborted || host.workspace !== owner ||
			host.source !== previous || host.source?.version !== previousVersion || host.revision !== previousRevision) return;
	}
	if (!pdf) host.abandonCompile();
	const ticket = pdf ? host.nextPdfTicket() : host.nextSourceTicket();
	if (manageBusy) host.opening = true;
	host.errorState = null;
	try {
		const [receipt, reader] = await Promise.all([
			host.desktop.readFile({ workspaceId: owner.id, path }),
			pdf ? null : import('../files/read.ts')
		]);
		if (host.workspace !== owner || ticket !== (pdf ? host.pdfTicket : host.sourceTicket)) return;
		installDesktopReadReceipt(host, path, receipt, reader?.readSourceBytes(receipt.bytes) ?? null);
	} catch (value) {
		if (host.workspace === owner && ticket === (pdf ? host.pdfTicket : host.sourceTicket)) {
			host.errorState = fileErrorDescriptor(value);
		}
	} finally {
		if (manageBusy && host.workspace === owner && ticket === (pdf ? host.pdfTicket : host.sourceTicket)) {
			host.opening = false;
			void host.drainWorkspaceWatch();
		}
	}
}

function installDesktopReadReceipt(
	host: WorkbenchRuntimeHost,
	path: string,
	receipt: ReadReceipt,
	document: SourceDocument | null
): { readonly source: boolean } {
	const pdf = path.toLowerCase().endsWith('.pdf');
	if (pdf) {
		host.draftPanelOpen = false;
		if (new TextDecoder('ascii').decode(receipt.bytes.subarray(0, 5)) !== '%PDF-') {
			throw new Error('PDF_HEADER');
		}
		host.pdfBytes = receipt.bytes;
		host.pdfIdentity = null;
		host.pdfName = path;
		host.pageCount = 0;
		host.synctexIndex?.dispose();
		host.synctexIndex = null;
		host.pdfReveal = undefined;
		host.workbenchPane = 'pdf';
	} else {
		host.resetDraftSelection();
		if (!document) throw new Error('FILE_TYPE');
		host.source = document;
		host.outlineFailed = false;
		host.sourceName = path;
		host.revision = receipt.revision;
		host.savedVersion = null;
		host.hasDiskCheckpoint = true;
		host.dirty = false;
		host.externalFileNotice = null;
		host.workbenchPane = 'document';
	}
	host.route = 'workbench';
	window.location.hash = '#/workbench';
	return { source: !pdf };
}

export async function runChooseSource(
	host: WorkbenchRuntimeHost,
	kind: 'file' | 'folder' = 'file',
	recentId?: string
): Promise<void> {
	if (host.opening || host.saving || host.confirming) return;
	const previous = host.source;
	const owner = host.workspace;
	const previousVersion = previous?.version;
	const previousRevision = host.revision;
	if (!await host.allowReplacement()) return;
	if (host.lifetime.signal.aborted || host.opening || host.saving ||
		host.source !== previous || host.workspace !== owner ||
		host.source?.version !== previousVersion || host.revision !== previousRevision) return;
	if (!host.desktop) {
		host.clickSourceInput();
		return;
	}
	host.opening = true;
	host.errorState = null;
	try {
		const selected = recentId ? await host.desktop.openRecent(recentId) : await host.desktop.openWorkspace(kind);
		if (!selected) return;
		host.draftPanelOpen = false;
		host.stopWorkspaceWatch();
		host.workspaceWatchIssue = null;
		host.externalFileNotice = null;
		host.abandonCompile();
		host.selectWorkspace(selected);
		host.nextSourceTicket();
		host.nextPdfTicket();
		host.source = null;
		host.sourceName = '';
		host.dirty = false;
		host.revision = null;
		host.savedVersion = null;
		host.pdfBytes = null;
		host.pdfIdentity = null;
		host.pdfName = '';
		host.pageCount = 0;
		host.entries = [];
		if (selected.entryPath) {
			host.entries = [{ path: selected.entryPath, kind: 'file' }];
			await runReadDesktopFile(host, selected.entryPath, selected, false);
		}
		await runRefreshWorkspaceEntries(host, selected, host.workspaceGeneration);
	} catch (value) {
		if (!host.lifetime.signal.aborted) host.errorState = fileErrorDescriptor(value);
	} finally {
		if (!host.lifetime.signal.aborted) {
			host.opening = false;
			void host.refreshRecent();
			void host.drainWorkspaceWatch();
		}
	}
}

export async function runOpenSource(
	host: WorkbenchRuntimeHost,
	file: File,
	clearInput: () => void
): Promise<void> {
	if (host.opening || host.saving || host.confirming) {
		clearInput();
		return;
	}
	const previous = host.source;
	const owner = host.workspace;
	const previousVersion = previous?.version;
	const previousRevision = host.revision;
	if (!await host.allowReplacement()) {
		clearInput();
		return;
	}
	if (host.lifetime.signal.aborted || host.opening || host.saving ||
		host.source !== previous || host.workspace !== owner ||
		host.source?.version !== previousVersion || host.revision !== previousRevision) {
		clearInput();
		return;
	}
	const ticket = host.nextSourceTicket();
	host.opening = true;
	host.errorState = null;
	try {
		const { readSource } = await import('../files/read.ts');
		const document = await readSource(file);
		if (ticket === host.sourceTicket) {
			host.draftPanelOpen = false;
			host.resetDraftSelection();
			host.diagnosticNavigation = null;
			host.source = document;
			host.outlineFailed = false;
			host.sourceName = file.name;
			host.revision = null;
			host.savedVersion = null;
			host.hasDiskCheckpoint = true;
			host.dirty = false;
			host.externalFileNotice = null;
			window.location.hash = '#/workbench';
		}
	} catch (value) {
		if (ticket === host.sourceTicket) {
			host.errorState = fileErrorDescriptor(value);
		}
	} finally {
		if (ticket === host.sourceTicket) {
			host.opening = false;
			void host.drainWorkspaceWatch();
		}
		clearInput();
	}
}

export async function runOpenPdf(
	host: WorkbenchRuntimeHost,
	file: File,
	clearInput: () => void
): Promise<void> {
	const ticket = host.nextPdfTicket();
	host.errorState = null;
	try {
		const bytes = await (await import('../files/pdf-read.ts')).readPdf(file);
		if (!host.lifetime.signal.aborted && ticket === host.pdfTicket) {
			host.draftPanelOpen = false;
			host.pdfBytes = bytes;
			host.pdfIdentity = null;
			host.pdfName = file.name;
			host.pageCount = 0;
			host.synctexIndex?.dispose();
			host.synctexIndex = null;
			host.pdfReveal = undefined;
		}
	} catch (value) {
		if (!host.lifetime.signal.aborted && ticket === host.pdfTicket) {
			host.errorState = fileErrorDescriptor(value);
		}
	} finally {
		if (!host.lifetime.signal.aborted && ticket === host.pdfTicket) clearInput();
	}
}

export async function runSaveSource(host: WorkbenchRuntimeHost): Promise<void> {
	if (!host.desktop || !host.source || host.saving || host.opening || host.sourceMissingOnDisk()) return;
	if (!host.revision || !host.workspace) {
		await runSaveSourceAs(host);
		return;
	}
	const snapshot = host.source;
	const owner = host.workspace;
	const path = host.sourceName;
	host.saving = true;
	host.errorState = null;
	try {
		const receipt = await host.desktop.writeFile({
			workspaceId: owner.id,
			path,
			bytes: snapshot.toBytes(),
			expectedRevision: host.revision,
			documentId: snapshot.documentId,
			documentVersion: snapshot.version
		});
		if (host.workspace === owner && host.source?.documentId === snapshot.documentId) {
			if (receipt.revision !== host.revision) host.invalidateSynctexForSourceChange(path, receipt.revision);
			host.revision = receipt.revision;
			if (host.source.version === snapshot.version) {
				host.savedVersion = snapshot.version;
				host.dirty = false;
			}
		}
	} catch (value) {
		if (!host.lifetime.signal.aborted && host.workspace === owner) host.errorState = fileErrorDescriptor(value);
	} finally {
		if (!host.lifetime.signal.aborted) {
			host.saving = false;
			void host.drainWorkspaceWatch();
		}
	}
}

function requeueWorkspaceEvent(
	host: WorkbenchRuntimeHost,
	watch: WorkbenchWatchLike,
	queued: QueuedWorkspaceEvent | null
): void {
	if (!queued) {
		watch.recoveryEvents = true;
		return;
	}
	if (!watch.pending.has(queued.event.path)) host.queueWorkspaceEvent(watch, queued);
}

async function listWatchedFiles(
	host: WorkbenchRuntimeHost,
	watch: WorkbenchWatchLike
): Promise<readonly FileEntry[] | null> {
	const port = host.desktop;
	if (!port || !host.workspaceWatchIsCurrent(watch)) return null;
	try {
		const listed = await port.listFiles(watch.owner.id);
		return host.workspaceWatchIsCurrent(watch) ? listed : null;
	} catch {
		host.suspendWorkspaceWatch(watch);
		return null;
	}
}

async function reconcileSourceFromDisk(
	host: WorkbenchRuntimeHost,
	watch: WorkbenchWatchLike,
	documentId: string,
	path: string,
	queued: QueuedWorkspaceEvent | null
): Promise<void> {
	const port = host.desktop;
	const snapshot = host.source;
	if (!port || !host.workspaceWatchIsCurrent(watch) || !snapshot ||
		snapshot.documentId !== documentId || host.sourceName !== path) return;
	if (host.opening || host.saving) {
		requeueWorkspaceEvent(host, watch, queued);
		return;
	}
	const snapshotVersion = snapshot.version;
	const dirtyAtRead = host.dirty;
	const revisionAtRead = host.revision;
	let receipt;
	try {
		receipt = await port.readFile({ workspaceId: watch.owner.id, path });
	} catch (value) {
		if (!host.workspaceWatchIsCurrent(watch) || host.source?.documentId !== documentId || host.sourceName !== path) return;
		if (host.opening || host.saving || host.revision !== revisionAtRead) {
			requeueWorkspaceEvent(host, watch, queued);
			return;
		}
		host.invalidateSynctexForWorkspacePath(watch.owner.id, path);
		const refreshed = await listWatchedFiles(host, watch);
		if (!refreshed || host.source?.documentId !== documentId || host.sourceName !== path) return;
		host.entries = refreshed;
		const exists = refreshed.some((entry) => entry.kind === 'file' && entry.path === path);
		host.setExternalFileNotice(watch, documentId, path, exists ? 'changed' : 'missing');
		host.errorState = fileErrorDescriptor(value);
		return;
	}
	if (!host.workspaceWatchIsCurrent(watch) || host.source?.documentId !== documentId || host.sourceName !== path) return;
	if (host.opening || host.saving || host.revision !== revisionAtRead) {
		requeueWorkspaceEvent(host, watch, queued);
		return;
	}
	if (receipt.revision === host.revision) {
		host.clearExternalFileNotice(documentId, path);
		return;
	}
	host.invalidateSynctexForWorkspacePath(watch.owner.id, path);
	if (host.source !== snapshot || host.source.version !== snapshotVersion || host.dirty !== dirtyAtRead || dirtyAtRead) {
		host.setExternalFileNotice(watch, documentId, path, 'changed');
		return;
	}
	try {
		const { readSourceBytes } = await import('../files/read.ts');
		const reloaded = readSourceBytes(receipt.bytes);
		if (!host.workspaceWatchIsCurrent(watch) || host.source !== snapshot ||
			host.source?.documentId !== documentId || host.source.version !== snapshotVersion ||
			host.sourceName !== path || host.dirty || host.revision !== revisionAtRead) {
			host.setExternalFileNotice(watch, documentId, path, 'changed');
			return;
		}
		host.invalidateSynctexForSourceChange(path, receipt.revision);
		host.acceptDiskSource(reloaded, path, receipt.revision);
	} catch (value) {
		if (!host.workspaceWatchIsCurrent(watch) || host.source?.documentId !== documentId || host.sourceName !== path) return;
		host.setExternalFileNotice(watch, documentId, path, 'changed');
		host.errorState = fileErrorDescriptor(value);
	}
}

async function reconcileWorkspaceEvent(
	host: WorkbenchRuntimeHost,
	watch: WorkbenchWatchLike,
	queued: QueuedWorkspaceEvent | null,
	listed: readonly FileEntry[]
): Promise<void> {
	if (!host.workspaceWatchIsCurrent(watch)) return;
	const currentSource = host.source;
	if (!currentSource) return;
	const currentPath = host.sourceName;
	const exists = listed.some((entry) => entry.kind === 'file' && entry.path === currentPath);
	if (!exists) {
		host.invalidateSynctexForWorkspacePath(watch.owner.id, currentPath);
		host.setExternalFileNotice(watch, currentSource.documentId, currentPath, 'missing');
		return;
	}
	const wasMissing = host.externalFileNotice?.kind === 'missing' &&
		host.externalFileNotice.documentId === currentSource.documentId && host.externalFileNotice.path === currentPath;
	if (queued && queued.event.path !== currentPath) {
		if (wasMissing) host.setExternalFileNotice(watch, currentSource.documentId, currentPath, 'changed');
		return;
	}
	await reconcileSourceFromDisk(host, watch, currentSource.documentId, currentPath, queued);
}

export async function runDrainWorkspaceWatchLoop(
	host: WorkbenchRuntimeHost,
	watch: WorkbenchWatchLike
): Promise<void> {
	while ((watch.pending.size || watch.resync) && host.workspaceWatchCanDrain(watch)) {
		if (watch.resync) {
			if (host.source && !watch.pending.has(host.sourceName)) {
				watch.pending.set(host.sourceName, {
					event: { workspaceId: watch.owner.id, path: host.sourceName, kind: 'changed' }
				});
			}
			watch.resync = false;
		}
		const batch = [...watch.pending.values()];
		const listed = await listWatchedFiles(host, watch);
		if (!listed || watch.overflowed) return;
		host.entries = listed;
		for (const queued of batch) {
			if (!host.workspaceWatchCanDrain(watch)) return;
			if (watch.pending.get(queued.event.path) !== queued) continue;
			watch.pending.delete(queued.event.path);
			await reconcileWorkspaceEvent(host, watch, queued, listed);
		}
	}
}

export async function runRecoverWorkspaceWatch(host: WorkbenchRuntimeHost): Promise<void> {
	const watch = host.activeWorkspaceWatch;
	if (watch?.recovering) return;
	if (host.workspaceWatchIssue === 'reconcile' && watch?.overflowed &&
		host.workspaceWatchIsCurrent(watch) && !host.opening && !host.saving) {
		watch.recovering = true;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				watch.recoveryEvents = false;
				const listed = await listWatchedFiles(host, watch);
				if (listed) {
					host.entries = listed;
					await reconcileWorkspaceEvent(host, watch, null, listed);
				}
				if (!host.workspaceWatchIsCurrent(watch)) return;
				if (!watch.recoveryEvents) {
					watch.overflowed = false;
					host.workspaceWatchIssue = null;
					void host.drainWorkspaceWatch(watch);
					return;
				}
			}
		} finally {
			watch.recovering = false;
		}
		return;
	}
	const owner = host.workspace;
	if (host.workspaceWatchIssue === 'offline' && owner && host.desktop) {
		if (watch) host.stopWorkspaceWatch(watch);
		host.workspaceWatchIssue = null;
		host.startWorkspaceWatch(owner);
	}
}

export function runForwardSynctex(host: WorkbenchRuntimeHost): void {
	if (host.opening || host.saving || host.compiling || !host.source) return;
	if (!canForwardSynctexState(
		host.source,
		host.pdfBytes,
		host.synctexIndex,
		host.pdfIdentity,
		host.workspace,
		host.dirty,
		host.sourceName,
		host.revision
	) || !host.synctexIndex || !host.pdfIdentity) {
		host.errorState = ['文件已變更或預覽未就緒，無法定位。', 'Document changed or preview not ready. Cannot locate.'];
		return;
	}
	const sel = host.sourceViewInstance?.getEditorSelection(host.source.documentId, host.source.version);
	if (!sel) {
		host.errorState = ['無法取得游標位置，請將游標放在編輯器中再試。', 'Could not read the cursor position. Place the cursor in the editor and retry.'];
		return;
	}
	const line = sel.cursor.line;
	let loc: SynctexPdfLocation | null = null;
	try {
		loc = host.synctexIndex.forwardSearch(line, null, host.sourceName);
	} catch {
		loc = null;
	}
	if (!loc) {
		host.errorState = ['找不到此行在 PDF 中的對應位置。', 'Could not locate this line in the PDF.'];
		return;
	}
	host.pdfReveal = {
		page: loc.page,
		x: loc.x,
		y: loc.y,
		requestId: host.nextPdfRevealSequence()
	};
	host.workbenchPane = 'pdf';
}

export async function runHandlePdfPoint(
	host: WorkbenchRuntimeHost,
	point: { page: number; x: number; y: number }
): Promise<void> {
	if (host.opening || host.saving || host.confirming) return;
	if (!host.synctexIndex || !host.pdfIdentity || !sameCompileIdentity(host.synctexIndex.identity, host.pdfIdentity)) return;
	if (!host.workspace || host.workspace.id !== host.synctexIndex.identity.workspaceId) return;
	if (host.lifetime.signal.aborted) return;
	let loc: SynctexSourceLocation | null = null;
	try {
		loc = host.synctexIndex.inverseSearch(point.page, point.x, point.y);
	} catch {
		return;
	}
	if (!loc) return;
	const targetPath = safeWorkspaceDiagnosticPath(loc.path);
	if (!targetPath) return;
	const owner = host.workspace;
	const current = host.source;
	if (current && host.sourceName === targetPath) {
		const entryIdentity = host.synctexIndex.identity;
		if (host.dirty ||
			(host.sourceName === entryIdentity.entryPath &&
				(current.documentId !== entryIdentity.documentId ||
					current.version !== entryIdentity.documentVersion ||
					host.revision !== entryIdentity.savedRevision))) {
			host.errorState = ['文件已變更，無法定位。請重新編譯後再試。', 'The document changed. Recompile before locating.'];
			return;
		}
		host.diagnosticNavigation = {
			location: { line: loc.line, utf16Column: loc.column },
			documentId: current.documentId,
			documentVersion: current.version,
			sequence: host.nextDiagnosticNavigationSequence()
		};
		host.workbenchPane = 'document';
		host.route = 'workbench';
		window.location.hash = '#/workbench';
		return;
	}
	await openIncludedSynctex(host, loc, targetPath, owner);
}

async function openIncludedSynctex(
	host: WorkbenchRuntimeHost,
	loc: SynctexSourceLocation,
	targetPath: string,
	owner: WorkspaceInfo
): Promise<void> {
	const port = host.desktop;
	const index = host.synctexIndex;
	if (!port || host.opening || host.saving || host.confirming || !index) return;
	if (!host.pdfIdentity || !sameCompileIdentity(index.identity, host.pdfIdentity)) return;
	if (host.workspace !== owner || owner.id !== index.identity.workspaceId) return;
	if (host.source && host.sourceName === index.identity.entryPath &&
		(host.source.documentId !== index.identity.documentId ||
			host.source.version !== index.identity.documentVersion ||
			host.revision !== index.identity.savedRevision)) {
		host.errorState = ['文件已變更，無法定位。請重新編譯後再試。', 'The document changed. Recompile before locating.'];
		return;
	}
	const sourceBefore = host.source;
	const sourceNameBefore = host.sourceName;
	const versionBefore = host.source?.version ?? null;
	const revisionBefore = host.revision;
	const dirtyBefore = host.dirty;
	const ticketBeforeConfirm = host.sourceTicket;
	if (!await host.allowReplacement()) {
		host.errorState = ['已取消切換至對應文件，草稿已保留。', 'Switching to the source document was cancelled. Your draft was preserved.'];
		return;
	}
	if (ticketBeforeConfirm !== host.sourceTicket ||
		host.lifetime.signal.aborted || host.opening || host.saving || host.workspace !== owner ||
		host.source !== sourceBefore || host.sourceName !== sourceNameBefore ||
		(host.source?.version ?? null) !== versionBefore ||
		host.revision !== revisionBefore || host.dirty !== dirtyBefore) return;
	if (!host.synctexIndex || host.synctexIndex !== index || !host.pdfIdentity || !sameCompileIdentity(index.identity, host.pdfIdentity)) return;
	const ticket = host.nextSourceTicket();
	host.opening = true;
	host.errorState = null;
	try {
		const receipt = await port.readFile({ workspaceId: owner.id, path: targetPath });
		if (host.lifetime.signal.aborted || ticket !== host.sourceTicket || host.workspace !== owner) return;
		if (!host.synctexIndex || host.synctexIndex !== index || !host.pdfIdentity || !sameCompileIdentity(index.identity, host.pdfIdentity)) return;
		if (host.source !== sourceBefore || host.sourceName !== sourceNameBefore ||
			(host.source?.version ?? null) !== versionBefore ||
			host.revision !== revisionBefore || host.dirty !== dirtyBefore) return;
		const { readSourceBytes } = await import('../files/read.ts');
		const reloaded = readSourceBytes(receipt.bytes);
		if (host.lifetime.signal.aborted || ticket !== host.sourceTicket || host.workspace !== owner) return;
		host.acceptDiskSource(reloaded, targetPath, receipt.revision);
		host.diagnosticNavigation = {
			location: { line: loc.line, utf16Column: loc.column },
			documentId: reloaded.documentId,
			documentVersion: reloaded.version,
			sequence: host.nextDiagnosticNavigationSequence()
		};
		host.workbenchPane = 'document';
		host.route = 'workbench';
		window.location.hash = '#/workbench';
	} catch (value) {
		if (ticket === host.sourceTicket && host.workspace === owner) {
			host.errorState = fileErrorDescriptor(value);
		}
	} finally {
		if (!host.lifetime.signal.aborted && ticket === host.sourceTicket) {
			host.opening = false;
			void host.drainWorkspaceWatch();
		}
	}
}

function compileSnapshotIsCurrent(
	host: WorkbenchRuntimeHost,
	snapshot: SourceDocument,
	owner: WorkspaceInfo,
	path: string,
	savedRevision: string
): boolean {
	const current = host.source;
	return host.workspace === owner && current !== null && current === snapshot &&
		current.documentId === snapshot.documentId && current.version === snapshot.version &&
		host.sourceName === path && host.revision === savedRevision;
}

export function noteCompileCancellationFailure(host: WorkbenchRuntimeHost, ticket: number): void {
	if (ticket !== host.compileTicket || host.compileCancellationRequestedFor !== ticket) return;
	host.compileCancellationFailedFor = ticket;
	host.errorState = ['無法取消編譯。請等待目前執行完成。', 'Unable to cancel compilation. Wait for the current run to finish.'];
}

export async function runCompileSource(host: WorkbenchRuntimeHost): Promise<void> {
	const port = host.desktop;
	if (!port || !host.source || host.compiling || host.saving || host.opening || host.sourceMissingOnDisk()) return;
	host.draftPanelOpen = false;
	const owner = host.workspace;
	if (!owner) {
		host.errorState = ['請先開啟已儲存的工作區文件。', 'Open a saved workspace document first.'];
		return;
	}
	let config;
	try {
		config = await port.getCompileConfig(owner.id);
	} catch (value) {
		if (!host.lifetime.signal.aborted) host.errorState = fileErrorDescriptor(value);
		return;
	}
	if (host.lifetime.signal.aborted || host.desktop !== port || host.workspace !== owner) return;
	const path = config.mainFile ?? (
		host.sourceName?.toLowerCase().endsWith('.tex') ? host.sourceName : null
	);
	if (!path) {
		host.errorState = ['請開啟 TeX 文件或在編譯設定中選擇主文件。', 'Open a TeX file or choose a main file in Compile settings.'];
		return;
	}
	if (!host.revision || host.dirty) await host.saveSource();
	if (host.desktop !== port || host.lifetime.signal.aborted || !host.workspace || host.saving || host.opening || host.compiling) return;
	if (host.workspace !== owner) return;
	if (!host.source || !host.sourceName || !host.revision || host.dirty || host.sourceMissingOnDisk() ||
		host.saving || host.opening || host.compiling) return;
	if (config.profile === 'custom' && !config.canSetCommand) {
		host.errorState = ['自訂編譯命令權限已停用。', 'Custom compile command permission is disabled.'];
		return;
	}
	const snapshot = host.source;
	const editorPath = host.sourceName;
	const editorRevision = host.revision;
	let compileRevision: string;
	try {
		compileRevision = (await port.readFile({ workspaceId: owner.id, path })).revision;
	} catch (value) {
		if (!host.lifetime.signal.aborted && host.workspace === owner && host.desktop === port) {
			host.errorState = fileErrorDescriptor(value);
		}
		return;
	}
	if (host.lifetime.signal.aborted || host.desktop !== port || host.workspace !== owner) return;
	const editorSnapshotIsCurrent = () =>
		!host.lifetime.signal.aborted &&
		host.desktop === port &&
		host.workspace === owner &&
		host.source === snapshot &&
		host.sourceName === editorPath &&
		host.revision === editorRevision &&
		!host.dirty &&
		!host.saving &&
		!host.opening &&
		!host.sourceMissingOnDisk() &&
		compileSnapshotIsCurrent(host, snapshot, owner, editorPath, editorRevision);
	if (
		(path === editorPath && compileRevision !== editorRevision) ||
		!editorSnapshotIsCurrent()
	) {
		host.compileNoticeState = ['文件已變更，請重新編譯。', 'The document changed. Please compile again.'];
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
	const own = ++host.compileTicket;
	const previewTicket = host.pdfTicket;
	host.compileCancellationRequestedFor = null;
	host.compileCancellationFailedFor = null;
	host.compiling = true;
	host.errorState = null;
	host.compileNoticeState = null;
	host.compileLog = '';
	host.showCompileDetails = false;
	host.diagnostics = [];
	host.diagnosticIdentity = null;
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
		if (own !== host.compileTicket || host.workspace !== owner || host.desktop !== port) {
			await handle.cancel();
			return;
		}
		host.compileHandle = handle;
		if (host.compileCancellationRequestedFor === own) {
			try { await handle.cancel(); }
			catch { noteCompileCancellationFailure(host, own); }
		}
		if (own !== host.compileTicket || host.workspace !== owner || host.desktop !== port) return;
		const result = await handle.finished;
		if (own !== host.compileTicket || host.workspace !== owner || host.desktop !== port) return;
		if (host.compileCancellationRequestedFor === own) {
			if (host.compileCancellationFailedFor !== own) {
				host.compileNoticeState = result.status === 'cancelled'
					? ['編譯已取消', 'Compilation cancelled']
					: ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
			}
			return;
		}
		const inputsCurrent = await compileInputsAreCurrent();
		if (own !== host.compileTicket || host.workspace !== owner || host.desktop !== port || host.lifetime.signal.aborted) return;
		if (host.compileCancellationRequestedFor === own) {
			if (host.compileCancellationFailedFor !== own) {
				host.compileNoticeState = result.status === 'cancelled'
					? ['編譯已取消', 'Compilation cancelled']
					: ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
			}
			return;
		}
		if (!inputsCurrent) {
			host.compileNoticeState = ['文件已變更，本次編譯結果未載入。請重新編譯。', 'The document changed, so this compile result was not loaded. Please compile again.'];
			return;
		}
		host.compileLog = result.log;
		host.diagnostics = result.diagnostics;
		host.diagnosticIdentity = result.identity;
		if (result.status === 'cancelled') {
			host.compileNoticeState = ['編譯已取消', 'Compilation cancelled'];
			return;
		}
		if (result.status === 'failure') {
			host.showCompileDetails = true;
			if (!host.compileLog && !host.diagnostics.length) {
				host.compileLog = host.t('編譯器回報失敗，但未提供記錄。請重試；若仍失敗，請檢查編譯引擎。', 'The compiler reported failure without a log. Retry; if it fails again, check the compile engine.');
			}
			const diag = result.diagnostics[0]?.message;
			host.errorState = diag ? { raw: diag } : compileErrorDescriptor(new Error('COMPILE_FAILED'));
			host.compileNoticeState = ['編譯失敗。請檢查編譯問題或 TeX 記錄，修正後重新編譯。', 'Compilation failed. Review the problems or TeX log, then compile again.'];
			host.workbenchPane = 'document';
			return;
		}
		if (result.status !== 'success') return;
		if (host.pdfTicket !== previewTicket) {
			host.compileNoticeState = ['文件或預覽已變更，請重新編譯。', 'Document or preview has changed. Please compile again.'];
			return;
		}
		host.pdfReveal = undefined;
		host.pdfBytes = result.pdf;
		host.pdfName = path.replace(/\.tex$/i, '.pdf');
		host.pageCount = 0;
		host.pdfIdentity = result.identity;
		host.compileNoticeState = ['編譯完成', 'Compilation completed'];
		host.workbenchPane = 'pdf';

		let newSynctex: BoundSynctexIndex | null = null;
		if (host.desktop?.takeCompileSynctex) {
			try {
				const { BoundSynctexIndex } = await import('./synctex.ts');
				const bytes = await host.desktop.takeCompileSynctex(result.identity);
				if (bytes) {
					if (own === host.compileTicket && host.workspace === owner && host.desktop === port && !host.lifetime.signal.aborted) {
						newSynctex = new BoundSynctexIndex(result.identity, bytes);
					} else {
						bytes.fill(0);
					}
				}
			} catch {
				newSynctex = null;
				if (own === host.compileTicket && host.workspace === owner && host.desktop === port && !host.lifetime.signal.aborted) {
					host.compileNoticeState = ['PDF 已顯示，但無法建立 SyncTeX 對應。', 'The PDF is shown, but SyncTeX mappings could not be loaded.'];
				}
			}
		}
		if (own !== host.compileTicket || host.workspace !== owner || host.desktop !== port || host.lifetime.signal.aborted) {
			newSynctex?.dispose();
			return;
		}
		host.synctexIndex?.dispose();
		host.synctexIndex = newSynctex;
	} catch (value) {
		if (own === host.compileTicket && host.workspace === owner && host.desktop === port) {
			if (handleReturned && host.compileCancellationRequestedFor === own) {
				if (host.compileCancellationFailedFor !== own) {
					host.compileNoticeState = ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
				}
			} else {
				const inputsCurrent = await compileInputsAreCurrent();
				if (own !== host.compileTicket || host.workspace !== owner || host.desktop !== port || host.lifetime.signal.aborted) return;
				if (handleReturned && host.compileCancellationRequestedFor === own) {
					if (host.compileCancellationFailedFor !== own) {
						host.compileNoticeState = ['本次編譯結果未載入。請重新編譯。', 'The compilation result was not loaded. Please compile again.'];
					}
				} else if (!inputsCurrent) {
					host.compileNoticeState = ['文件已變更，本次編譯結果未載入。請重新編譯。', 'The document changed, so this compile result was not loaded. Please compile again.'];
				} else {
					const desc = compileErrorDescriptor(value);
					host.errorState = desc;
					const reason = value instanceof Error ? value.message : typeof value === 'string' ? value : host.t('未取得失敗詳細資料。', 'No failure details were returned.');
					host.compileLog = [handleReturned ? host.t('編譯執行失敗', 'Compilation execution failed') : host.t('編譯啟動前檢查失敗', 'Compilation preflight failed'), path, host.t(...desc), reason].join('\n').slice(0, 256 * 1024);
					host.showCompileDetails = true;
					host.compileNoticeState = ['編譯失敗，請查看錯誤訊息。', 'Compilation failed. Review the error message.'];
				}
			}
		}
	} finally {
		if (own === host.compileTicket) {
			host.compiling = false;
			host.compileHandle = null;
			if (host.compileCancellationRequestedFor === own) host.compileCancellationRequestedFor = null;
			if (host.compileCancellationFailedFor === own) host.compileCancellationFailedFor = null;
		}
	}
}

async function goToDiagnostic(host: WorkbenchRuntimeHost, diagnostic: Diagnostic): Promise<void> {
	if (!host.source || !host.diagnosticIdentity || host.saving || host.opening) return;
	const owner = host.source;
	const identity = host.diagnosticIdentity;
	const path = host.sourceName;
	const sequence = host.nextNavigationSequence();
	const helper = await import('./diagnostic-span.ts').catch(() => null);
	if (host.source !== owner || host.diagnosticIdentity !== identity || host.sourceName !== path ||
		host.saving || host.opening || sequence !== host.navigationSequence) return;
	const span = helper?.diagnosticSpan(owner, path, identity, diagnostic);
	if (span) {
		host.route = 'workbench';
		host.workbenchPane = 'document';
		window.location.hash = '#/workbench';
		host.navigation = { span, sequence: host.nextNavigationSequence(), sourceOnly: true };
	} else {
		host.errorState = ['錯誤位置已無法對應此文件，請查看編譯記錄。', 'Error location can no longer be mapped to this document. See compilation log.'];
	}
}

export function runNavigateToDiagnostic(host: WorkbenchRuntimeHost, diagnostic: Diagnostic): void {
	if (host.opening || host.saving) return;
	if (!hasDiagnosticLocation(diagnostic)) {
		host.errorState = ['錯誤位置已無法對應此文件，請查看編譯記錄。', 'Error location can no longer be mapped to this document. See compilation log.'];
		return;
	}
	const context = captureDiagnosticContext(host);
	const targetPath = safeWorkspaceDiagnosticPath(diagnostic.path);
	const currentPath = context ? safeWorkspaceDiagnosticPath(context.sourceName) : null;
	if (!context || !targetPath || !currentPath) {
		host.errorState = ['錯誤位置已無法對應此文件，請查看編譯記錄。', 'Error location can no longer be mapped to this document. See compilation log.'];
		return;
	}
	if (targetPath === currentPath) {
		void goToDiagnostic(host, diagnostic);
		return;
	}
	void openIncludedDiagnostic(host, diagnostic, context, targetPath);
}

async function openIncludedDiagnostic(
	host: WorkbenchRuntimeHost,
	diagnostic: LineDiagnostic,
	context: DiagnosticContext,
	path: string
): Promise<void> {
	const port = host.desktop;
	if (!port || host.opening || host.saving || host.confirming || !diagnosticContextIsCurrent(host, context)) return;
	if (!await host.allowReplacement()) {
		host.errorState = ['已取消切換至診斷文件，草稿已保留。', 'Switching to the diagnostic file was cancelled. Your draft was preserved.'];
		return;
	}
	if (!diagnosticContextIsCurrent(host, context)) return;
	const ticket = host.nextSourceTicket();
	host.opening = true;
	host.errorState = null;
	try {
		const receipt = await port.readFile({ workspaceId: context.owner.id, path });
		if (!diagnosticContextIsCurrent(host, context, ticket)) return;
		const { readSourceBytes } = await import('../files/read.ts');
		const reloaded = readSourceBytes(receipt.bytes);
		if (!diagnosticContextIsCurrent(host, context, ticket)) return;
		host.acceptDiskSource(reloaded, path, receipt.revision);
		host.diagnosticNavigation = {
			location: { line: diagnostic.line, utf16Column: null },
			documentId: reloaded.documentId,
			documentVersion: reloaded.version,
			sequence: host.nextDiagnosticNavigationSequence()
		};
		host.workbenchPane = 'document';
		host.route = 'workbench';
		window.location.hash = '#/workbench';
	} catch (value) {
		if (ticket === host.sourceTicket && diagnosticContextIsCurrent(host, context, ticket)) {
			host.errorState = fileErrorDescriptor(value);
		}
	} finally {
		if (!host.lifetime.signal.aborted && ticket === host.sourceTicket) {
			host.opening = false;
			void host.drainWorkspaceWatch();
		}
	}
}

export async function runDrainPendingOpenRequests(host: WorkbenchRuntimeHost): Promise<void> {
	const port = host.desktop;
	if (!port || !isTauri()) return;
	while (host.pendingOpenArmed && !host.lifetime.signal.aborted && host.desktop === port) {
		if (host.opening || host.saving || host.compiling || host.confirming) return;

		const previousSource = host.source;
		const previousSourceVersion = host.source?.version ?? null;
		const previousWorkspace = host.workspace;
		const previousSourceName = host.sourceName;
		const previousRevision = host.revision;
		const previousDirty = host.dirty;
		const previousPdfBytes = host.pdfBytes;
		const previousPdfName = host.pdfName;
		const previousPdfTicket = host.pdfTicket;
		const allowed = await host.allowReplacement();
		if (!allowed || host.lifetime.signal.aborted) {
			host.pendingOpenArmed = false;
			return;
		}
		if (host.opening || host.saving || host.compiling || host.confirming) return;
		if (host.source !== previousSource ||
			(host.source?.version ?? null) !== previousSourceVersion ||
			host.workspace !== previousWorkspace ||
			host.sourceName !== previousSourceName ||
			host.revision !== previousRevision ||
			host.dirty !== previousDirty ||
			host.pdfBytes !== previousPdfBytes ||
			host.pdfName !== previousPdfName ||
			host.pdfTicket !== previousPdfTicket) {
			host.pendingOpenArmed = false;
			return;
		}

		host.opening = true;
		try {
			const receipt = await invoke<PendingOpenReceipt | null>('frontend_take_pending_open');
			if (host.lifetime.signal.aborted) {
				if (receipt) void port.closeWorkspace(receipt.workspace.id).catch(() => {});
				host.pendingOpenArmed = false;
				return;
			}
			if (!receipt) {
				host.pendingOpenArmed = false;
				return;
			}
			if (host.desktop !== port ||
				host.source !== previousSource ||
				(host.source?.version ?? null) !== previousSourceVersion ||
				host.workspace !== previousWorkspace ||
				host.sourceName !== previousSourceName ||
				host.revision !== previousRevision ||
				host.dirty !== previousDirty ||
				host.pdfBytes !== previousPdfBytes ||
				host.pdfName !== previousPdfName ||
				host.pdfTicket !== previousPdfTicket) {
				void port.closeWorkspace(receipt.workspace.id).catch(() => {});
				host.pendingOpenArmed = false;
				return;
			}

			const oldWorkspace = host.workspace;
			host.stopWorkspaceWatch();
			host.workspaceWatchIssue = null;
			host.externalFileNotice = null;
			host.abandonCompile();
			host.draftPanelOpen = false;
			host.resetDraftSelection();
			host.selectWorkspace(receipt.workspace);
			host.nextSourceTicket();
			host.nextPdfTicket();
			host.source = null;
			host.sourceName = '';
			host.revision = null;
			host.savedVersion = null;
			host.hasDiskCheckpoint = true;
			host.dirty = false;
			host.pdfBytes = null;
			host.pdfIdentity = null;
			host.pdfName = '';
			host.pageCount = 0;
			host.entries = [];

			await runReadDesktopFile(host, receipt.path, receipt.workspace, false);
			const isPdf = receipt.path.toLowerCase().endsWith('.pdf');
			const loaded = isPdf
				? host.pdfBytes !== null && host.pdfName === receipt.path
				: host.source !== null && host.sourceName === receipt.path;
			if (!loaded) {
				host.pendingOpenArmed = false;
				return;
			}
			await runRefreshWorkspaceEntries(host, receipt.workspace, host.workspaceGeneration);
			if (oldWorkspace && oldWorkspace.id !== receipt.workspace.id) {
				await port.closeWorkspace(oldWorkspace.id).catch(() => {});
			}
			await host.refreshRecent();
		} catch (value) {
			if (!host.lifetime.signal.aborted) host.errorState = fileErrorDescriptor(value);
			host.pendingOpenArmed = false;
		} finally {
			if (!host.lifetime.signal.aborted) {
				host.opening = false;
				void host.drainWorkspaceWatch();
			}
		}
	}
}

export async function runReloadExternalSource(host: WorkbenchRuntimeHost): Promise<void> {
	const notice = host.externalFileNotice;
	const watch = host.activeWorkspaceWatch;
	const port = host.desktop;
	const snapshot = host.source;
	if (!notice || notice.kind !== 'changed' || !watch || !port || !snapshot ||
		!host.workspaceWatchIsCurrent(watch) || notice.documentId !== snapshot.documentId ||
		notice.path !== host.sourceName || host.opening || host.saving || host.confirming) return;
	const snapshotVersion = snapshot.version;
	const dirtyAtStart = host.dirty;
	const revisionAtStart = host.revision;
	if (!await host.allowReplacement()) return;
	if (!host.workspaceWatchIsCurrent(watch) || host.source !== snapshot ||
		host.source?.documentId !== notice.documentId || host.source.version !== snapshotVersion ||
		host.sourceName !== notice.path || host.dirty !== dirtyAtStart || host.revision !== revisionAtStart) return;
	const ticket = host.nextSourceTicket();
	host.opening = true;
	host.errorState = null;
	try {
		const receipt = await port.readFile({ workspaceId: watch.owner.id, path: notice.path });
		if (host.lifetime.signal.aborted || ticket !== host.sourceTicket || !host.workspaceWatchIsCurrent(watch)) return;
		if (host.source !== snapshot || host.source?.documentId !== notice.documentId ||
			host.source.version !== snapshotVersion || host.sourceName !== notice.path ||
			host.dirty !== dirtyAtStart || host.revision !== revisionAtStart) {
			host.setExternalFileNotice(watch, notice.documentId, notice.path, 'changed');
			return;
		}
		const { readSourceBytes } = await import('../files/read.ts');
		const reloaded = readSourceBytes(receipt.bytes);
		if (host.lifetime.signal.aborted || ticket !== host.sourceTicket || !host.workspaceWatchIsCurrent(watch) ||
			host.source !== snapshot || host.source?.documentId !== notice.documentId ||
			host.source.version !== snapshotVersion || host.sourceName !== notice.path ||
			host.dirty !== dirtyAtStart || host.revision !== revisionAtStart) {
			host.setExternalFileNotice(watch, notice.documentId, notice.path, 'changed');
			return;
		}
		host.invalidateSynctexForSourceChange(notice.path, receipt.revision);
		host.acceptDiskSource(reloaded, notice.path, receipt.revision);
	} catch (value) {
		if (host.lifetime.signal.aborted || ticket !== host.sourceTicket || !host.workspaceWatchIsCurrent(watch)) return;
		let listed: readonly FileEntry[];
		try {
			listed = await port.listFiles(watch.owner.id);
		} catch {
			host.suspendWorkspaceWatch(watch);
			return;
		}
		if (host.lifetime.signal.aborted || ticket !== host.sourceTicket || !host.workspaceWatchIsCurrent(watch) ||
			host.source?.documentId !== notice.documentId || host.sourceName !== notice.path) return;
		host.entries = listed;
		const exists = listed.some((entry) => entry.kind === 'file' && entry.path === notice.path);
		host.setExternalFileNotice(watch, notice.documentId, notice.path, exists ? 'changed' : 'missing');
		host.errorState = fileErrorDescriptor(value);
	} finally {
		if (!host.lifetime.signal.aborted && ticket === host.sourceTicket) {
			host.opening = false;
			void host.drainWorkspaceWatch(watch);
		}
	}
}

export async function runSaveSourceAs(host: WorkbenchRuntimeHost): Promise<void> {
	if (!host.desktop || !host.source || host.saving || host.opening || host.compiling) return;
	const port = host.desktop;
	const snapshot = host.source;
	const owner = host.workspace;
	host.saving = true;
	host.errorState = null;
	try {
		const images = snapshot.read().includes('modutex-image-')
			? await (await import('../images/store.ts')).saveAsImages({
				desktop: port,
				workspaceId: owner?.id ?? null,
				path: host.sourceName,
				documentId: snapshot.documentId,
				documentVersion: snapshot.version
			}, snapshot)
			: [];
		const result = await port.saveAs({
			workspaceId: owner?.id ?? null,
			bytes: snapshot.toBytes(),
			documentId: snapshot.documentId,
			documentVersion: snapshot.version,
			...(images.length ? { images } : {})
		});
		if (!result) return;
		if (host.lifetime.signal.aborted || host.workspace !== owner || host.source !== snapshot) {
			if (host.activeWorkspaceWatch?.owner === owner) host.stopWorkspaceWatch(host.activeWorkspaceWatch);
			await port.closeWorkspace(result.workspace.id);
			return;
		}
		if (host.activeWorkspaceWatch?.owner === owner) host.stopWorkspaceWatch(host.activeWorkspaceWatch);
		host.abandonCompile();
		host.nextSourceTicket();
		host.nextPdfTicket();
		host.selectWorkspace(result.workspace);
		host.sourceName = result.write.path;
		host.revision = result.write.revision;
		host.externalFileNotice = null;
		host.workspaceWatchIssue = null;
		void host.refreshRecent();
		host.savedVersion = snapshot.version;
		host.hasDiskCheckpoint = true;
		host.dirty = false;
		host.entries = [{ path: host.sourceName, kind: 'file' }];
		if (host.pdfIdentity) {
			host.pdfBytes = null;
			host.pdfIdentity = null;
			host.pdfName = '';
			host.pageCount = 0;
			host.synctexIndex?.dispose();
			host.synctexIndex = null;
			host.pdfReveal = undefined;
		}
		const selected = result.workspace;
		await runRefreshWorkspaceEntries(host, selected, host.workspaceGeneration);
	} catch (value) {
		if (!host.lifetime.signal.aborted && host.workspace === owner) host.errorState = fileErrorDescriptor(value);
	} finally {
		if (!host.lifetime.signal.aborted) {
			host.saving = false;
			void host.drainWorkspaceWatch();
		}
	}
}

export async function runNewDocument(host: WorkbenchRuntimeHost, template: TemplateId): Promise<void> {
	if (host.opening || host.saving || host.compiling || host.confirming) return;
	const previous = host.source;
	const owner = host.workspace;
	const previousVersion = previous?.version;
	const previousRevision = host.revision;
	if (!await host.allowReplacement()) return;
	if (host.lifetime.signal.aborted || host.opening || host.saving || host.compiling ||
		host.source !== previous || host.workspace !== owner ||
		host.source?.version !== previousVersion || host.revision !== previousRevision) return;
	host.opening = true;
	host.errorState = null;
	try {
		const { createDraft } = await import('../files/templates.ts');
		const draft = createDraft(template);
		if (host.lifetime.signal.aborted || host.source !== previous || host.workspace !== owner ||
			host.source?.version !== previousVersion || host.revision !== previousRevision) return;
		if (host.desktop && owner) {
			if (host.activeWorkspaceWatch?.owner === owner) host.stopWorkspaceWatch(host.activeWorkspaceWatch);
			await host.desktop.closeWorkspace(owner.id);
		}
		if (host.lifetime.signal.aborted || host.source !== previous || host.workspace !== owner ||
			host.source?.version !== previousVersion || host.revision !== previousRevision) return;
		host.abandonCompile();
		host.nextSourceTicket();
		host.nextPdfTicket();
		host.draftPanelOpen = false;
		host.resetDraftSelection();
		host.selectWorkspace(null);
		host.entries = [];
		host.acceptDiskSource(draft, 'untitled.tex', '');
		host.revision = null;
		host.savedVersion = null;
		host.hasDiskCheckpoint = false;
		host.dirty = true;
		host.pdfBytes = null;
		host.pdfIdentity = null;
		host.pdfName = '';
		host.pageCount = 0;
		window.location.hash = '#/workbench';
	} catch {
		if (!host.lifetime.signal.aborted) {
			host.errorState = ['無法建立文件，原編輯內容已保留。請稍後再試。', 'Unable to create document. Previous edits are preserved. Try again shortly.'];
			if (owner && host.workspace === owner && !host.activeWorkspaceWatch) host.startWorkspaceWatch(owner);
		}
	} finally {
		if (!host.lifetime.signal.aborted) {
			host.opening = false;
			void host.drainWorkspaceWatch();
		}
	}
}

export async function runSaveSourceForDraft(host: WorkbenchRuntimeHost): Promise<boolean> {
	const port = host.desktop;
	const snapshot = host.source;
	const owner = host.workspace;
	const path = host.sourceName;
	if (!port || !snapshot || !owner || !host.revision ||
		!path.toLowerCase().endsWith('.tex') ||
		host.opening || host.saving || host.confirming || host.compiling || host.sourceMissingOnDisk()) return false;
	const version = snapshot.version;
	await host.saveSource();
	if (host.lifetime.signal.aborted) return false;
	await tick();
	return host.desktop === port && host.workspace === owner && host.source === snapshot &&
		host.source.documentId === snapshot.documentId && host.source.version === version &&
		host.sourceName === path && host.revision !== null && host.savedVersion === version &&
		!host.dirty && !host.sourceMissingOnDisk();
}
