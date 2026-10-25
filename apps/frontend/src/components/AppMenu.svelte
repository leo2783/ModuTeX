<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		menuClass = '',
		children
	}: {
		label: string;
		menuClass?: string;
		children: Snippet;
	} = $props();

	let menu: HTMLDetailsElement;
	function closeOnEscape(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !menu.open) return;
		event.preventDefault();
		menu.open = false;
		menu.querySelector('summary')?.focus();
	}
	function closeOnWindowClick(event: MouseEvent) {
		if (!(event.target instanceof Node) || !menu) return;
		if (!menu.contains(event.target)) {
			if (menu.open) menu.open = false;
			return;
		}
		if (event.target instanceof Element && event.target.closest('button, a')) menu.open = false;
	}
</script>

<svelte:window onkeydown={closeOnEscape} onclick={closeOnWindowClick} />

<details bind:this={menu} class={`app-menu ${menuClass}`}>
	<summary aria-label={label}>
		{label}
		<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg>
	</summary>
	<div class="app-menu-items" aria-label={label}>
		{@render children()}
	</div>
</details>

<style>
	.app-menu { position: relative; }
	.app-menu > summary {
		list-style: none;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 36px;
		padding: 7px 12px;
		border-radius: 4px;
		cursor: pointer;
	}
	.app-menu > summary::-webkit-details-marker { display: none; }
	.app-menu > summary:hover,
	.app-menu[open] > summary { background: var(--selection); }
	.app-menu > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.app-menu > summary svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; }
	.app-menu-items {
		position: absolute;
		inset-block-start: calc(100% + 6px);
		inset-inline-end: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 208px;
		max-width: min(320px, 90vw);
		padding: 5px;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--surface);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
	}
	.app-menu.file-menu > .app-menu-items { inset-inline-start: 0; inset-inline-end: auto; }
	.app-menu-items :global(button),
	.app-menu-items :global(a) {
		width: 100%;
		min-height: 36px;
		padding: 7px 10px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--ink);
		text-align: start;
		text-decoration: none;
		white-space: nowrap;
	}
	.app-menu-items :global(button:hover:not(:disabled)),
	.app-menu-items :global(a:hover) { background: var(--selection); }
	.app-menu-items :global(hr) { width: 100%; border: 0; border-top: 1px solid var(--line); margin: 3px 0; }
</style>
