<script lang="ts">
	import { onMount } from 'svelte';
	let { onReady }: { onReady?: () => void } = $props();
	onMount(() => onReady?.());
</script>

<div data-testid="diagram-editor-ready-seam"></div>
