<script lang="ts">
	import { Check } from '@lucide/svelte';
	import Prose from './Prose.svelte';

	let { items }: { items: string[] } = $props();
</script>

<ul class="space-y-2.5">
	{#each items as item (item)}
		<li class="flex items-start gap-3">
			<Check class="text-primary-500 mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} />
			<span class="text-surface-700 leading-relaxed"><Prose text={item} /></span>
		</li>
	{/each}
</ul>
