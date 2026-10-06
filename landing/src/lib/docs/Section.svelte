<script lang="ts">
	import type { Snippet } from 'svelte';
	import Prose from './Prose.svelte';

	let { title, body, children }: { title: string; body?: string; children?: Snippet } = $props();

	// anchor targets for deep links; the sticky navbar is 4rem, hence scroll-mt
	const id = $derived(
		title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-|-$/g, '')
	);
</script>

<section {id} class="scroll-mt-20">
	<h2 class="text-surface-900 text-xl font-semibold md:text-2xl">{title}</h2>
	{#if body}
		<p class="text-surface-600 mt-3 leading-relaxed"><Prose text={body} /></p>
	{/if}
	{#if children}
		<div class="mt-4">{@render children()}</div>
	{/if}
</section>
