<script lang="ts">
	// Renders inline `code` spans from backtick-delimited segments in otherwise plain text, for LaTeX
	// commands and template placeholders (\ref{label}, {main}) embedded in a sentence. These are all
	// short, well-known patterns, so a hand-rolled tokenizer colors them without pulling the
	// build-time Shiki highlighter (used for the one real code block, on the Compiling page) into
	// every single inline mention. Colors match Shiki's github-light palette for consistency.
	let { text }: { text: string } = $props();

	const parts = $derived(text.split(/(`[^`]+`)/g).filter((s) => s !== ''));

	type Token = { text: string; color?: string; class?: string };

	// \command, \\ (line break), {argument}, or plain text/punctuation in between
	const TOKEN_RE = /\\\\|\\[a-zA-Z]+|\{[^}]*\}|[^\\{}]+/g;

	function tokenize(code: string): Token[] {
		const tokens: Token[] = [];
		for (const t of code.match(TOKEN_RE) ?? []) {
			if (t.startsWith('\\')) {
				tokens.push({ text: t, color: '#6F42C1' }); // command name
			} else if (t.startsWith('{')) {
				tokens.push({ text: '{', class: 'text-surface-400' });
				if (t.length > 2) tokens.push({ text: t.slice(1, -1), color: '#032F62' }); // argument
				tokens.push({ text: '}', class: 'text-surface-400' });
			} else {
				tokens.push({ text: t, class: 'text-surface-800' });
			}
		}
		return tokens;
	}
</script>

{#each parts as part, i (i)}
	{#if part.startsWith('`') && part.endsWith('`')}
		<code class="bg-surface-100 rounded px-1 py-0.5 font-mono text-[0.9em]"
			>{#each tokenize(part.slice(1, -1)) as tok, j (j)}<span class={tok.class} style={tok.color ? `color:${tok.color}` : undefined}
					>{tok.text}</span
				>{/each}</code
		>
	{:else}
		{part}
	{/if}
{/each}
