<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Where from '$lib/docs/Where.svelte';
	import tableSettingsShot from '$lib/assets/showcase/app/table-settings-panel.png';

	const where = [
		{ label: 'Toolbar', value: 'The table icon in the toolbar', note: 'A size grid, up to 10×10.' },
		{ label: 'Menu', value: 'Insert › Table', note: 'Drops a fixed 3×3 table to build up from, rather than another size picker.' }
	];
</script>

<DocsHead
	title={'Tables'}
	description={"Build tables in Texpile's visual editor: insert by size, merge cells, per-column alignment, and row rules like \\toprule and \\midrule."}
	path="/docs/visual-editing/tables"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Tables'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">{'Tables are edited as a grid, not as rows of ampersands and backslashes.'}</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<div class="mt-10 space-y-10">
	<Section
		title={'Numbered vs. unnumbered'}
		body={"This is decided when you insert the table, with a Numbered table switch on the toolbar's grid picker, and there is no way to flip it afterward. A numbered table gets a caption and an optional notes section beneath it, and is referenceable with @; an unnumbered one is just the grid."}
	/>
	<Section
		title={'Merging cells'}
		body={'Select two or more cells and right-click for Merge Cells (and Split Cell to undo it), the way to build a spanning header or combine related data.'}
	/>
	<Section
		title={'Table settings'}
		body={'Hover the table for a Settings icon: per-column alignment and width, an optional vertical line between columns, the notes-section toggle, and under Advanced options, the LaTeX Label and the row rules (`\\toprule`, `\\midrule`, `\\bottomrule`) before or after any row.'}
	>
		<Figure
			src={tableSettingsShot}
			alt={"A table's settings panel: per-column alignment, vertical lines, a LaTeX label, and row rules"}
			narrow
		/>
	</Section>
</div>
