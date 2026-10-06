<script lang="ts">
	// h3 under a Section, for pages that split a step per platform. Same anchor scheme as Section,
	// so titles across a page have to stay unique or the ids collide.
	import type { Snippet } from 'svelte';
	import Prose from './Prose.svelte';

	let { title, body, children }: { title: string; body?: string; children?: Snippet } = $props();

	const id = $derived(
		title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-|-$/g, '')
	);
</script>

<section {id} class="scroll-mt-20">
	<h3 class="text-surface-900 text-lg font-semibold">{title}</h3>
	{#if body}
		<p class="text-surface-600 mt-2 leading-relaxed"><Prose text={body} /></p>
	{/if}
	{#if children}
		<div class="mt-4">{@render children()}</div>
	{/if}
</section>
