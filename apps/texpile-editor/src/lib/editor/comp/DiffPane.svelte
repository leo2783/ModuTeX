<script lang="ts">
	// Git-diff view: the status/controls strip above DiffPanel.
	import { RefreshCw, GitCompare, X, Info, Columns2, Rows2 } from '@lucide/svelte';
	import { isTexpileManaged, managedKind } from '$lib/comments/managed';
	import DiffPanel from './DiffPanel.svelte';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		filename: string;
		original: string;
		modified: string;
		layout: 'unified' | 'split';
		loading: boolean;
		error: string | null;
		hasHead: boolean;
		onToggleLayout: () => void;
		onRefresh: () => void;
		onExit: () => void;
	}
	let { filename, original, modified, layout, loading, error, hasHead, onToggleLayout, onRefresh, onExit }: Props = $props();

	/** what the managed file actually holds, so the note is about THIS file and not the last one */
	function managedNote(path: string): string {
		const kind = managedKind(path);
		if (kind === 'comments') return m.vcs_texpile_managed_note();
		if (kind === 'config') return m.texpile_managed_config_note();
		if (kind === 'ignore') return m.texpile_managed_ignore_note();
		return m.texpile_managed_other_note();
	}
</script>

<div class="flex h-full flex-col">
	<!-- min-h-10 is the app's bar height, shared with the PDF, editor and draft toolbars: this sits
	     level with the PDF toolbar across the split instead of a few pixels short of it -->
	<div
		class="bg-surface-100-900 text-surface-600-300 border-surface-200-800 flex min-h-10 shrink-0 items-center gap-2 border-b px-3 text-xs"
	>
		<GitCompare class="size-3.5 shrink-0" />
		<span class="font-medium">{m.wsview_diff_heading()}</span>
		{#if loading}<span class="text-surface-500">· {m.wsview_diff_loading()}</span>
		{:else if error}<span class="text-error-500 truncate">· {error}</span>
		{:else if !hasHead}<span class="text-surface-500">· {m.wsview_diff_new_file()}</span>{/if}
		<div class="ml-auto flex shrink-0 items-center gap-1">
			<button
				class="hover:preset-tonal rounded p-0.5"
				onclick={onRefresh}
				title={m.wsview_refresh_diff()}
				aria-label={m.wsview_refresh_diff()}
			>
				<RefreshCw class="size-3.5" />
			</button>
			<!-- icon, like Refresh beside it: the label was the longest thing in this bar and the first
			     to crowd it in a narrow editor column. Shows what you switch TO - two columns for
			     side-by-side, stacked rows for inline - with the wording kept on the tooltip. -->
			<button
				class="hover:preset-tonal rounded p-0.5"
				onclick={onToggleLayout}
				title={layout === 'unified' ? m.wsview_switch_to_side_by_side() : m.wsview_switch_to_inline()}
				aria-label={layout === 'unified' ? m.wsview_side_by_side_label() : m.wsview_inline_label()}
			>
				{#if layout === 'unified'}<Columns2 class="size-3.5" />{:else}<Rows2 class="size-3.5" />{/if}
			</button>
			<!-- icon-only too, so the bar is three matching controls. Keeps the primary tint on hover:
			     it is the one that leaves the diff, not another view option. -->
			<button
				class="hover:preset-tonal-primary rounded p-0.5"
				onclick={onExit}
				title={m.wsview_back_to_editor_title()}
				aria-label={m.wsview_close_label()}
			>
				<X class="size-3.5" />
			</button>
		</div>
	</div>
	{#if isTexpileManaged(filename)}
		<!-- before the diff, not after: a wall of JSONL with no explanation is a file you delete.
		     .texpile is hidden from the tree, so this and the Source Control row are the only two
		     places anyone ever meets it. -->
		<!-- same 40px bar as the editor's, so meeting this file in a diff and meeting it in the editor
		     look like the same notice -->
		<div
			class="border-surface-200-800 text-surface-600-300 flex min-h-10 shrink-0 items-center gap-2 border-b px-3 text-xs"
			title={managedNote(filename)}
		>
			<Info class="text-primary-500 size-3.5 shrink-0" />
			<p class="min-w-0 truncate"><span class="font-medium">{m.vcs_texpile_managed()}.</span> {managedNote(filename)}</p>
		</div>
	{/if}
	<!-- the inset lives here rather than on EditorPane's scroller: only the diff BODY needs to keep
	     its scrollbar off the divider lozenge, and the bars above must still reach it -->
	<div class="scroll-inset-r min-h-0 flex-1 overflow-auto">
		{#key filename}
			<DiffPanel {filename} {original} {modified} {layout} />
		{/key}
	</div>
</div>
