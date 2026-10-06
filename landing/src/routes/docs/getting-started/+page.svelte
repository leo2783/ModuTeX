<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Note from '$lib/docs/Note.svelte';
	import Where from '$lib/docs/Where.svelte';
	// the start screen, not the editor: this is what actually greets a first launch
	import shot from '$lib/assets/showcase/app/start-screen.png';
	import mainFileShot from '$lib/assets/showcase/app/set-main-file-menu.png';

	const where = [
		{ label: 'Start screen', value: 'Open Folder…' },
		{ label: 'Menu', value: 'File › Open folder', note: 'Once you are already in a folder.' },
		{ label: 'In the editor', value: 'Right-click a file › Set as main file', note: 'In the file explorer.' },
		{
			label: 'Setting',
			value: 'Preferences › Autosave',
			note: 'Preferences opens from the start screen, and from File › Preferences… once a folder is open.'
		}
	];
</script>

<DocsHead
	title={'Getting started'}
	description={'Open a folder in Texpile, set the main file, switch between the visual and source editors, and produce a PDF.'}
	path="/docs/getting-started"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Getting started'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Point Texpile at the directory your .tex files already live in, and it scans for them.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<Figure
	src={shot}
	alt={'The start screen: Open Folder, Join session, New Window, and Preferences'}
	caption={'The start screen: Open Folder, Join session, New Window, and Preferences'}
/>

<div class="space-y-10">
	<Section
		title={'Open a folder'}
		body={'There is no import step and no project format. Texpile opens on a start screen rather than an empty editor: choose Open Folder… and the file explorer fills with the .tex, .bib, and image files it finds. Folders you have opened before are listed under Recent, and your last folder reopens the next time you launch, on the file you left open.'}
	>
		<Note
			body={'New to Texpile? The start screen has a "New here? Try the tutorial" link that builds a small worked example in a folder you pick, so you have something real to edit.'}
		/>
	</Section>
	<Section
		title={'The main file'}
		body={'A multi-file paper has one main .tex holding the preamble and `\\begin{document}`. Texpile picks it automatically, by conventional name or by looking for `\\begin{document}`. Right-click any file in the explorer to set it yourself. The main file is badged with a star and remembered per folder.'}
	>
		<Figure src={mainFileShot} alt={'Right-clicking a file to set it as the main file, with the current main file starred'} narrow />
	</Section>
	<Section
		title={'Two views of one file'}
		body={'Every file opens in either the visual editor or the source editor, and switching between them keeps your scroll position, cursor, and undo history.'}
	>
		<div class="flex flex-wrap gap-x-6 gap-y-2">
			<a
				href="/docs/visual-editing"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'Visual editing'}
				<ArrowRight class="h-4 w-4" />
			</a>
			<a
				href="/docs/source-editing"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'Source editing'}
				<ArrowRight class="h-4 w-4" />
			</a>
		</div>
	</Section>
	<Section
		title={'Autosave'}
		body={'Autosave is on by default. Turn it off in Preferences and Texpile saves only when you press Ctrl+S, warning you before you switch files.'}
	>
		<Note
			body={'Live preview and hosting a shared session both depend on the file on disk being current, so autosave stays on while either is active.'}
		/>
	</Section>
	<Section
		title={'Producing a PDF'}
		body={'Press Preview (or Compile, in source mode) and Texpile runs a sensible default command for you: latexmk with lualatex. It just needs a TeX distribution installed on your machine.'}
	>
		<div class="flex flex-wrap gap-x-6 gap-y-2">
			<a
				href="/docs/installation"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'Installing TeX Live, MacTeX, or MiKTeX'}
				<ArrowRight class="h-4 w-4" />
			</a>
			<a
				href="/docs/compiling"
				class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
			>
				{'Compiling, live preview, and the Problems panel, in full'}
				<ArrowRight class="h-4 w-4" />
			</a>
		</div>
	</Section>
</div>
