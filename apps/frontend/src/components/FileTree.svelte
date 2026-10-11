<script lang="ts">
	import type { FileEntry } from '@modutex/frontend-contracts';
	let { entries, selected, disabled, onOpen }: { entries: readonly FileEntry[]; selected: string; disabled: boolean; onOpen: (path: string) => void } = $props();
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
			<button class="tree-file file-row" style:padding-left={`${26 + depth * 14}px`} aria-current={selected === entry.path ? 'true' : undefined} {disabled} title={entry.path} onclick={() => onOpen(entry.path)}>
				<svg class="tree-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2h8l4 4v12H4ZM12 2v5h4" /></svg><span>{entry.path.split('/').at(-1)}</span>
			</button>
		{/if}
	{/each}
{/snippet}
<div class="file-tree">{@render branch('', 0)}</div>

<style>
	.tree-file, summary { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 8px; font-size: 13px; white-space: nowrap; cursor: pointer; }
	.tree-file { width: 100%; margin: 0; text-align: left; border: none; border-radius: 0; background: transparent; color: var(--ink); }
	summary { list-style: none; } summary::-webkit-details-marker { display: none; }
	.tree-file span, summary span { overflow: hidden; text-overflow: ellipsis; }
	.tree-file:hover, summary:hover { background: var(--canvas); }
	.tree-file[aria-current='true'] { background: var(--selection); color: var(--ink); }
	.tree-icon, .tree-chevron { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.4; }
	.tree-folder[open] > summary .tree-chevron { transform: rotate(90deg); }
</style>
