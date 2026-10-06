<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import KeyTable from '$lib/docs/KeyTable.svelte';
	import Note from '$lib/docs/Note.svelte';
	import Where from '$lib/docs/Where.svelte';
	import { TOPICS } from '$lib/docs/nav';
	import typingWebm from '$lib/assets/showcase/visual-typing.webm';
	import typingMp4 from '$lib/assets/showcase/visual-typing.mp4';
	// the Visual side highlighted, not the shared Source-highlighted shot used on the source-editing
	// page: this page is about the visual editor, so the toggle should show it selected
	import toggleShot from '$lib/assets/showcase/app/visual-source-toggle-visual.png';

	// child pages are the source of truth for this grid (nav.ts), so it can't drift from the sidebar
	const blocks = TOPICS.find((t) => t.slug === 'visual-editing')?.children ?? [];

	const where = [
		{ label: 'In the editor', value: 'The Visual / Source toggle', note: 'Top right corner of the editor.' },
		{ label: 'Shortcut', value: 'Ctrl+K', note: 'Then "Switch to the visual editor".' }
	];

	// mirrors the app's own shortcuts window (Edit > Keyboard shortcuts)
	const keys = [
		{ keys: 'Ctrl B', label: 'Bold' },
		{ keys: 'Ctrl I', label: 'Italic' },
		{ keys: 'Ctrl U', label: 'Underline' },
		{ keys: 'Ctrl `', label: 'Inline code' },
		{ keys: 'Ctrl .', label: 'Superscript' },
		{ keys: 'Ctrl ,', label: 'Subscript' },
		{ keys: 'Ctrl Shift 1…3', label: 'Heading levels 1 to 3' },
		{ keys: 'Ctrl M', label: 'Inline math' },
		{ keys: 'Ctrl Shift M', label: 'Display math' }
	];
</script>

<DocsHead
	title={'Visual editing'}
	description={"Texpile's visual editor renders your .tex as formatted text, math, and tables, preserving every construct it does not model as raw LaTeX."}
	path="/docs/visual-editing"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Visual editing'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'The visual editor parses your .tex and shows formatted text, math, figures, and tables. It is not a different format: it is your file, rendered.'}
	</p>
</header>

<div class="mt-6 space-y-4">
	<Note
		body={'It is WYSIWYM, not WYSIWYG: what you see is what you mean, not a pixel preview of the compiled page. A heading looks like a heading and a numbered equation looks numbered, but the exact fonts, spacing, and layout come from your LaTeX engine and preamble, not the editor. For that, see Live preview.'}
	/>
	<Where rows={where} />
</div>

<Figure src={toggleShot} alt={'The Visual / Source toggle, Visual selected, in the top right corner of the editor'} narrow />

<Figure
	webm={typingWebm}
	mp4={typingMp4}
	alt={'Typing in the visual editor, with math and formatting applied live'}
	caption={'Typing in the visual editor, with math and formatting applied live'}
/>

<div class="space-y-10">
	<Section
		title={'What can be visually edited'}
		body={"Texpile's visual editor is currently optimized for normal articles and similar documents, including research papers, essays, and reports. Although Texpile will try its best to render everything visually, some uncommon macros cannot be rendered. Those are left as raw LaTeX code, shown as a chip in the editor."}
	/>
	<Section
		title={'Cross-references'}
		body={'Type @ to reference any equation, figure, table, or citation in the project. Equations render inline and keep their numbering, so a reference reads as the number it will print as.'}
	/>
	<Section
		title={'Tables'}
		body={'Insert a table by size from the toolbar, then click into any cell to edit it. Select two or more cells and right-click to merge them into a multirow or multicolumn span.'}
	>
		<a
			href="/docs/visual-editing/tables"
			class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
		>
			{'Numbering, merging, and the settings panel, in full'}
			<ArrowRight class="h-4 w-4" />
		</a>
	</Section>
	<Section title={'Spell check'} body={'Runs locally and checks prose only: your commands, math, and comments are skipped.'}>
		<a
			href="/docs/spell-check"
			class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
		>
			{'Turning it on, and adding your own words'}
			<ArrowRight class="h-4 w-4" />
		</a>
	</Section>
	<Section title={'Formatting shortcuts'} body={'The usual editing keys apply, and each one maps to the LaTeX you would have typed.'}>
		<KeyTable rows={keys} />
	</Section>

	<Section
		title={'Visual editor features'}
		body={'Five parts of the visual editor go deep enough for their own page: equation numbering and per-line labels, resizing and captioning images, merging table cells from a settings panel, the shared @ picker for citations and cross-references, and selecting a whole block, then its parent, from the toolbar.'}
	>
		<div class="grid gap-4 sm:grid-cols-2">
			{#each blocks as block (block.slug)}
				{@const Icon = block.icon}
				<a
					href="/docs/visual-editing/{block.slug}"
					class="border-surface-200 hover:border-primary-400 group flex items-start gap-3 rounded-lg border p-4 transition-colors"
				>
					<span class="bg-primary-500/10 text-primary-600 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
						<Icon class="h-4 w-4" />
					</span>
					<span class="min-w-0">
						<span class="text-surface-900 group-hover:text-primary-600 block font-semibold">{block.title}</span>
						<span class="text-surface-600 mt-0.5 block text-sm leading-relaxed">{block.blurb}</span>
					</span>
				</a>
			{/each}
		</div>
	</Section>
</div>
