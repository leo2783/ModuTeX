<script lang="ts">
	// How to point an assistant at the MCP server. Its own modal rather than an expanding panel in
	// Preferences: these are read once and then never again, so they should not cost height in the
	// settings list forever.
	//
	// Stacks ABOVE Preferences. Every other modal in the app sits at z-1300 because they are mutually
	// exclusive; this one is the first that opens on top of another, so it needs its own layer.
	//
	// Per-client blocks rather than one command, because they are not interchangeable: Claude Code
	// takes a CLI call, Codex takes a TOML entry in a config file. Labelling them was the point -
	// showing only the Claude form left Codex users with something that looks like it should work.
	import { X, Check, Copy } from '@lucide/svelte';
	import { m } from '$lib/paraglide/messages';

	let { open = $bindable(false), port }: { open?: boolean; port: number | null } = $props();

	const url = $derived(port ? `http://127.0.0.1:${port}` : '');
	const claudeCmd = $derived(url ? `claude mcp add --transport http modutex ${url}` : '');
	// keys per OpenAI's own MCP docs: a `url` entry selects streamable HTTP, `command` selects stdio
	const codexToml = $derived(url ? `[mcp_servers.modutex]\nurl = "${url}"` : '');

	let copied = $state('');
	async function copy(what: string, text: string) {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copied = what;
			setTimeout(() => (copied = ''), 2000);
		} catch (e) {
			console.error('Failed to copy:', e);
		}
	}
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

{#snippet block(label: string, note: string, text: string, key: string)}
	<div>
		<div class="mb-1 flex items-baseline justify-between gap-3">
			<span class="text-sm font-medium">{label}</span>
			<span class="text-surface-500 text-[11px]">{note}</span>
		</div>
		<div class="flex items-start gap-2">
			<code
				class="bg-surface-200-800 rounded-base text-surface-900-100 min-w-0 flex-1 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
				>{text}</code
			>
			<button class="btn btn-xs preset-tonal shrink-0 text-xs" onclick={() => copy(key, text)} aria-label={m.prefs_mcp_copy()}>
				{#if copied === key}<Check class="size-3.5" />{:else}<Copy class="size-3.5" />{/if}
			</button>
		</div>
	</div>
{/snippet}

{#if open}
	<div
		class="fixed inset-0 z-1400 flex items-center justify-center app-scrim bg-black/40 p-4"
		role="presentation"
		onmousedown={(e) => e.target === e.currentTarget && (open = false)}
	>
		<div class="card bg-surface-50-950 border-surface-300-700 flex max-h-full w-full max-w-lg flex-col border p-5 shadow-2xl">
			<div class="mb-3 flex items-center justify-between gap-4">
				<h2 class="text-base font-semibold">{m.mcpsetup_title()}</h2>
				<button class="btn-icon btn-icon-xs hover:preset-tonal" aria-label={m.mcpsetup_close()} onclick={() => (open = false)}>
					<X class="size-4" />
				</button>
			</div>

			<div class="min-h-0 space-y-4 overflow-y-auto">
				<p class="text-surface-600-400 text-sm">{m.mcpsetup_intro({ addr: url })}</p>
				{@render block(m.mcpsetup_claude(), 'CLI', claudeCmd, 'claude')}
				{@render block(m.mcpsetup_codex(), m.mcpsetup_codex_note(), codexToml, 'codex')}
				<p class="text-surface-500 border-surface-300-700 border-t pt-3 text-xs">{m.mcpsetup_generic()}</p>
			</div>
		</div>
	</div>
{/if}
