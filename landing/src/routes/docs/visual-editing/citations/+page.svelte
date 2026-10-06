<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Where from '$lib/docs/Where.svelte';
	import pickerShot from '$lib/assets/showcase/app/citation-ref-picker.png';
	import bibShot from '$lib/assets/showcase/editor-references.webp';

	const where = [
		{ label: 'In the editor', value: 'Type @, then search', note: 'Matches by citation key, author, title, or year.' },
		{
			label: 'Menu',
			value: 'Insert › Citation',
			note: 'Inserts your first bibliography entry directly, useful as a placeholder to configure, not a picker.'
		}
	];
</script>

<DocsHead
	title={'Citations'}
	description={"Insert and edit citations in Texpile's visual editor: the @ picker, page numbers, prefixes, citation style, and managing your .bib files."}
	path="/docs/visual-editing/citations"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Citations'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Citations and cross-references share one picker, so you never have to remember which symbol means which.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<div class="mt-10 space-y-10">
	<Section
		title={'One picker, two sources'}
		body={"The @ picker searches your bibliography and, in the same list, your document's own numbered figures, tables, and equations, so `\\cite` and `\\ref` both start the same way."}
	>
		<Figure src={pickerShot} alt={'Typing @ to search: bibliography entries above, numbered equations below, in one list'} narrow />
	</Section>
	<Section
		title={'Editing a citation'}
		body={'Click an inserted citation to open its editor: a Page numbers field for a pinpoint reference, and under Advanced options, Add prefix (with see / cf. / compare as one-click fills) and a Citation style picker with Automatic, Parenthetical, In-text, or Basic.'}
	/>
	<Section
		title={'Managing your bibliography'}
		body={'The @ picker reads whichever .bib files are in your project. Open the .bib file itself to edit it as a form rather than as source: add references, fill the required fields for each entry type, and paste raw BibTeX to import. Entries the parser cannot model stay editable as raw text.'}
	>
		<Figure src={bibShot} alt={'The reference manager editing a .bib entry as a form'} />
	</Section>
</div>
