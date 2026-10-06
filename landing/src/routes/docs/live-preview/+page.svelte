<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Bullets from '$lib/docs/Bullets.svelte';
	import Note from '$lib/docs/Note.svelte';
	import Where from '$lib/docs/Where.svelte';
	import livePreviewMp4 from '$lib/assets/showcase/live-preview.mp4';
	import compileModalShot from '$lib/assets/showcase/app/compile-command-modal.png';

	const where = [
		{
			label: 'Toolbar',
			value: 'The Preview button',
			note: 'Top right of the editor. It reads Live while the engine is running; click it to pause.'
		},
		{ label: 'Setting', value: 'Terminal › Configure compile command… › Live mode' }
	];
	const renders = [
		'Math, footnotes, and tables inside floats.',
		'Beamer slides.',
		'TikZ and pgfplots figures, drawn as regions taken from the real compile.',
		'Large documents paint only the pages in view.'
	];
	const languages = [
		'Right-to-left documents render right to left, with Arabic letters joined.',
		'Greek, Cyrillic, and Chinese, Japanese, and Korean text render correctly.',
		'Fonts load from OpenType, TrueType collections, and classic Type 1 math families.'
	];
</script>

<DocsHead
	title={'Live preview'}
	description={"Texpile's live preview updates the page as you type, compiled by your own TeX installation, with no manual compile step."}
	path="/docs/live-preview"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Live preview'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'The page updates as you type, compiled by your own TeX installation. There is nothing to compile by hand, and nothing leaves your machine.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<Figure
	mp4={livePreviewMp4}
	alt={'A page updating in the live preview while the source is edited'}
	caption={'A page updating in the live preview while the source is edited'}
/>

<div class="space-y-10">
	<Section
		title={'What you are looking at'}
		body={'The page on screen is the same PDF a manual compile would produce, not an approximation of it. When you pause, what you see is the exact compiled page.'}
	>
		<Figure src={compileModalShot} alt={'The compile command dialog with the Live mode toggle'} narrow />
	</Section>
	<Section
		title={'Instant for most edits'}
		body={'Most keystrokes update the page immediately. For a change too big to update safely, such as one that reflows later pages, Texpile dims the old page for a moment rather than show something that might be wrong, then swaps in the freshly compiled one.'}
	/>
	<Section title={'What renders'} body={'Live preview covers the constructs a paper actually uses, not just body text.'}>
		<Bullets items={renders} />
	</Section>
	<Section title={'Languages and fonts'} body={'Live preview is not limited to Latin scripts.'}>
		<Bullets items={languages} />
	</Section>
	<Section
		title={'When the compile fails'}
		body={'A failed compile is reported in the Problems panel rather than leaving a stale page with no explanation.'}
	>
		<Note body={'Live preview needs a TeX distribution installed. Editing works without one.'} />
	</Section>
</div>
