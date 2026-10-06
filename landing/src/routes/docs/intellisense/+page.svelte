<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Bullets from '$lib/docs/Bullets.svelte';
	import Where from '$lib/docs/Where.svelte';
	// intellisense-dark, not intellisense.webp: the webp is 579px (blurry at this column width) and
	// shows \begin completion, while the alt text and this page are about citation completion
	import shot from '$lib/assets/showcase/intellisense-dark.png';

	const where = [
		{ label: 'In the editor', value: 'Always on in the source editor', note: 'Suggestions appear as you type.' },
		{ label: 'Shortcut', value: 'Ctrl+Space', note: 'Open suggestions.' },
		{ label: 'Shortcut', value: 'F12, or Ctrl+Click', note: 'Go to a definition.' }
	];

	const completes = [
		'Commands and environments, including your own `\\newcommand` and `\\NewDocumentCommand` definitions.',
		"Package and class names, with each package's options and key-values.",
		'`\\ref` labels, shown with the number they will resolve to.',
		'`\\cite` keys, searchable by title and author, plus glossary entries.',
		'File paths inside `\\input`, `\\includegraphics`, and `\\addbibresource`.'
	];
</script>

<DocsHead
	title={'Intellisense'}
	description={'Texpile completes commands, packages, labels, citation keys, and file paths from across your whole LaTeX project, with go-to-definition and hover.'}
	path="/docs/intellisense"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Intellisense'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Completion, definitions, and hover draw on your whole project, not just the file you have open.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<Figure
	src={shot}
	alt={'The source editor completing a citation with bibliography keys and titles'}
	caption={'The source editor completing a citation with bibliography keys and titles'}
/>

<div class="space-y-10">
	<Section title={'What completes'} body={'Completion covers both what LaTeX ships with and what your project defines.'}>
		<Bullets items={completes} />
	</Section>
	<Section
		title={'Across the whole project'}
		body={"Macros are gathered from the main file's chain of `\\input` and `\\usepackage`, so a chapter fragment is understood with the same definitions the main file has. Labels and citation keys come from every file in the folder."}
	/>
	<Section
		title={'Definitions and hover'}
		body={'Go-to-definition and hover work across files, so following a macro to where it is defined does not depend on it being in the file you are looking at.'}
	/>
	<Section
		title={'Arguments and renames'}
		body={'Accepting a macro that takes an argument reopens the suggestions for that argument. Renaming or moving a file updates the references pointing at it.'}
	/>
</div>
