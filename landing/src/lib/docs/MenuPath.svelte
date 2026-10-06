<script lang="ts">
	// A menu path called out on its own, not buried in a sentence (e.g. "Insert › Math"). The Where
	// block already renders paths as values; this is for a path worth a reader's eye mid-paragraph.
	import { ChevronRight } from '@lucide/svelte';

	let { path }: { path: string } = $props();

	// split on the app's own "›" separator so each segment gets its own chip
	const segments = $derived(path.split('›').map((s) => s.trim()));
</script>

<div
	class="border-primary-300 bg-primary-50 text-primary-700 mb-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-sm font-semibold"
>
	{#each segments as segment, i (segment)}
		{#if i > 0}<ChevronRight class="h-3.5 w-3.5 shrink-0 opacity-60" />{/if}
		<span>{segment}</span>
	{/each}
</div>
