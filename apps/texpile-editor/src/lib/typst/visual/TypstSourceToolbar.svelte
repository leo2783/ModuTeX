<script lang="ts">
	// Typst source-mode toolbar: the typst sibling of MarkdownSourceToolbar. The SHELL mirrors the
	// LaTeX SourceToolbar (groups, borders, icon metrics); every action writes Typst markup into
	// the CodeMirror view. No active-state highlighting, same trade-off as the other source bars.
	import { Bold, Italic, Code, List, ListOrdered, Link as LinkIcon, SquareRadical, Image as ImageIcon } from '@lucide/svelte';
	import type { EditorState, TransactionSpec } from '@codemirror/state';
	import { sourceCmView } from '$lib/stores/editorStore';
	import ToolbarOverflow from '$lib/editor/comp/toolbar/ToolbarOverflow.svelte';
	import type { OverflowItem } from '$lib/editor/comp/toolbar/toolbarOverflow';
	import TypstSourceTableDropdown from './TypstSourceTableDropdown.svelte';
	import {
		computeToggleDelim,
		computeHeadingLine,
		computeListLines,
		computeFence,
		computeLink,
		computeMathBlock,
		computeFigureSkeleton
	} from './sourceInsert';
	import { m } from '$lib/paraglide/messages';

	function run(build: (state: EditorState) => TransactionSpec) {
		return (e: MouseEvent) => {
			e.preventDefault(); // keep focus (and the caret) in the CodeMirror view
			const view = $sourceCmView;
			if (!view) return;
			view.dispatch(build(view.state));
			view.focus();
		};
	}
</script>

{#snippet iconButton(label: string, action: (e: MouseEvent) => void, IconComp: typeof Bold)}
	<li class="toolbarButton hover:preset-tonal">
		<button onclick={action} class="flex items-center p-1" aria-label={label} title={label}>
			<IconComp class="h-4.5 w-4.5" />
		</button>
	</li>
{/snippet}

<div class="flex min-w-0 flex-1 items-center gap-1 sm:gap-1.5" data-keep-caret role="presentation" onmousedown={(e) => e.preventDefault()}>
	{#snippet st_format(_item: OverflowItem)}
		<ul class="border-surface-300-700 flex items-center gap-1 border-r pr-1.5 sm:gap-1.5 sm:pr-2">
			{@render iconButton(
				m.srctoolbar_bold_aria(),
				run((s) => computeToggleDelim(s, '*')),
				Bold
			)}
			{@render iconButton(
				m.srctoolbar_italic_aria(),
				run((s) => computeToggleDelim(s, '_')),
				Italic
			)}
			{@render iconButton(
				m.srctoolbar_monospace_aria(),
				run((s) => computeToggleDelim(s, '`')),
				Code
			)}
			{@render iconButton(
				m.srctoolbar_inline_math_aria(),
				run((s) => computeToggleDelim(s, '$')),
				SquareRadical
			)}
		</ul>
	{/snippet}
	{#snippet st_headings(_item: OverflowItem)}
		<ul class="border-surface-300-700 flex items-center gap-1 border-r pr-1.5 sm:gap-1.5 sm:pr-2">
			{#each [1, 2, 3] as level (level)}
				<li class="toolbarButton hover:preset-tonal">
					<button
						onclick={run((s) => computeHeadingLine(s, level))}
						class="flex items-center p-1 text-xs font-semibold"
						aria-label={m.mdtoolbar_heading_n({ n: level })}
						title={m.mdtoolbar_heading_n({ n: level })}
					>
						H{level}
					</button>
				</li>
			{/each}
		</ul>
	{/snippet}
	{#snippet st_blocks(_item: OverflowItem)}
		<ul class="border-surface-300-700 flex items-center gap-1 border-r pr-1.5 sm:gap-1.5 sm:pr-2">
			{@render iconButton(
				m.blockmenu_bullet_list(),
				run((s) => computeListLines(s, '- ')),
				List
			)}
			{@render iconButton(
				m.blockmenu_numbered_list(),
				run((s) => computeListLines(s, '+ ')),
				ListOrdered
			)}
			{@render iconButton(m.blockmenu_code_block(), run(computeFence), Code)}
			{@render iconButton(m.blockmenu_math_block(), run(computeMathBlock), SquareRadical)}
		</ul>
	{/snippet}
	{#snippet st_inserts(_item: OverflowItem)}
		<ul class="flex items-center gap-1 sm:gap-1.5">
			{@render iconButton(m.mdtoolbar_link(), run(computeLink), LinkIcon)}
			<li>
				<TypstSourceTableDropdown />
			</li>
			{@render iconButton(m.menubar_insert_image(), run(computeFigureSkeleton), ImageIcon)}
		</ul>
	{/snippet}

	<ToolbarOverflow
		gapClass="gap-1 sm:gap-1.5"
		menuLabel={m.toolbar_more_actions_aria()}
		items={[
			{ id: 'format', pinned: true, render: st_format },
			{ id: 'headings', pinned: true, render: st_headings },
			{ id: 'blocks', render: st_blocks },
			{ id: 'inserts', render: st_inserts }
		]}
	/>
</div>

<style lang="postcss">
	@reference "../../../app.css";

	.toolbarButton {
		@apply rounded-base transition-all ease-in-out;
	}
</style>
