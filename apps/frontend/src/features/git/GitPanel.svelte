<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
	import { text, type Language } from '../../i18n/text.ts';
	import { previewGitBytes } from './git-output.mjs';
	import {
		GitCommandError,
		tauriGitAdapter,
		type GitAvailability,
		type TauriGitAdapter,
		type GitStatus,
		type GitStatusCode,
		type GitStatusEntry,
		type GitUnavailableReason
	} from './tauri-git.mjs';

	let { workspaceId, locale = 'zh-Hant' }: { workspaceId: string | null; locale?: Language } = $props();

	type GitOperation =
		| 'initialize'
		| 'stage'
		| 'stage-all'
		| 'unstage'
		| 'unstage-all'
		| 'discard'
		| 'diff'
		| 'log'
		| 'show'
		| 'commit'
		| 'username';
	type GitOutput = { readonly title: string; readonly bytes: Uint8Array };
	type SelectedPathMode = 'stage' | 'unstage' | 'discard' | 'diff';

	const t = (zh: string, en: string) => text(locale, zh, en);
	const git = tauriGitAdapter();

	let availability = $state.raw<GitAvailability | null>(null);
	let status = $state.raw<GitStatus | null>(null);
	let repository = $state<boolean | null>(null);
	let loading = $state(false);
	let busy = $state<GitOperation | null>(null);
	let error = $state.raw<GitCommandError | null>(null);
	let notice = $state('');
	let selectedPaths = $state<string[]>([]);
	let output = $state.raw<GitOutput | null>(null);
	let outputPreview = $derived(output ? previewGitBytes(output.bytes) : null);
	let commitMessage = $state('');
	let userName = $state<string | null>(null);
	let userNameLoaded = $state(false);
	let userNameLoading = $state(false);
	let userNameError = $state<GitCommandError | null>(null);

	let scopeEpoch = 0;
	let scopeOwner: string | null = null;

	const selectedEntries = $derived.by(() => {
		const selected = new Set(selectedPaths);
		return (status?.entries ?? []).filter((entry) => selected.has(entry.path));
	});

	function isCurrent(owner: string, epoch: number): boolean {
		return scopeOwner === owner && workspaceId === owner && scopeEpoch === epoch;
	}

	function failure(value: unknown): GitCommandError {
		if (value instanceof GitCommandError) return value;
		if (value instanceof Error && value.message) {
			return new GitCommandError('GIT_OPERATION_FAILED', value.message);
		}
		return new GitCommandError('GIT_OPERATION_FAILED', 'The Git operation could not be completed.');
	}

	function errorTitle(code: string): string {
		switch (code) {
			case 'NOT_REPOSITORY':
				return t('此資料夾尚未初始化 Git。', 'This folder is not a Git repository.');
			case 'ALREADY_REPOSITORY':
				return t('此資料夾已是 Git 儲存庫。', 'This folder is already a Git repository.');
			case 'NO_HEAD':
				return t('儲存庫尚無提交。', 'The repository has no commit yet.');
			case 'NOTHING_TO_COMMIT':
				return t('沒有已暫存的變更可提交。', 'There are no staged changes to commit.');
			case 'UNRESOLVED_CONFLICTS':
				return t('請先解決合併衝突。', 'Resolve merge conflicts first.');
			case 'PATH_NOT_CHANGED':
				return t('所選路徑已不再有 Git 變更。', 'The selected paths no longer have Git changes.');
			case 'RENAME_REQUIRES_BOTH_PATHS':
				return t('重新命名操作需要同時選取新舊路徑。', 'A rename operation requires both paths.');
			case 'LINK_NOT_ALLOWED':
				return t('Git 操作拒絕連結或重新解析路徑。', 'Git rejected a linked or reparse-point path.');
			case 'PATH_OUTSIDE_WORKSPACE':
				return t('Git 路徑超出目前工作區。', 'The Git path is outside this workspace.');
			case 'STALE_WORKSPACE':
			case 'WORKSPACE_CLOSED':
				return t('工作區已關閉，請重新開啟。', 'The workspace is closed. Reopen it.');
			case 'CANCELLED':
				return t('Git 操作已取消。', 'The Git operation was cancelled.');
			case 'OUTPUT_LIMIT_EXCEEDED':
				return t('Git 輸出超過安全上限。', 'Git output exceeded its safe limit.');
			case 'GIT_UNAVAILABLE':
			case 'UNAVAILABLE':
			case 'NOT_INSTALLED':
				return t('目前無法使用 Git。', 'Git is unavailable.');
			case 'UNSAFE_EXECUTABLE':
				return t('Git 執行檔未通過安全檢查。', 'The Git executable failed a safety check.');
			case 'UNSAFE_ENVIRONMENT':
				return t('Git 執行環境未通過安全檢查。', 'The Git environment failed a safety check.');
			case 'UNSUPPORTED_PLATFORM':
				return t('此平台不支援 Git 整合。', 'Git integration is not supported on this platform.');
			case 'INVALID_COMMIT_MESSAGE':
				return t('提交訊息無效。', 'The commit message is invalid.');
			case 'INVALID_USER_NAME':
				return t('Git 使用者名稱設定無效。', 'The configured Git user name is invalid.');
			case 'COMMAND_FAILED':
				return t('Git 指令失敗。', 'The Git command failed.');
			default:
				return t('Git 操作失敗。', 'The Git operation failed.');
		}
	}

	function availabilityText(reason: GitUnavailableReason): string {
		switch (reason) {
			case 'NOT_INSTALLED':
				return t('找不到 Git。編輯、儲存與編譯仍可使用。', 'Git is not installed. Editing, saving, and compiling remain available.');
			case 'UNSUPPORTED_PLATFORM':
				return t('此平台不支援 Git 整合。編輯、儲存與編譯仍可使用。', 'Git integration is unsupported on this platform. Editing, saving, and compiling remain available.');
			case 'UNSAFE_EXECUTABLE':
				return t('Git 執行檔未通過安全檢查。編輯、儲存與編譯仍可使用。', 'The Git executable failed a safety check. Editing, saving, and compiling remain available.');
			case 'UNSAFE_ENVIRONMENT':
				return t('Git 執行環境未通過安全檢查。編輯、儲存與編譯仍可使用。', 'The Git environment failed a safety check. Editing, saving, and compiling remain available.');
		}
	}

	function statusText(code: GitStatusCode): string {
		switch (code) {
			case 'UNCHANGED': return t('未變更', 'Unchanged');
			case 'MODIFIED': return t('已修改', 'Modified');
			case 'TYPE_CHANGED': return t('類型變更', 'Type changed');
			case 'ADDED': return t('新增', 'Added');
			case 'DELETED': return t('已刪除', 'Deleted');
			case 'RENAMED': return t('已重新命名', 'Renamed');
			case 'COPIED': return t('已複製', 'Copied');
			case 'UNMERGED': return t('衝突', 'Unmerged');
			case 'UNTRACKED': return t('未追蹤', 'Untracked');
		}
	}

	function operationText(operation: GitOperation): string {
		switch (operation) {
			case 'initialize': return t('正在初始化 Git…', 'Initializing Git…');
			case 'stage': return t('正在暫存所選變更…', 'Staging selected changes…');
			case 'stage-all': return t('正在暫存所有變更…', 'Staging all changes…');
			case 'unstage': return t('正在取消暫存所選變更…', 'Unstaging selected changes…');
			case 'unstage-all': return t('正在取消所有暫存…', 'Unstaging all changes…');
			case 'discard': return t('正在等待主機確認並捨棄變更…', 'Waiting for host confirmation and discarding changes…');
			case 'diff': return t('正在讀取 Git 差異…', 'Reading Git diff…');
			case 'log': return t('正在讀取 Git 紀錄…', 'Reading Git log…');
			case 'show': return t('正在讀取 HEAD…', 'Reading HEAD…');
			case 'commit': return t('正在提交變更…', 'Committing changes…');
			case 'username': return t('正在讀取 Git 使用者名稱…', 'Reading Git user name…');
		}
	}

	async function readStatus(port: TauriGitAdapter, owner: string, epoch: number): Promise<void> {
		try {
			const next: GitStatus = await port.status(owner);
			if (!isCurrent(owner, epoch)) return;
			status = next;
			repository = true;
			error = null;
			const present = new Set(next.entries.map((entry) => entry.path));
			selectedPaths = selectedPaths.filter((path) => present.has(path));
		} catch (value) {
			if (!isCurrent(owner, epoch)) return;
			const issue = failure(value);
			status = null;
			if (issue.code === 'NOT_REPOSITORY') {
				repository = false;
				error = null;
				selectedPaths = [];
				return;
			}
			repository = null;
			error = issue;
		}
	}

	async function readUserName(port: TauriGitAdapter, owner: string, epoch: number): Promise<void> {
		userNameLoading = true;
		userNameError = null;
		try {
			const value = await port.userName(owner);
			if (!isCurrent(owner, epoch)) return;
			userName = value;
			userNameLoaded = true;
		} catch (value) {
			if (!isCurrent(owner, epoch)) return;
			userNameError = failure(value);
			userNameLoaded = false;
		} finally {
			if (isCurrent(owner, epoch)) userNameLoading = false;
		}
	}

	async function loadOwner(owner: string, epoch: number): Promise<void> {
		const port = git;
		if (!port || !isCurrent(owner, epoch)) return;
		loading = true;
		error = null;
		try {
			const next = await port.availability();
			if (!isCurrent(owner, epoch)) return;
			availability = next;
			if (next.status === 'unavailable') {
				repository = null;
				status = null;
				return;
			}
			await readStatus(port, owner, epoch);
			if (!isCurrent(owner, epoch)) return;
			await readUserName(port, owner, epoch);
		} catch (value) {
			if (isCurrent(owner, epoch)) error = failure(value);
		} finally {
			if (isCurrent(owner, epoch)) loading = false;
		}
	}

	$effect(() => {
		const owner = workspaceId;
		const epoch = ++scopeEpoch;
		scopeOwner = owner;
		availability = null;
		status = null;
		repository = null;
		loading = owner !== null && git !== null;
		busy = null;
		error = null;
		notice = '';
		selectedPaths = [];
		output = null;
		commitMessage = '';
		userName = null;
		userNameLoaded = false;
		userNameLoading = false;
		userNameError = null;
		if (owner && git) void loadOwner(owner, epoch);
		return () => {
			if (scopeEpoch === epoch) {
				scopeEpoch++;
				scopeOwner = null;
			}
		};
	});

	async function refreshGit(): Promise<void> {
		const owner = workspaceId;
		const epoch = scopeEpoch;
		if (!owner || !git || !isCurrent(owner, epoch) || loading || busy) return;
		notice = '';
		userNameError = null;
		await loadOwner(owner, epoch);
	}

	async function withBusy(
		operation: GitOperation,
		action: (port: TauriGitAdapter, owner: string, epoch: number) => Promise<void>
	): Promise<void> {
		const port = git;
		const owner = workspaceId;
		const epoch = scopeEpoch;
		if (!port || !owner || !isCurrent(owner, epoch) || loading || busy !== null) return;
		busy = operation;
		error = null;
		notice = '';
		try {
			await action(port, owner, epoch);
		} catch (value) {
			if (isCurrent(owner, epoch)) error = failure(value);
		} finally {
			if (isCurrent(owner, epoch)) busy = null;
		}
	}

	function isRename(entry: GitStatusEntry): boolean {
		return entry.index === 'RENAMED' || entry.worktree === 'RENAMED';
	}

	function pathsForSelected(mode: SelectedPathMode): string[] {
		const paths = new Set<string>();
		for (const entry of selectedEntries) {
			paths.add(entry.path);
			if (
				entry.originalPath &&
				isRename(entry) &&
				(mode === 'stage' || mode === 'discard' || mode === 'diff')
			) {
				paths.add(entry.originalPath);
			}
		}
		return [...paths];
	}

	async function refreshStatusAfterChange(port: TauriGitAdapter, owner: string, epoch: number): Promise<void> {
		if (isCurrent(owner, epoch)) await readStatus(port, owner, epoch);
	}

	async function initializeRepository(): Promise<void> {
		await withBusy('initialize', async (port, owner, epoch) => {
			await port.init(owner);
			if (!isCurrent(owner, epoch)) return;
			await refreshStatusAfterChange(port, owner, epoch);
			if (isCurrent(owner, epoch) && repository) {
				notice = t('Git 儲存庫已初始化。', 'Git repository initialized.');
			}
		});
	}

	async function stageSelected(): Promise<void> {
		const paths = pathsForSelected('stage');
		if (!paths.length) return;
		await withBusy('stage', async (port, owner, epoch) => {
			await port.stage(owner, paths);
			if (!isCurrent(owner, epoch)) return;
			notice = t('所選變更已暫存。', 'Selected changes staged.');
			await refreshStatusAfterChange(port, owner, epoch);
		});
	}

	async function stageAll(): Promise<void> {
		await withBusy('stage-all', async (port, owner, epoch) => {
			await port.stage(owner, []);
			if (!isCurrent(owner, epoch)) return;
			notice = t('所有變更已暫存。', 'All changes staged.');
			await refreshStatusAfterChange(port, owner, epoch);
		});
	}

	async function unstageSelected(): Promise<void> {
		const paths = pathsForSelected('unstage');
		if (!paths.length) return;
		await withBusy('unstage', async (port, owner, epoch) => {
			await port.unstage(owner, paths);
			if (!isCurrent(owner, epoch)) return;
			notice = t('所選暫存變更已取消。', 'Selected changes unstaged.');
			await refreshStatusAfterChange(port, owner, epoch);
		});
	}

	async function unstageAll(): Promise<void> {
		await withBusy('unstage-all', async (port, owner, epoch) => {
			await port.unstage(owner, []);
			if (!isCurrent(owner, epoch)) return;
			notice = t('所有暫存變更已取消。', 'All changes unstaged.');
			await refreshStatusAfterChange(port, owner, epoch);
		});
	}

	async function discardSelected(): Promise<void> {
		const paths = pathsForSelected('discard');
		if (!paths.length) return;
		await withBusy('discard', async (port, owner, epoch) => {
			// Confirmation is performed by the trusted host. False means the user
			// cancelled; the renderer never substitutes its own confirmation dialog.
			const discarded = await port.discard(owner, paths);
			if (!isCurrent(owner, epoch)) return;
			if (!discarded) {
				notice = t('已取消捨棄；檔案未變更。', 'Discard cancelled; files were not changed.');
				return;
			}
			notice = t('所選變更已捨棄。', 'Selected changes discarded.');
			await refreshStatusAfterChange(port, owner, epoch);
		});
	}

	async function runOutput(
		operation: GitOperation,
		title: readonly [string, string],
		action: (port: TauriGitAdapter, owner: string) => Promise<Uint8Array>
	): Promise<void> {
		await withBusy(operation, async (port, owner, epoch) => {
			const bytes = await action(port, owner);
			if (!isCurrent(owner, epoch)) return;
			output = { title: t(title[0], title[1]), bytes };
		});
	}

	async function workingDiff(): Promise<void> {
		const paths = pathsForSelected('diff');
		await runOutput('diff', ['工作區差異', 'Worktree diff'], (port, owner) =>
			port.diff(owner, false, paths)
		);
	}

	async function stagedDiff(): Promise<void> {
		const paths = pathsForSelected('diff');
		await runOutput('diff', ['暫存差異', 'Staged diff'], (port, owner) =>
			port.diff(owner, true, paths)
		);
	}

	async function showLog(): Promise<void> {
		await runOutput('log', ['Git 紀錄', 'Git log'], (port, owner) => port.log(owner));
	}

	async function showHead(): Promise<void> {
		await runOutput('show', ['HEAD 原始輸出', 'HEAD raw output'], (port, owner) => port.show(owner));
	}

	async function commit(): Promise<void> {
		if (commitMessage.length === 0) return;
		const message = commitMessage;
		await withBusy('commit', async (port, owner, epoch) => {
			const bytes = await port.commit(owner, message);
			if (!isCurrent(owner, epoch)) return;
			commitMessage = '';
			output = { title: t('提交輸出', 'Commit output'), bytes };
			notice = t('提交已完成。', 'Commit completed.');
			await refreshStatusAfterChange(port, owner, epoch);
		});
	}

	async function refreshUserName(): Promise<void> {
		await withBusy('username', async (port, owner, epoch) => {
			await readUserName(port, owner, epoch);
		});
	}

	function toggleSelected(path: string, checked: boolean): void {
		if (checked) {
			if (!selectedPaths.includes(path)) selectedPaths = [...selectedPaths, path];
		} else {
			selectedPaths = selectedPaths.filter((selected) => selected !== path);
		}
	}
</script>

<section class="git-panel" aria-labelledby="workbench-git-heading" aria-busy={loading || busy !== null}>
	<div class="git-heading">
		<h2 id="workbench-git-heading">{t('版本控制', 'Version control')} <span>Git</span></h2>
		{#if workspaceId && git}
			<button type="button" onclick={refreshGit} disabled={loading || busy !== null}>
				{t('重新整理', 'Refresh')}
			</button>
		{/if}
	</div>

	<div class="git-feedback" aria-live="polite">
		{#if loading}
			<p role="status">{t('正在檢查 Git 與工作區…', 'Checking Git and workspace…')}</p>
		{:else if busy}
			<p role="status">{operationText(busy)}</p>
		{:else if notice}
			<p role="status">{notice}</p>
		{/if}
	</div>

	{#if !workspaceId}
		<p class="git-muted" role="status">{t('開啟資料夾後可使用 Git。', 'Open a folder to use Git.')}</p>
	{:else if !git}
		<p class="git-muted" role="status">{t('Git 整合僅能在桌面應用程式中使用。', 'Git integration is available only in the desktop application.')}</p>
	{:else if availability?.status === 'unavailable'}
		<p class="git-unavailable" role="status">{availabilityText(availability.reason)}</p>
	{:else if availability?.status === 'available' && repository === false}
		<p class="git-muted">{t('此資料夾尚未建立 Git 儲存庫。', 'This folder does not have a Git repository yet.')}</p>
		<button type="button" onclick={initializeRepository} disabled={loading || busy !== null}>
			{t('初始化 Git 儲存庫', 'Initialize Git repository')}
		</button>
	{:else if availability?.status === 'available' && repository === true}
		{#if userNameLoading}
			<p class="git-muted" role="status">{t('正在讀取 Git 使用者名稱…', 'Reading Git user name…')}</p>
		{:else if userNameLoaded}
			<p class="git-user">
				{t('Git 使用者名稱：', 'Git user name: ')}
				<strong>{userName ?? t('尚未設定', 'Not configured')}</strong>
				<button type="button" onclick={refreshUserName} disabled={loading || busy !== null}>
					{t('重新讀取', 'Read again')}
				</button>
			</p>
		{:else}
			<p class="git-muted" role="status">{t('尚未讀取 Git 使用者名稱。', 'Git user name has not been read.')}</p>
			<button type="button" onclick={refreshUserName} disabled={loading || busy !== null}>
				{t('讀取使用者名稱', 'Read user name')}
			</button>
		{/if}

		{#if status && status.entries.length === 0}
			<p class="git-empty" role="status">{t('工作區沒有 Git 變更。', 'There are no Git changes in this workspace.')}</p>
		{:else if status}
			<p class="git-selection-hint">
				{t('勾選變更以操作；差異未選取路徑時會涵蓋全部。', 'Select changes to act on them. Diffs with no selection include all paths.')}
			</p>
			<div class="git-entry-list" aria-label={t('Git 變更', 'Git changes')}>
				{#each status.entries as entry (entry.path)}
					<label class="git-entry">
						<input
							type="checkbox"
							checked={selectedPaths.includes(entry.path)}
							disabled={loading || busy !== null}
							aria-label={t('選取 ' + entry.path, 'Select ' + entry.path)}
							onchange={(event) => toggleSelected(entry.path, (event.currentTarget as HTMLInputElement).checked)}
						/>
						<span class="git-entry-main">
							<span class="git-entry-path" title={entry.path}>{entry.path}</span>
							{#if entry.originalPath}
								<span class="git-entry-old-path">{t('原路徑：', 'From: ')}{entry.originalPath}</span>
							{/if}
							<span class="git-entry-codes">
								<span>{t('暫存', 'Index')}: {statusText(entry.index)}</span>
								<span>{t('工作區', 'Worktree')}: {statusText(entry.worktree)}</span>
							</span>
						</span>
					</label>
				{/each}
			</div>
		{/if}

		{#if repository === true}
			<div class="git-toolbar" aria-label={t('暫存與捨棄', 'Stage and discard')}>
				<button type="button" onclick={stageSelected} disabled={loading || busy !== null || selectedEntries.length === 0}>
					{t('暫存所選', 'Stage selected')}
				</button>
				<button type="button" onclick={stageAll} disabled={loading || busy !== null}>
					{t('暫存全部', 'Stage all')}
				</button>
				<button type="button" onclick={unstageSelected} disabled={loading || busy !== null || selectedEntries.length === 0}>
					{t('取消所選暫存', 'Unstage selected')}
				</button>
				<button type="button" onclick={unstageAll} disabled={loading || busy !== null}>
					{t('取消全部暫存', 'Unstage all')}
				</button>
				<button type="button" onclick={discardSelected} disabled={loading || busy !== null || selectedEntries.length === 0}>
					{t('捨棄所選…', 'Discard selected…')}
				</button>
			</div>
			<div class="git-toolbar" aria-label={t('檢視 Git 輸出', 'View Git output')}>
				<button type="button" onclick={workingDiff} disabled={loading || busy !== null}>
					{t('工作區差異', 'Worktree diff')}
				</button>
				<button type="button" onclick={stagedDiff} disabled={loading || busy !== null}>
					{t('暫存差異', 'Staged diff')}
				</button>
				<button type="button" onclick={showLog} disabled={loading || busy !== null}>
					{t('Git 紀錄', 'Git log')}
				</button>
				<button type="button" onclick={showHead} disabled={loading || busy !== null}>
					{t('顯示 HEAD', 'Show HEAD')}
				</button>
			</div>
			<label class="git-commit-label" for="workbench-git-commit-message">
				{t('提交訊息', 'Commit message')}
			</label>
			<textarea
				id="workbench-git-commit-message"
				rows="2"
				maxlength="32767"
				bind:value={commitMessage}
				disabled={loading || busy !== null}
				aria-describedby="workbench-git-commit-hint"
			></textarea>
			<p id="workbench-git-commit-hint" class="git-muted">
				{t('僅提交已暫存的變更；作者名稱使用 Git 設定。', 'Only staged changes are committed. The author name comes from Git configuration.')}
			</p>
			<button type="button" onclick={commit} disabled={loading || busy !== null || commitMessage.length === 0}>
				{t('提交已暫存變更', 'Commit staged changes')}
			</button>
		{/if}
	{:else if error}
		<p class="git-muted" role="status">{t('無法讀取 Git 狀態。請重新整理或查看錯誤。', 'Git status could not be read. Refresh or review the error.')}</p>
	{:else if loading}
		<p class="git-muted" role="status">{t('正在讀取 Git 狀態…', 'Reading Git status…')}</p>
	{:else}
		<p class="git-muted" role="status">{t('Git 狀態尚未載入。', 'Git status has not loaded.')}</p>
	{/if}

	{#if error}
		<div class="git-error" role="alert">
			<strong>{errorTitle(error.code)}</strong>
			<code>{error.code}</code>
			{#if error.message}<span>{error.message}</span>{/if}
		</div>
	{/if}

	{#if userNameError}
		<div class="git-error" role="alert">
			<strong>{errorTitle(userNameError.code)}</strong>
			<code>{userNameError.code}</code>
			{#if userNameError.message}<span>{userNameError.message}</span>{/if}
		</div>
	{/if}

	{#if output && outputPreview}
		<section class="git-output" aria-label={output.title}>
			<div class="git-output-heading">
				<strong>{output.title}</strong>
				<button type="button" onclick={() => (output = null)}>{t('關閉輸出', 'Close output')}</button>
			</div>
			{#if outputPreview.kind === 'text'}
				<textarea
					class="git-output-viewer"
					tabindex="0"
					readonly
					wrap="soft"
					rows={Math.min(11, outputPreview.text.split('\n').length)}
					aria-label={output.title}
					value={outputPreview.text || t('（空輸出）', '(empty output)')}
				></textarea>
				{#if outputPreview.truncated}
					<p class="git-muted" role="status">
						{t(
							'僅顯示前 ' + outputPreview.displayedBytes + ' / ' + outputPreview.totalBytes + ' 位元組。',
							'Showing the first ' + outputPreview.displayedBytes + ' of ' + outputPreview.totalBytes + ' bytes.'
						)}
					</p>
				{/if}
			{:else}
				<p class="git-muted" role="status">
					{t(
						'二進位或非 UTF-8 輸出；保留原始位元組，以下僅顯示前 ' + outputPreview.hexBytes + ' / ' + outputPreview.totalBytes + ' 位元組的十六進位預覽。',
						'Binary or non-UTF-8 output. Original bytes are retained; the hex preview shows ' + outputPreview.hexBytes + ' of ' + outputPreview.totalBytes + ' bytes.'
					)}
				</p>
				<textarea
					class="git-output-viewer"
					tabindex="0"
					readonly
					wrap="soft"
					rows={Math.min(11, outputPreview.hex.split('\n').length)}
					aria-label={t('二進位輸出十六進位預覽', 'Binary output hex preview')}
					value={outputPreview.hex || t('（空輸出）', '(empty output)')}
				></textarea>
			{/if}
		</section>
	{/if}
</section>

<style>
	.git-panel {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding: 8px 12px;
		border-top: 1px solid var(--line);
		color: var(--ink);
	}
	.git-heading,
	.git-output-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.git-heading h2 {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
	}
	.git-heading h2 span {
		color: var(--muted);
		font-weight: 400;
	}
	.git-panel button,
	.git-panel textarea {
		font: inherit;
	}
	.git-panel button {
		min-height: 28px;
		max-width: 100%;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: 3px;
		background: var(--surface);
		color: var(--ink);
		cursor: pointer;
		overflow-wrap: anywhere;
	}
	.git-panel button:hover:not(:disabled) {
		background: var(--canvas);
	}
	.git-panel button:focus-visible,
	.git-panel input:focus-visible,
	.git-panel textarea:focus-visible,
	.git-output textarea.git-output-viewer:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.git-panel button:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}
	.git-feedback p,
	.git-panel p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.git-muted,
	.git-feedback {
		color: var(--muted);
		font-size: 12px;
	}
	.git-unavailable,
	.git-empty {
		font-size: 12px;
	}
	.git-user {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.git-user strong {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.git-selection-hint {
		color: var(--muted);
		font-size: 12px;
	}
	.git-entry-list {
		min-width: 0;
		max-height: 240px;
		overflow: auto;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.git-entry {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
		padding: 6px 2px;
		border-bottom: 1px solid var(--line);
		cursor: pointer;
	}
	.git-entry:last-child {
		border-bottom: 0;
	}
	.git-entry input {
		flex: 0 0 auto;
		margin: 3px 0 0;
	}
	.git-entry-main {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		font-size: 12px;
	}
	.git-entry-path,
	.git-entry-old-path {
		overflow-wrap: anywhere;
	}
	.git-entry-old-path,
	.git-entry-codes {
		color: var(--muted);
		font-size: 11px;
	}
	.git-entry-codes {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 8px;
	}
	.git-toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		min-width: 0;
	}
	.git-toolbar button {
		flex: 1 1 auto;
	}
	.git-commit-label {
		font-size: 12px;
		font-weight: 600;
	}
	.git-panel textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		min-height: 48px;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: 3px;
		background: var(--surface);
		color: var(--ink);
		resize: vertical;
	}
	.git-error {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		padding-left: 8px;
		border-left: 2px solid var(--error);
		color: var(--error);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.git-error code {
		color: inherit;
		font-size: 11px;
	}
	.git-output {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding-top: 8px;
		border-top: 1px solid var(--line);
	}
	.git-output-heading strong {
		min-width: 0;
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.git-output textarea.git-output-viewer {
		display: block;
		box-sizing: border-box;
		width: 100%;
		max-width: 100%;
		max-height: 180px;
		margin: 0;
		padding: 6px;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 0;
		appearance: none;
		background: var(--canvas);
		color: var(--ink);
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 11px;
		line-height: 1.4;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		resize: none;
	}
</style>
