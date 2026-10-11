<script lang="ts">
	import type { FileEntry } from '@modutex/frontend-contracts';
	import { tick } from 'svelte';
	import { text, type Language } from '../i18n/text.ts';
	let { entries, selected, disabled, onOpen, onCompile, locale = 'zh-Hant' }: { entries: readonly FileEntry[]; selected: string; disabled: boolean; onOpen: (path: string) => void | Promise<void>; onCompile?: (path: string) => void | Promise<void>; locale?: Language } = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
	let menu = $state<{ path: string; x: number; y: number; target: HTMLButtonElement } | null>(null);
	let menuElement = $state<HTMLDivElement>();
	let notice = $state('');
	async function openMenu(event: MouseEvent, path: string) {
		event.preventDefault();
		const target = event.currentTarget as HTMLButtonElement, rect = target.getBoundingClientRect();
		menu = { path, target, x: Math.max(0, Math.min(event.clientX || rect.left, window.innerWidth - 220)), y: Math.max(0, Math.min(event.clientY || rect.bottom, window.innerHeight - 132)) };
		await tick(); menuElement?.querySelector<HTMLButtonElement>('button')?.focus();
	}
	function closeMenu(restore = false) { const target = menu?.target; menu = null; if (restore) target?.focus(); }
	async function act(action: 'open' | 'compile' | 'copy') {
		const path = menu?.path; closeMenu(true); if (!path) return;
		if (action === 'open') await onOpen(path);
		else if (action === 'compile') await onCompile?.(path);
		else try { await navigator.clipboard.writeText(path); notice = t('已複製相對路徑', 'Relative path copied'); }
		catch { notice = t('無法複製路徑', 'Could not copy the path'); }
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
				<summary style:padding-left={`${8 + depth * 14}px`}>
					<svg class="tree-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
					<svg class="tree-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2Z" /></svg>
					<span title={entry.path}>{entry.path.split('/').at(-1)}</span>
				</summary>
				{@render branch(entry.path, depth + 1)}
			</details>
		{:else}
			<button class="tree-file file-row" style:padding-left={`${26 + depth * 14}px`} aria-current={selected === entry.path ? 'true' : undefined} {disabled} title={entry.path} onclick={() => onOpen(entry.path)} oncontextmenu={(event) => openMenu(event, entry.path)}>
				<svg class="tree-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2h8l4 4v12H4ZM12 2v5h4" /></svg><span>{entry.path.split('/').at(-1)}</span>
			</button>
		{/if}
	{/each}
{/snippet}
<div class="file-tree">{@render branch('', 0)}</div>
{#if menu}
	<div class="file-context-menu" bind:this={menuElement} style:left={`${menu.x}px`} style:top={`${menu.y}px`} role="group" aria-label={t('檔案操作', 'File actions')}>
		<button {disabled} onclick={() => act('open')}>{t('開啟', 'Open')}</button>
		{#if onCompile && /\.tex$/i.test(menu.path)}<button {disabled} onclick={() => act('compile')}>{t('編譯 PDF', 'Compile PDF')}</button>{/if}
		<button onclick={() => act('copy')}>{t('複製相對路徑', 'Copy relative path')}</button>
	</div>
{/if}
{#if notice}<div class="tree-notice" role="status">{notice}</div>{/if}

<style>
	.file-context-menu { position: fixed; z-index: 30; width: 220px; padding: 4px; border: 1px solid var(--line); background: var(--surface); box-shadow: 0 4px 12px #0002; }
	.file-context-menu button { display: block; width: 100%; text-align: left; border: none; background: transparent; color: var(--ink); padding: 8px; }
	.file-context-menu button:hover { background: var(--selection); }
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
