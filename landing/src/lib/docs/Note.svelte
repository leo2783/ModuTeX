<script lang="ts">
	import { Info } from '@lucide/svelte';
	import Prose from './Prose.svelte';

	let { body }: { body: string } = $props();
</script>

<div class="border-primary-500/30 bg-primary-50/60 rounded-lg border p-4">
	<div class="flex items-start gap-3">
		<Info class="text-primary-600 mt-0.5 h-4 w-4 shrink-0" />
		<p class="text-surface-700 text-sm leading-relaxed"><Prose text={body} /></p>
	</div>
</div>
