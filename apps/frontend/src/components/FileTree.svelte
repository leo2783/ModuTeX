<script lang="ts">
	import type { FileEntry } from '@modutex/frontend-contracts';
	import { tick } from 'svelte';
	import type { WorkspaceFileAction } from '../features/files/workspace-files.ts';
	import { text, type Language } from '../i18n/text.ts';
	let { entries, selected, disabled, onOpen, onCompile, onWorkspaceAction, onNewWorkspaceFile, locale = 'zh-Hant' }: { entries: readonly FileEntry[]; selected: string; disabled: boolean; onOpen: (path: string) => void | Promise<void>; onCompile?: (path: string) => void | Promise<void>; onWorkspaceAction?: (action: WorkspaceFileAction, path: string) => void | Promise<void>; onNewWorkspaceFile?: (parentPath?: string) => void; locale?: Language } = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
	let menu = $state<{ path: string; kind: 'file' | 'directory'; x: number; y: number; target: HTMLElement } | null>(null);
	let menuElement = $state<HTMLDivElement>();
	let notice = $state('');
	async function openMenu(event: MouseEvent | KeyboardEvent, path: string, kind: 'file' | 'directory') {
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const pointer = event instanceof MouseEvent;
		const width = onWorkspaceAction ? 240 : 220;
		const height = Math.min(window.innerHeight * 0.8, onWorkspaceAction ? 468 : 156);
		menu = {
			path,
			kind,
			target,
			x: Math.max(0, Math.min(pointer ? event.clientX || rect.left : rect.left, window.innerWidth - width)),
			y: Math.max(0, Math.min(pointer ? event.clientY || rect.bottom : rect.bottom, window.innerHeight - height))
		};
		await tick(); menuElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}
	function closeMenu(restore = false) { const target = menu?.target; menu = null; if (restore) target?.focus(); }
	async function act(action: 'open' | 'compile' | 'copy') {
		const path = menu?.path; closeMenu(true); if (!path) return;
		if (action === 'open') await onOpen(path);
		else if (action === 'compile') await onCompile?.(path);
		else try { await navigator.clipboard.writeText(path); notice = t('已複製相對路徑', 'Relative path copied'); }
		catch { notice = t('無法複製路徑', 'Could not copy the path'); }
	}
	async function workspaceAct(action: WorkspaceFileAction) {
		const path = menu?.path;
		closeMenu(true);
		if (!path || !onWorkspaceAction) return;
		try { await onWorkspaceAction(action, path); }
		catch { notice = t('檔案操作失敗', 'Workspace file operation failed'); }
	}
	function createFileInFolder() {
		const path = menu?.path;
		closeMenu(true);
		if (path && onNewWorkspaceFile && !disabled) onNewWorkspaceFile(path);
	}
	function isContextMenuKey(event: KeyboardEvent): boolean {
		return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
	}
	const children = $derived.by(() => {
		const unique = new Map<string, FileEntry>();
		for (const entry of entries) {
			unique.set(entry.path, entry);
			const parts = entry.path.split('/');
			for (let length = 1; length < parts.length; length++) {
				const path = parts.slice(0, length).join('/');
				if (!unique.has(path)) unique.set(path, { path, kind: 'directory' });
			}
		}
		const tree = new Map<string, FileEntry[]>();
		for (const entry of unique.values()) {
			const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));
			const siblings = tree.get(parent) ?? []; siblings.push(entry); tree.set(parent, siblings);
		}
		for (const siblings of tree.values()) siblings.sort((a, b) => a.kind !== b.kind ? a.kind === 'directory' ? -1 : 1 : a.path.localeCompare(b.path));
		return tree;
	});
</script>

<svelte:window onclick={(event) => { if (menu && !menuElement?.contains(event.target as Node)) closeMenu(); }} onkeydown={(event) => { if (menu && event.key === 'Escape') { event.preventDefault(); closeMenu(true); } }} onresize={() => closeMenu()} />

{#snippet branch(parent: string, depth: number)}
	{#each children.get(parent) ?? [] as entry (entry.path)}
		{#if entry.kind === 'directory'}
			<details class="tree-folder" open={depth === 0}>
				<summary
					style:padding-left={`${8 + depth * 14}px`}
					oncontextmenu={(event) => openMenu(event, entry.path, 'directory')}
					onkeydown={(event) => { if (!disabled && isContextMenuKey(event)) void openMenu(event, entry.path, 'directory'); }}
				>
					<svg class="tree-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
					<svg class="tree-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2Z" /></svg>
					<span title={entry.path}>{entry.path.split('/').at(-1)}</span>
				</summary>
				{@render branch(entry.path, depth + 1)}
			</details>
		{:else}
			<button
				class="tree-file file-row"
				style:padding-left={`${26 + depth * 14}px`}
				aria-current={selected === entry.path ? 'true' : undefined}
				{disabled}
				title={entry.path}
				onclick={() => onOpen(entry.path)}
				oncontextmenu={(event) => openMenu(event, entry.path, 'file')}
				onkeydown={(event) => { if (!disabled && isContextMenuKey(event)) void openMenu(event, entry.path, 'file'); }}
			>
				<svg class="tree-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2h8l4 4v12H4ZM12 2v5h4" /></svg><span>{entry.path.split('/').at(-1)}</span>
			</button>
		{/if}
	{/each}
{/snippet}
<div class="file-tree">{@render branch('', 0)}</div>
{#if menu}
	<div class="file-context-menu" bind:this={menuElement} style:left={`${menu.x}px`} style:top={`${menu.y}px`} role="group" aria-label={t('檔案操作', 'File actions')}>
		{#if menu.kind === 'file'}
			<button {disabled} onclick={() => act('open')}>{t('開啟', 'Open')}</button>
			{#if onCompile && /\.tex$/i.test(menu.path)}<button {disabled} onclick={() => act('compile')}>{t('編譯 PDF', 'Compile PDF')}</button>{/if}
		{:else}
			{#if onNewWorkspaceFile}<button {disabled} onclick={createFileInFolder}>{t('在此資料夾新增檔案', 'Create file in this folder')}</button>{/if}
			{#if onWorkspaceAction}
			<button {disabled} onclick={() => workspaceAct('scan')}>{t('掃描資料夾…', 'Scan folder…')}</button>
			<button {disabled} onclick={() => workspaceAct('search')}>{t('搜尋此資料夾…', 'Search this folder…')}</button>
			{/if}
		{/if}
		<button onclick={() => act('copy')}>{t('複製相對路徑', 'Copy relative path')}</button>
		{#if onWorkspaceAction}
			<hr />
			<button {disabled} onclick={() => workspaceAct('stat')}>{t('檔案資訊', 'File details')}</button>
			<button {disabled} onclick={() => workspaceAct('move')}>{t('移動…', 'Move…')}</button>
			<button {disabled} onclick={() => workspaceAct('rename')}>{t('重新命名…', 'Rename…')}</button>
			<button {disabled} onclick={() => workspaceAct('copy')}>{t('複製檔案…', 'Copy item…')}</button>
			<button {disabled} onclick={() => workspaceAct('recycle')}>{t('移至資源回收筒', 'Move to Recycle Bin')}</button>
			<button {disabled} onclick={() => workspaceAct('delete')}>{t('可復原刪除…', 'Recoverable delete…')}</button>
			<button {disabled} onclick={() => workspaceAct('reveal')}>{t('在檔案總管顯示', 'Reveal in Explorer')}</button>
		{/if}
	</div>
{/if}
{#if notice}<div class="tree-notice" role="status">{notice}</div>{/if}

<style>
	.file-context-menu { position: fixed; z-index: 30; width: 240px; max-height: 80vh; overflow: auto; padding: 4px; border: 1px solid var(--line); background: var(--surface); box-shadow: 0 4px 12px #0002; }
	.file-context-menu button { display: block; width: 100%; text-align: left; border: none; background: transparent; color: var(--ink); padding: 8px; }
	.file-context-menu button:hover { background: var(--selection); }
	.file-context-menu hr { border: 0; border-top: 1px solid var(--line); margin: 3px 4px; }
	.tree-notice { padding: 6px 12px; font-size: 12px; }
	.tree-file, summary { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 8px; font-size: 13px; white-space: nowrap; cursor: pointer; }
	.tree-file { width: 100%; margin: 0; text-align: left; border: none; border-radius: 0; background: transparent; color: var(--ink); }
	summary { list-style: none; } summary::-webkit-details-marker { display: none; }
	.tree-file span, summary span { overflow: hidden; text-overflow: ellipsis; }
	.tree-file:hover, summary:hover { background: var(--canvas); }
	.tree-file[aria-current='true'] { background: var(--selection); color: var(--ink); }
	.tree-icon, .tree-chevron { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.4; }
	.tree-folder[open] > summary .tree-chevron { transform: rotate(90deg); }
</style>
