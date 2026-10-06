<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Where from '$lib/docs/Where.svelte';

	const where = [
		{
			label: 'Toolbar',
			value: 'The dashed-square icon in the toolbar',
			note: 'Select parent block. Click again to select its parent, and again, walking up the document.'
		}
	];
</script>

<DocsHead
	title={'Smart selection'}
	description={"Select and move whole blocks in Texpile's visual editor: the toolbar's Select parent block button, per-block hover controls, and the equation-block selector."}
	path="/docs/visual-editing/smart-selection"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Smart selection'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">{'Two ways to work with a block as a unit instead of the text inside it.'}</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<div class="mt-10 space-y-10">
	<Section
		title={'Select parent block'}
		body={"With your cursor anywhere in a block, click the toolbar's Select parent block button to select the whole thing — a paragraph, an equation, a table. Click it again and the selection grows to that block's parent, and again for its parent, one level at a time."}
	/>
	<Section
		title={'In an equation'}
		body={'The math toolbar has the same idea, scoped to math: a Select equation block button selects the whole equation you are editing, in one click.'}
	/>
	<Section
		title={'The block handle'}
		body={'Hover any block and a handle appears in the left margin: drag it to move the block, click + to insert a new block below, or the trash icon to delete it — no selection required first.'}
	/>
</div>
