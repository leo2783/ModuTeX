<script lang="ts">
	let { kind }: { kind: 'bold' | 'italic' | 'underline' | 'equation' | 'matrix' | 'table' } = $props();
</script>
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	{#if kind === 'bold'}<path stroke-width="2.8" d="M7 4h6a4 4 0 0 1 0 8H7m0-8v16h7a4 4 0 0 0 0-8H7" />
	{:else if kind === 'italic'}<path d="M11 4h8M5 20h8M15 4 9 20" />
	{:else if kind === 'underline'}<path d="M6 4v7a6 6 0 0 0 12 0V4M5 21h14" />
	{:else if kind === 'equation'}<path d="M19 5H6l7 7-7 7h13" />
	{:else if kind === 'matrix'}<path d="M6 3H3v18h3M18 3h3v18h-3M8 8h1m6 0h1M8 16h1m6 0h1" />
	{:else}<rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 9h18M3 14h18M9 4v16M15 4v16" />{/if}
</svg>
