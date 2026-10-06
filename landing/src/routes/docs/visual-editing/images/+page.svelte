<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Where from '$lib/docs/Where.svelte';

	const where = [
		{ label: 'In the editor', value: 'Drag a file onto the editor, or paste one from your clipboard' },
		{ label: 'Menu', value: 'Insert › Image…' }
	];
</script>

<DocsHead
	title={'Images'}
	description={"Add and edit figures in Texpile's visual editor: drag and drop, paste from the clipboard, resize handles, captions, numbering, and a custom LaTeX label."}
	path="/docs/visual-editing/images"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Images'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'A figure is a real image on the page, not a file path you have to picture in your head.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<div class="mt-10 space-y-10">
	<Section
		title={'Resizing'}
		body={'Select the image and drag the handles that appear at its corners and edges. Size snaps to fractions of the text width, so it stays a clean value in the LaTeX rather than an odd decimal. Preferences › Image resize step sets how coarse that snapping is (10%, 25%, or 50%).'}
	/>
	<Section
		title={'Caption and numbering'}
		body={'Hover the top right of the image for a Settings icon. Show Caption adds a caption field below it; Numbered labels it automatically ("Figure 1") and makes it referenceable with @. A Size slider is here too, for fine adjustment beyond the drag handles.'}
	/>
	<Section
		title={'Advanced: custom labels'}
		body={'Advanced options in the same Settings panel exposes the LaTeX Label directly, so you can rename it to something you will actually remember. If you never set one, Texpile has already generated a random label for the image, so @ references still work.'}
	/>
</div>
