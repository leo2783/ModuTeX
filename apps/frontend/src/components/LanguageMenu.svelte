<script lang="ts">
	import type { Language } from '../i18n/text.ts';
	import { text } from '../i18n/text.ts';

	let { locale, onChange }: { locale: Language; onChange: (language: Language) => void } = $props();
	let menu: HTMLDetailsElement;
	const label = () => text(locale, '語言', 'Language');
	function choose(language: Language) { onChange(language); menu.open = false; }
	function close(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !menu.open) return;
		event.preventDefault();
		menu.open = false;
		menu.querySelector('summary')?.focus();
	}
</script>

<svelte:window
	onclick={event => { if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false; }}
	onkeydown={close}
/>

<details class="language-menu" bind:this={menu}>
	<summary aria-label={label()} title={label()}>
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/></svg>
	</summary>
	<div class="language-options" role="group" aria-label={text(locale, '語言選項', 'Language options')}>
		{#each [['zh-Hant', '繁體中文'], ['en', 'English']] as const as choice}
			<button type="button" lang={choice[0]} aria-pressed={locale === choice[0]} onclick={() => choose(choice[0])}>
				{choice[1]}<span aria-hidden="true">{locale === choice[0] ? '✓' : ''}</span>
			</button>
		{/each}
	</div>
</details>

<style>
	.language-menu { position: relative; flex: none; }
	.language-menu > summary {
		list-style: none;
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 4px;
		cursor: pointer;
		color: var(--ink);
	}
	.language-menu > summary:hover,
	.language-menu[open] > summary { background: var(--selection); }
	.language-menu > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.language-options {
		position: absolute;
		inset-block-start: calc(100% + 4px);
		inset-inline-end: 0;
		z-index: 70;
		min-width: 152px;
		padding: 4px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 7px;
		box-shadow: 0 8px 24px rgb(0 0 0 / .14);
	}
	.language-options button {
		width: 100%;
		min-height: 34px;
		padding: 6px 10px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		text-align: start;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--ink);
	}
	.language-options button:hover,
	.language-options button[aria-pressed='true'] { background: var(--selection); }
</style>
