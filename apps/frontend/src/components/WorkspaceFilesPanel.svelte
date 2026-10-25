<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onDestroy, untrack } from 'svelte';
	import type { FileEntry } from '@modutex/frontend-contracts';
	import { text, type Language } from '../i18n/text.ts';
	import {
		isWorkspaceFilesCapabilityUnavailable,
		type WorkspaceFileDeleteReceipt,
		type WorkspaceFileSearchResult,
		type WorkspaceFileStat,
		type WorkspaceFilesPort,
		type WorkspaceFilesTask
	} from '../features/files/workspace-files.ts';
	import {
		confirmedWorkspaceFileRequest,
		type WorkspaceFileDestructiveConfirmation
	} from '../features/files/workspace-files-confirmation.ts';
	import FileTree from './FileTree.svelte';

	interface UndoItem extends WorkspaceFileDeleteReceipt {
		readonly path: string;
	}

	type Tool = 'search' | 'scan' | 'create-file' | 'create-directory' | 'move' | 'rename' | 'copy' | null;

	const MAX_CREATE_FILE_BYTES = 5 * 1024 * 1024;
	const tFor = (locale: Language, zh: string, en: string) => text(locale, zh, en);

	let {
		open,
		workspaceId,
		workspaceLabel,
		scope,
		files,
		entries,
		selected,
		disabled,
		sourcePath,
		sourceDirty,
		locale = 'zh-Hant',
		initialTool = null,
		initialPath = '',
		openSequence = 0,
		onOpen,
		onCompile,
		onCreatedFile = async () => false,
		onClose,
		onRefresh,
		onEntries,
		onCapabilityLost,
		onPathChanged,
		onSourceRemoved
	}: {
		open: boolean;
		workspaceId: string;
		workspaceLabel: string;
		scope: number;
		files: WorkspaceFilesPort;
		entries: readonly FileEntry[];
		selected: string;
		disabled: boolean;
		sourcePath: string;
		sourceDirty: boolean;
		locale?: Language;
		initialTool?: 'create-file' | 'create-directory' | null;
		initialPath?: string;
		openSequence?: number;
		onOpen: (path: string) => void | Promise<void>;
		onCompile?: (path: string) => void | Promise<void>;
		onCreatedFile?: (path: string) => boolean | Promise<boolean>;
		onClose: () => void;
		onRefresh: () => Promise<readonly FileEntry[] | null>;
		onEntries: (entries: readonly FileEntry[]) => void;
		onCapabilityLost: () => void;
		onPathChanged: (previousPath: string, nextPath: string) => void | Promise<void>;
		onSourceRemoved: (path: string) => void | Promise<void>;
	} = $props();

	const t = (zh: string, en: string) => tFor(locale, zh, en);
	let dialogElement = $state<HTMLDialogElement>();
	let binaryInput = $state<HTMLInputElement>();
	let tool = $state<Tool>(null);
	let scanEntries = $state.raw<readonly FileEntry[] | null>(null);
	let searchDirectory = $state('');
	let searchQuery = $state('');
	let searchMaximum = $state(256);
	let searchResult = $state.raw<WorkspaceFileSearchResult | null>(null);
	let scanDirectory = $state('');
	let scanDepth = $state(64);
	let scanMaximum = $state(4096);
	let createFilePath = $state('');
	let createFileContents = $state('');
	let binaryFileBytes = $state.raw<Uint8Array | null>(null);
	let binaryFileLabel = $state('');
	let createDirectoryPath = $state('');
	let actionPath = $state('');
	let destinationPath = $state('');
	let confirmation = $state.raw<WorkspaceFileDestructiveConfirmation | null>(null);
	let fileStat = $state.raw<WorkspaceFileStat | null>(null);
	let undoItems = $state.raw<readonly UndoItem[]>([]);
	let status = $state('');
	let statusIsError = $state(false);
	let busyAction = $state('');
	let activeTask = $state.raw<WorkspaceFilesTask<unknown> | null>(null);
	let cancellationPending = $state(false);
	let observedEntries = untrack(() => entries);
	let observedWorkspaceId = untrack(() => workspaceId);
	let observedScope = untrack(() => scope);
	let wasOpen = false;
	let disposed = false;
	let sequence = 0;
	let binaryReadTicket = 0;
	let observedOpenSequence = -1;

	const operationLocked = $derived(disabled || busyAction.length > 0);
	const visibleEntries = $derived(scanEntries ?? entries);

	$effect(() => {
		const currentEntries = entries;
		if (currentEntries !== observedEntries) {
			observedEntries = currentEntries;
			untrack(() => {
				scanEntries = null;
				fileStat = null;
			});
		}
	});

	$effect(() => {
		const currentWorkspaceId = workspaceId;
		const currentScope = scope;
		if (currentWorkspaceId === observedWorkspaceId && currentScope === observedScope) return;
		observedWorkspaceId = currentWorkspaceId;
		observedScope = currentScope;
		untrack(() => {
			++sequence;
			++binaryReadTicket;
			const task = activeTask;
			activeTask = null;
			busyAction = '';
			cancellationPending = false;
			tool = null;
			scanEntries = null;
			searchResult = null;
			fileStat = null;
			confirmation = null;
			undoItems = [];
			binaryFileBytes = null;
			binaryFileLabel = '';
			setStatus('');
			if (task) void task.cancel().catch(() => {});
		});
	});

	$effect(() => {
		const shouldOpen = open;
		const dialog = dialogElement;
		if (dialog) {
			if (shouldOpen && !dialog.open) {
				try {
					dialog.showModal();
					void Promise.resolve().then(() => {
						if (open && dialog.open) {
							dialog.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
						}
					});
				} catch {
					setStatus(t('無法開啟檔案操作視窗。', 'Unable to open the workspace file dialog.'), true);
				}
			} else if (!shouldOpen && dialog.open) {
				dialog.close();
			}
		}
		if (wasOpen && !shouldOpen) {
			untrack(() => {
				confirmation = null;
				tool = null;
				if (activeTask) void cancelActiveTask();
			});
		}
		wasOpen = shouldOpen;
	});

	$effect(() => {
		const requestedSequence = openSequence;
		const requestedTool = initialTool;
		const requestedPath = initialPath;
		if (requestedSequence === observedOpenSequence || busyAction) return;
		observedOpenSequence = requestedSequence;
		untrack(() => {
			tool = requestedTool;
			createFilePath = requestedPath;
			createFileContents = '';
			binaryFileBytes = null;
			binaryFileLabel = '';
			if (binaryInput) binaryInput.value = '';
			confirmation = null;
			fileStat = null;
			setStatus('');
		});
	});

	function isCurrent(ticket: number): boolean {
		return !disposed && ticket === sequence;
	}

	function setStatus(message: string, error = false) {
		status = message;
		statusIsError = error;
	}

	function reportFailure(value: unknown) {
		if (isWorkspaceFilesCapabilityUnavailable(value)) {
			setStatus(
				t(
					'此版本未提供原生工作區檔案操作，已停用相關控制。',
					'This host does not provide native workspace file operations. The controls have been disabled.'
				),
				true
			);
			onCapabilityLost();
			return;
		}
		const message = value instanceof Error ? value.message : String(value);
		switch (message) {
			case 'STALE_WORKSPACE':
			case 'SESSION_CLOSED':
				setStatus(
					t('工作區已關閉。請重新開啟工作區後再試。', 'The workspace is closed. Reopen it and try again.'),
					true
				);
				return;
			case 'LINK_NOT_ALLOWED':
				setStatus(
					t('操作路徑包含不允許的連結。', 'The operation contains a path link that is not allowed.'),
					true
				);
				return;
			case 'TREE_TOO_DEEP':
				setStatus(
					t('資料夾層級超過掃描上限。請選擇較淺的資料夾或降低深度。', 'The folder exceeds the scan depth limit. Choose a shallower folder or lower the depth.'),
					true
				);
				return;
			case 'TREE_TOO_LARGE':
				setStatus(
					t('資料夾項目超過掃描上限。請選擇較小的資料夾或降低項目數。', 'The folder exceeds the scan entry limit. Choose a smaller folder or lower the entry limit.'),
					true
				);
				return;
			case 'FILE_CONFLICT':
			case 'FILE_CHANGED':
				setStatus(
					t('檔案已變更或目的地已存在。原有內容未遭覆寫。請重新整理後再試。', 'The file changed or the destination already exists. Existing content was not overwritten. Refresh and try again.'),
					true
				);
				return;
			case 'FILE_TOO_LARGE':
				setStatus(
					t('檔案超過此操作的大小上限。', 'The file exceeds this operation’s size limit.'),
					true
				);
				return;
			case 'ACCESS_DENIED':
				setStatus(
					t('工作區拒絕此檔案操作。', 'The workspace denied this file operation.'),
					true
				);
				return;
			case 'CANCELLED':
				setStatus(t('工作區操作已取消。', 'Workspace operation cancelled.'), true);
				return;
		}
		setStatus(
			t(`檔案操作失敗：${message}`, `Workspace file operation failed: ${message}`),
			true
		);
	}

	async function runSimple<T>(
		label: string,
		work: () => Promise<T>,
		success: (value: T, ticket: number) => void | Promise<void>
	) {
		if (operationLocked) return;
		const ticket = ++sequence;
		busyAction = label;
		activeTask = null;
		cancellationPending = false;
		setStatus('');
		try {
			const value = await work();
			if (!isCurrent(ticket)) return;
			await success(value, ticket);
		} catch (value) {
			if (isCurrent(ticket)) reportFailure(value);
		} finally {
			if (isCurrent(ticket)) {
				activeTask = null;
				busyAction = '';
				cancellationPending = false;
			}
		}
	}

	function launchTask<T>(
		label: string,
		create: () => WorkspaceFilesTask<T>,
		success: (value: T, ticket: number) => void | Promise<void>
	) {
		if (operationLocked) return;
		try {
			void runTask(label, create(), success);
		} catch (value) {
			reportFailure(value);
		}
	}

	async function runTask<T>(
		label: string,
		task: WorkspaceFilesTask<T>,
		success: (value: T, ticket: number) => void | Promise<void>
	) {
		const ticket = ++sequence;
		busyAction = label;
		activeTask = task as WorkspaceFilesTask<unknown>;
		cancellationPending = false;
		setStatus('');
		try {
			const value = await task.result;
			if (!isCurrent(ticket)) return;
			activeTask = null;
			await success(value, ticket);
		} catch (value) {
			if (isCurrent(ticket)) reportFailure(value);
		} finally {
			if (isCurrent(ticket)) {
				activeTask = null;
				busyAction = '';
				cancellationPending = false;
			}
		}
	}

	async function refreshEntries(ticket: number): Promise<boolean> {
		scanEntries = null;
		searchResult = null;
		const refreshed = await onRefresh();
		if (!isCurrent(ticket)) return false;
		if (!refreshed) {
			setStatus(
				t('操作已完成，但無法重新整理檔案清單。', 'The operation completed, but the file list could not be refreshed.'),
				true
			);
			return false;
		}
		return true;
	}

	async function cancelActiveTask() {
		const task = activeTask;
		if (!task || cancellationPending) return;
		const ticket = ++sequence;
		cancellationPending = true;
		busyAction = t('正在取消…', 'Cancelling…');
		setStatus(t('正在向原生工作區要求取消。', 'Requesting cancellation from the native workspace.'));
		void task.result.then(
			() => finishCancellation(ticket, task),
			() => finishCancellation(ticket, task)
		);
		try {
			await task.cancel();
		} catch (value) {
			if (disposed || ticket !== sequence) return;
			cancellationPending = false;
			reportFailure(value);
		}
	}

	function finishCancellation(ticket: number, task: WorkspaceFilesTask<unknown>) {
		if (disposed || ticket !== sequence || activeTask !== task) return;
		activeTask = null;
		busyAction = '';
		cancellationPending = false;
		setStatus(t('原生工作區操作已停止。', 'The native workspace operation has stopped.'));
	}

	function affectsOpenSource(path: string): boolean {
		return sourcePath === path || sourcePath.startsWith(`${path}/`);
	}

	function dirtySourceIsProtected(path: string): boolean {
		if (!sourceDirty || !affectsOpenSource(path)) return false;
		setStatus(
			t(
				'目前文件有未儲存變更。請先儲存或另存，再移動、改名或刪除該文件。',
				'The current document has unsaved changes. Save it or use Save as before moving, renaming, or deleting it.'
			),
			true
		);
		return true;
	}

	function selectTool(next: Tool) {
		tool = next;
		confirmation = null;
		fileStat = null;
		setStatus('');
	}

	function handleWorkspaceAction(action: import('../features/files/workspace-files.ts').WorkspaceFileAction, path: string) {
		if (operationLocked) return;
		switch (action) {
			case 'stat':
				void runSimple('stat', () => files.stat(workspaceId, path), (value) => {
					fileStat = value;
					setStatus(t('已讀取檔案資訊。', 'File details loaded.'));
				});
				break;
			case 'scan':
				scanDirectory = path;
				selectTool('scan');
				break;
			case 'search':
				searchDirectory = path;
				selectTool('search');
				break;
			case 'move':
			case 'rename':
			case 'copy':
				if (action !== 'copy' && dirtySourceIsProtected(path)) return;
				actionPath = path;
				destinationPath = '';
				selectTool(action);
				break;
			case 'recycle':
			case 'delete':
				if (dirtySourceIsProtected(path)) return;
				tool = null;
				fileStat = null;
				setStatus('');
				confirmation = { action, path };
				break;
			case 'reveal':
				void runSimple('reveal', () => files.reveal(workspaceId, path), () => {
					setStatus(t('已在檔案總管中顯示。', 'Revealed in Explorer.'));
				});
				break;
		}
	}

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		const directory = searchDirectory.trim() ? searchDirectory : null;
		launchTask(
			'search',
			() => files.startSearch(workspaceId, directory, searchQuery, searchMaximum),
			(result) => {
				searchResult = result;
				scanEntries = null;
				tool = null;
				setStatus(
					result.hits.length
						? t(`找到 ${result.hits.length} 個結果。`, `${result.hits.length} search results found.`)
						: t('沒有符合的結果。', 'No matching results.')
				);
			}
		);
	}

	function submitScan(event: SubmitEvent) {
		event.preventDefault();
		launchTask(
			'scan',
			() => files.startScan(workspaceId, scanDirectory, scanDepth, scanMaximum),
			(result) => {
				scanEntries = result;
				searchResult = null;
				tool = null;
				setStatus(t(`已掃描 ${result.length} 個項目。`, `Scanned ${result.length} entries.`));
			}
		);
	}

	async function chooseBinaryFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		const owner = workspaceId;
		const ownerScope = scope;
		const ticket = ++binaryReadTicket;
		binaryFileBytes = null;
		binaryFileLabel = '';
		if (file.size > MAX_CREATE_FILE_BYTES) {
			setStatus(
				t('新檔案內容上限為 5 MiB。', 'New file contents are limited to 5 MiB.'),
				true
			);
			return;
		}
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (
				disposed ||
				owner !== workspaceId ||
				ownerScope !== scope ||
				ticket !== binaryReadTicket
			) {
				return;
			}
			if (bytes.byteLength > MAX_CREATE_FILE_BYTES) {
				setStatus(
					t('新檔案內容上限為 5 MiB。', 'New file contents are limited to 5 MiB.'),
					true
				);
				return;
			}
			binaryFileBytes = bytes;
			binaryFileLabel = file.name;
			if (!createFilePath) createFilePath = file.name;
			setStatus(
				t(`已載入二進位內容「${file.name}」。`, `Loaded binary contents from "${file.name}".`)
			);
		} catch {
			if (owner === workspaceId && ownerScope === scope && ticket === binaryReadTicket) {
				setStatus(t('無法讀取所選檔案。', 'Unable to read the selected file.'), true);
			}
		}
	}

	function clearBinaryFile() {
		++binaryReadTicket;
		binaryFileBytes = null;
		binaryFileLabel = '';
		if (binaryInput) binaryInput.value = '';
		setStatus(t('已改用 UTF-8 文字內容。', 'Using UTF-8 text contents.'));
	}

	function submitCreateFile(event: SubmitEvent) {
		event.preventDefault();
		if (operationLocked) return;
		if (!binaryFileBytes && createFileContents.length > MAX_CREATE_FILE_BYTES) {
			setStatus(t('新檔案內容上限為 5 MiB。', 'New file contents are limited to 5 MiB.'), true);
			return;
		}
		const bytes = binaryFileBytes ?? new TextEncoder().encode(createFileContents);
		if (bytes.byteLength > MAX_CREATE_FILE_BYTES) {
			setStatus(t('新檔案內容上限為 5 MiB。', 'New file contents are limited to 5 MiB.'), true);
			return;
		}
		const payload = new Uint8Array(bytes);
		void runSimple(
			'create-file',
			() => files.createFile(workspaceId, createFilePath, payload),
			async (result, ticket) => {
				const createdPath = result.path;
				createFilePath = '';
				createFileContents = '';
				binaryFileBytes = null;
				binaryFileLabel = '';
				if (binaryInput) binaryInput.value = '';
				tool = null;
				setStatus(t(`已建立「${createdPath}」，正在開啟…`, `Created "${createdPath}". Opening…`));
				const refreshed = await refreshEntries(ticket);
				if (!isCurrent(ticket)) return;
				let opened = false;
				try {
					opened = await onCreatedFile(createdPath);
				} catch {
					opened = false;
				}
				if (!isCurrent(ticket)) return;
				if (opened) {
					setStatus(t(`已建立並開啟「${createdPath}」。`, `Created and opened "${createdPath}".`));
				} else {
							setStatus(
								t(`已建立「${createdPath}」，但未開啟，目前文件仍保留。`, `Created "${createdPath}", but did not open it. The current document is preserved.`),
						true
					);
				}
				if (!refreshed && !opened) {
					setStatus(
								t(`已建立「${createdPath}」，但未開啟，檔案清單更新失敗，目前文件仍保留。`, `Created "${createdPath}", but did not open it. The file list could not be refreshed. The current document is preserved.`),
						true
					);
				}
			}
		);
	}

	function submitCreateDirectory(event: SubmitEvent) {
		event.preventDefault();
		void runSimple(
			'create-directory',
			() => files.createDirectory(workspaceId, createDirectoryPath),
			async (result, ticket) => {
				createDirectoryPath = '';
				tool = null;
				setStatus(t(`已建立資料夾「${result.path}」。`, `Created folder "${result.path}".`));
				await refreshEntries(ticket);
			}
		);
	}

	function rebasedSourcePath(source: string, destination: string): string | null {
		if (sourcePath === source) return destination;
		if (sourcePath.startsWith(`${source}/`)) {
			return `${destination}${sourcePath.slice(source.length)}`;
		}
		return null;
	}

	function submitPathOperation(event: SubmitEvent) {
		event.preventDefault();
		const action = tool;
		const source = actionPath;
		const destination = destinationPath;
		if (action !== 'move' && action !== 'rename' && action !== 'copy') return;
		if (action !== 'copy' && dirtySourceIsProtected(source)) return;
		const previousSourcePath = action === 'copy' ? null : rebasedSourcePath(source, destination);
		if (action === 'copy') {
			launchTask(
				'copy',
				() => files.startCopy(workspaceId, source, destination),
				async (result, ticket) => {
					tool = null;
					setStatus(t(`已複製至「${result.path}」。`, `Copied to "${result.path}".`));
					await refreshEntries(ticket);
				}
			);
			return;
		}
		const operation =
			action === 'move'
				? () => files.move(workspaceId, source, destination)
				: () => files.rename(workspaceId, source, destination);
		void runSimple(action, operation, async (result, ticket) => {
			tool = null;
			setStatus(t(`已更新路徑為「${result.path}」。`, `Path updated to "${result.path}".`));
			if (previousSourcePath && previousSourcePath !== sourcePath) {
				await onPathChanged(sourcePath, previousSourcePath);
			}
			await refreshEntries(ticket);
		});
	}

	function confirmDestructiveAction() {
		const pending = confirmation;
		if (!pending || operationLocked) return;
		if (dirtySourceIsProtected(pending.path)) {
			confirmation = null;
			return;
		}
		const request = confirmedWorkspaceFileRequest(files, workspaceId, pending, true);
		if (!request) return;
		if (pending.action === 'delete') {
			void runSimple('delete', request, async (receipt, ticket) => {
				if (!receipt) return;
				undoItems = [...undoItems, { ...receipt, path: pending.path }];
				confirmation = null;
				if (affectsOpenSource(pending.path)) await onSourceRemoved(sourcePath);
				setStatus(t(`已可復原刪除「${pending.path}」。`, `Recoverably deleted "${pending.path}".`));
				await refreshEntries(ticket);
			});
		} else {
			void runSimple('recycle', request, async () => {
				confirmation = null;
				if (affectsOpenSource(pending.path)) await onSourceRemoved(sourcePath);
				setStatus(t(`已將「${pending.path}」移至資源回收筒。`, `Moved "${pending.path}" to the Recycle Bin.`));
				await refreshEntries(sequence);
			});
		}
	}

	function undoDelete(item: UndoItem) {
		void runSimple('undo-delete', () => files.undoDelete(workspaceId, item.token), async (_value, ticket) => {
			undoItems = undoItems.filter((candidate) => candidate.token !== item.token);
			setStatus(t(`已復原「${item.path}」。`, `Restored "${item.path}".`));
			await refreshEntries(ticket);
		});
	}

	function dismissUndo(token: string) {
		undoItems = undoItems.filter((item) => item.token !== token);
	}

	function refreshTree() {
		launchTask('tree', () => files.startTree(workspaceId), (result) => {
			onEntries(result);
			scanEntries = null;
			searchResult = null;
			setStatus(t('檔案樹已更新。', 'File tree refreshed.'));
		});
	}

	function openSearchHit(path: string) {
		void onOpen(path);
	}

	function requestClose() {
		confirmation = null;
		tool = null;
		if (activeTask && !cancellationPending) void cancelActiveTask();
		onClose();
	}

	function cancelDialog(event: Event) {
		event.preventDefault();
		requestClose();
	}

	function formatBytes(value: number): string {
		return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-Hant').format(value);
	}

	function undoMinutes(value: number): number {
		return Math.max(1, Math.ceil(value / 60000));
	}

	onDestroy(() => {
		disposed = true;
		++sequence;
		++binaryReadTicket;
		const task = activeTask;
		activeTask = null;
		if (task) void task.cancel().catch(() => {});
		if (dialogElement?.open) dialogElement.close();
	});
</script>

<dialog
	bind:this={dialogElement}
	class="workspace-files-dialog"
	data-workspace-scope={scope}
	aria-labelledby="workspace-files-title"
	oncancel={cancelDialog}
	onclose={() => { if (open) onClose(); }}
>
	{#if open}
		<div class="workspace-files-shell">
			<header class="workspace-files-header">
				<div>
					<h2 id="workspace-files-title">{t('工作區檔案操作', 'Workspace file operations')}</h2>
					<p title={workspaceLabel}>{workspaceLabel}</p>
				</div>
				<button class="workspace-files-close" type="button" aria-label={t('關閉檔案操作', 'Close workspace file operations')} onclick={requestClose} disabled={operationLocked}>
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16" /></svg>
				</button>
			</header>

			<div class="workspace-files-content">
				<section class="workspace-files-tree-panel" aria-label={t('檔案樹與搜尋結果', 'File tree and search results')}>
					<div class="workspace-files-toolbar" aria-label={t('工作區檔案工具', 'Workspace file tools')}>
						<button type="button" disabled={operationLocked} onclick={() => selectTool('search')}>
							<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>{t('搜尋', 'Search')}
						</button>
						<button type="button" disabled={operationLocked} onclick={() => selectTool('scan')}>
							<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h10M3 15h7" /></svg>{t('掃描資料夾', 'Scan folder')}
						</button>
						<button type="button" disabled={operationLocked} onclick={() => selectTool('create-file')}>
							<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M3 10h14" /></svg>{t('新增檔案', 'New file')}
						</button>
						<button type="button" disabled={operationLocked} onclick={() => selectTool('create-directory')}>
							<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2Z" /><path d="M10 9v6M7 12h6" /></svg>{t('新增資料夾', 'New folder')}
						</button>
						<button type="button" disabled={operationLocked} onclick={refreshTree}>
							<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 0 0-11-2L3 8M4 4v4h4M4 12a6 6 0 0 0 11 2l2-2m-1 4v-4h-4" /></svg>{t('重新整理', 'Refresh')}
						</button>
					</div>

					<div class="workspace-files-tree">
						<FileTree
							entries={visibleEntries}
							{selected}
							disabled={operationLocked}
							{onOpen}
							{onCompile}
							onWorkspaceAction={handleWorkspaceAction}
							{locale}
						/>
					</div>

					{#if searchResult}
						<section class="workspace-files-results" aria-label={t('搜尋結果', 'Search results')}>
							<h3>{t('搜尋結果', 'Search results')}</h3>
							{#if searchResult.hits.length === 0}
								<p>{t('沒有符合的結果。', 'No matching results.')}</p>
							{:else}
								<ol>
									{#each searchResult.hits as hit, index (`${hit.path}:${hit.line}:${index}`)}
										<li>
											<button type="button" disabled={disabled} onclick={() => openSearchHit(hit.path)}>
												<strong>{hit.path}:{hit.line}</strong><span>{hit.preview}</span>
											</button>
										</li>
									{/each}
								</ol>
							{/if}
							{#if searchResult.truncated}<p class="workspace-files-muted">{t('結果已截斷。請縮小搜尋範圍或使用更具體的文字。', 'Results were truncated. Narrow the folder or use a more specific query.')}</p>{/if}
						</section>
					{/if}

					{#if undoItems.length}
						<section class="workspace-files-undo" aria-label={t('可復原刪除', 'Recoverable deletes')}>
							<h3>{t('可復原刪除', 'Recoverable deletes')}</h3>
							<ul>
								{#each undoItems as item (item.token)}
									<li>
										<span>{item.path} · {t(`約 ${undoMinutes(item.expiresInMs)} 分鐘內可復原`, `undo within about ${undoMinutes(item.expiresInMs)} min`)}</span>
										<button type="button" disabled={operationLocked} onclick={() => undoDelete(item)}>{t('復原', 'Undo')}</button>
										<button type="button" disabled={operationLocked} aria-label={t(`移除「${item.path}」的復原項目`, `Dismiss recovery item for "${item.path}"`)} onclick={() => dismissUndo(item.token)}>{t('移除', 'Dismiss')}</button>
									</li>
								{/each}
							</ul>
						</section>
					{/if}
				</section>

				<section class="workspace-files-tools" aria-label={t('檔案操作內容', 'File operation details')}>
					{#if activeTask}
						<div class="workspace-files-running" role="status">
							<span>{busyAction || t('工作區操作進行中', 'Workspace operation in progress')}</span>
							<button type="button" disabled={cancellationPending} onclick={cancelActiveTask}>{cancellationPending ? t('正在取消…', 'Cancelling…') : t('取消操作', 'Cancel operation')}</button>
						</div>
					{/if}

					{#if tool === 'search'}
						<section class="workspace-files-form-section">
							<h3>{t('搜尋工作區文字', 'Search workspace text')}</h3>
							<form class="workspace-files-form" onsubmit={submitSearch}>
								<label>{t('搜尋文字', 'Search text')}<input bind:value={searchQuery} required maxlength="32767" disabled={operationLocked} /></label>
								<label>{t('資料夾（留空代表整個工作區）', 'Folder (leave empty for the whole workspace)')}<input bind:value={searchDirectory} disabled={operationLocked} /></label>
								<label>{t('最多結果數（1–256）', 'Maximum results (1–256)')}<input type="number" min="1" max="256" bind:value={searchMaximum} disabled={operationLocked} /></label>
								<div class="workspace-files-form-actions">
									<button type="button" disabled={operationLocked} onclick={() => selectTool(null)}>{t('取消', 'Close')}</button>
									<button type="submit" disabled={operationLocked}>{t('搜尋', 'Search')}</button>
								</div>
							</form>
						</section>
					{:else if tool === 'scan'}
						<section class="workspace-files-form-section">
							<h3>{t('有界掃描資料夾', 'Bounded folder scan')}</h3>
							<form class="workspace-files-form" onsubmit={submitScan}>
								<label>{t('資料夾相對路徑', 'Workspace-relative folder path')}<input bind:value={scanDirectory} required disabled={operationLocked} /></label>
								<label>{t('最大深度（0–64）', 'Maximum depth (0–64)')}<input type="number" min="0" max="64" bind:value={scanDepth} disabled={operationLocked} /></label>
								<label>{t('最多項目數（1–4096）', 'Maximum entries (1–4096)')}<input type="number" min="1" max="4096" bind:value={scanMaximum} disabled={operationLocked} /></label>
								<div class="workspace-files-form-actions">
									<button type="button" disabled={operationLocked} onclick={() => selectTool(null)}>{t('取消', 'Close')}</button>
									<button type="submit" disabled={operationLocked}>{t('掃描', 'Scan')}</button>
								</div>
							</form>
						</section>
					{:else if tool === 'create-file'}
						<section class="workspace-files-form-section">
							<h3>{t('新增檔案', 'Create file')}</h3>
							<form class="workspace-files-form" onsubmit={submitCreateFile}>
								<label>{t('工作區相對路徑', 'Workspace-relative path')}<input bind:value={createFilePath} required disabled={operationLocked} /></label>
								<label>{t('UTF-8 文字內容（選擇二進位檔時會忽略）', 'UTF-8 text contents (ignored when a binary file is selected)')}<textarea bind:value={createFileContents} rows="8" maxlength="5242880" disabled={operationLocked}></textarea></label>
								<label>{t('選擇二進位內容（選填）', 'Select binary contents (optional)')}<input bind:this={binaryInput} type="file" disabled={operationLocked} onchange={chooseBinaryFile} /></label>
								{#if binaryFileLabel}
									<p class="workspace-files-binary">{t(`使用二進位內容：${binaryFileLabel}`, `Using binary contents: ${binaryFileLabel}`)} <button type="button" disabled={operationLocked} onclick={clearBinaryFile}>{t('改用文字', 'Use text')}</button></p>
								{/if}
								<div class="workspace-files-form-actions">
									<button type="button" disabled={operationLocked} onclick={() => selectTool(null)}>{t('取消', 'Close')}</button>
									<button type="submit" disabled={operationLocked}>{t('建立檔案', 'Create file')}</button>
								</div>
							</form>
						</section>
					{:else if tool === 'create-directory'}
						<section class="workspace-files-form-section">
							<h3>{t('新增資料夾', 'Create folder')}</h3>
							<form class="workspace-files-form" onsubmit={submitCreateDirectory}>
								<label>{t('工作區相對路徑', 'Workspace-relative path')}<input bind:value={createDirectoryPath} required disabled={operationLocked} /></label>
								<div class="workspace-files-form-actions">
									<button type="button" disabled={operationLocked} onclick={() => selectTool(null)}>{t('取消', 'Close')}</button>
									<button type="submit" disabled={operationLocked}>{t('建立資料夾', 'Create folder')}</button>
								</div>
							</form>
						</section>
					{:else if tool === 'move' || tool === 'rename' || tool === 'copy'}
						<section class="workspace-files-form-section">
							<h3>{tool === 'move' ? t('移動檔案或資料夾', 'Move file or folder') : tool === 'rename' ? t('重新命名檔案或資料夾', 'Rename file or folder') : t('複製檔案或資料夾', 'Copy file or folder')}</h3>
							<form class="workspace-files-form" onsubmit={submitPathOperation}>
								<label>{t('來源', 'Source')}<input value={actionPath} readonly /></label>
								<label>{t('目的地工作區相對路徑', 'Destination workspace-relative path')}<input bind:value={destinationPath} required disabled={operationLocked} /></label>
								<div class="workspace-files-form-actions">
									<button type="button" disabled={operationLocked} onclick={() => selectTool(null)}>{t('取消', 'Close')}</button>
									<button type="submit" disabled={operationLocked}>{tool === 'move' ? t('移動', 'Move') : tool === 'rename' ? t('重新命名', 'Rename') : t('複製', 'Copy')}</button>
								</div>
							</form>
						</section>
					{/if}

					{#if fileStat}
						<section class="workspace-files-stat" aria-label={t('檔案資訊', 'File details')}>
							<h3>{t('檔案資訊', 'File details')}</h3>
							<dl>
								<dt>{t('路徑', 'Path')}</dt><dd>{fileStat.path}</dd>
								<dt>{t('類型', 'Kind')}</dt><dd>{fileStat.kind === 'directory' ? t('資料夾', 'Directory') : t('檔案', 'File')}</dd>
								<dt>{t('大小', 'Size')}</dt><dd>{formatBytes(fileStat.sizeBytes)} {t('位元組', 'bytes')}</dd>
							</dl>
						</section>
					{/if}

					{#if confirmation}
						<section class="workspace-files-confirm" aria-labelledby="workspace-files-confirm-title">
							<h3 id="workspace-files-confirm-title">{confirmation.action === 'delete' ? t('確認可復原刪除', 'Confirm recoverable delete') : t('確認移至資源回收筒', 'Confirm move to Recycle Bin')}</h3>
							<p>{confirmation.path}</p>
							<p>{confirmation.action === 'delete'
								? t('檔案會保留在工作區的可復原區域，並可在此工作區有效期間內復原。', 'The bytes are kept in the workspace recovery area and can be restored while this workspace generation is active.')
								: t('檔案會交由作業系統資源回收筒處理。', 'The item will be handed to the operating system Recycle Bin.')}</p>
							<div class="workspace-files-form-actions">
								<button type="button" disabled={operationLocked} onclick={() => (confirmation = null)}>{t('取消', 'Cancel')}</button>
								<button type="button" class="workspace-files-danger" disabled={operationLocked} onclick={confirmDestructiveAction}>{confirmation.action === 'delete' ? t('可復原刪除', 'Delete recoverably') : t('移至資源回收筒', 'Move to Recycle Bin')}</button>
							</div>
						</section>
					{/if}

					{#if !tool && !fileStat && !confirmation}
						<p class="workspace-files-hint">{t('在檔案樹按右鍵可開啟檔案操作。搜尋、掃描與建立工具位於上方。', 'Right-click a file or folder for operations. Search, scan, and create tools are above.')}</p>
					{/if}

					{#if status}
						<p class="workspace-files-status" role={statusIsError ? 'alert' : 'status'} aria-live="polite">{status}</p>
					{/if}
				</section>
			</div>
		</div>
	{/if}
</dialog>

<style>
	.workspace-files-dialog {
		width: min(900px, calc(100vw - 24px));
		max-width: 900px;
		max-height: min(88vh, 900px);
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--surface);
		color: var(--ink);
		box-shadow: 0 12px 40px #0004;
		overflow: hidden;
	}
	.workspace-files-dialog::backdrop { background: #0007; }
	.workspace-files-shell { display: grid; grid-template-rows: auto minmax(0, 1fr); max-height: inherit; }
	.workspace-files-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	.workspace-files-header h2 { margin: 0; font-size: 16px; }
	.workspace-files-header p { margin: 4px 0 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
	.workspace-files-close { width: 36px; height: 36px; flex: none; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink); }
	.workspace-files-close svg, .workspace-files-toolbar svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; vertical-align: middle; }
	.workspace-files-close svg { width: 18px; height: 18px; }
	.workspace-files-content { display: grid; grid-template-columns: minmax(0, 1fr) minmax(250px, 0.9fr); min-height: 0; overflow: hidden; }
	.workspace-files-tree-panel, .workspace-files-tools { min-width: 0; min-height: 0; overflow: auto; padding: 12px; }
	.workspace-files-tree-panel { border-right: 1px solid var(--line); }
	.workspace-files-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
	.workspace-files-toolbar button, .workspace-files-running button, .workspace-files-undo button, .workspace-files-results button, .workspace-files-form button, .workspace-files-confirm button {
		min-height: 32px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink); padding: 5px 9px;
	}
	.workspace-files-toolbar button { display: inline-flex; align-items: center; gap: 5px; }
	.workspace-files-toolbar button:hover, .workspace-files-form button:hover, .workspace-files-undo button:hover { background: var(--canvas); }
	.workspace-files-toolbar button:disabled, .workspace-files-form button:disabled, .workspace-files-undo button:disabled { opacity: 0.55; }
	.workspace-files-tree { max-height: 48vh; overflow: auto; border: 1px solid var(--line); background: var(--surface); }
	.workspace-files-results, .workspace-files-undo, .workspace-files-stat, .workspace-files-form-section, .workspace-files-confirm { margin-top: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
	.workspace-files-results h3, .workspace-files-undo h3, .workspace-files-stat h3, .workspace-files-form-section h3, .workspace-files-confirm h3 { margin: 0 0 8px; font-size: 14px; }
	.workspace-files-results ol, .workspace-files-undo ul { list-style: none; padding: 0; margin: 0; }
	.workspace-files-results li + li, .workspace-files-undo li + li { margin-top: 6px; }
	.workspace-files-results li button { width: 100%; display: grid; gap: 3px; text-align: left; overflow-wrap: anywhere; }
	.workspace-files-results li button span { color: var(--muted); }
	.workspace-files-undo li { display: flex; align-items: center; justify-content: space-between; gap: 8px; overflow-wrap: anywhere; font-size: 12px; }
	.workspace-files-muted, .workspace-files-hint { color: var(--muted); font-size: 12px; }
	.workspace-files-tools { display: flex; flex-direction: column; gap: 10px; }
	.workspace-files-form { display: grid; gap: 10px; }
	.workspace-files-form label { display: grid; gap: 4px; font-size: 12px; }
	.workspace-files-form input, .workspace-files-form textarea { width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 3px; background: var(--canvas); color: var(--ink); padding: 7px; font: inherit; }
	.workspace-files-form textarea { resize: vertical; }
	.workspace-files-form-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
	.workspace-files-running { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border-left: 3px solid var(--accent); background: var(--canvas); font-size: 12px; }
	.workspace-files-stat dl { display: grid; grid-template-columns: minmax(60px, auto) minmax(0, 1fr); gap: 6px 10px; margin: 0; font-size: 12px; }
	.workspace-files-stat dt { color: var(--muted); }
	.workspace-files-stat dd { margin: 0; overflow-wrap: anywhere; }
	.workspace-files-confirm { border-color: var(--error); }
	.workspace-files-danger { border-color: var(--error) !important; color: var(--error) !important; }
	.workspace-files-binary { margin: 0; color: var(--muted); overflow-wrap: anywhere; font-size: 12px; }
	.workspace-files-status { margin: auto 0 0; padding: 8px; border-left: 3px solid var(--accent); background: var(--canvas); overflow-wrap: anywhere; font-size: 12px; }
	.workspace-files-status[role='alert'] { border-left-color: var(--error); }
	@media (max-width: 640px) {
		.workspace-files-dialog { width: calc(100vw - 12px); max-height: 94vh; }
		.workspace-files-content { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, auto) minmax(0, 1fr); }
		.workspace-files-tree-panel { border-right: 0; border-bottom: 1px solid var(--line); }
		.workspace-files-tree { max-height: 32vh; }
		.workspace-files-tools { min-height: 160px; }
	}
</style>
