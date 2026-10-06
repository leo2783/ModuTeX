<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Note from '$lib/docs/Note.svelte';
	import compileModalShot from '$lib/assets/showcase/app/compile-command-modal.png';
	import advancedPathsShot from '$lib/assets/showcase/app/compile-advanced-output-paths.png';
	import problemsShot from '$lib/assets/showcase/app/problems-panel.png';
	import syncIconShot from '$lib/assets/showcase/app/sync-to-pdf-icon.png';
	import Where from '$lib/docs/Where.svelte';

	let { data }: { data: { commandHtml: string } } = $props();

	const where = [
		{ label: 'Menu', value: 'Terminal › Compile' },
		{ label: 'Menu', value: 'Terminal › Configure compile command…', note: 'Set the command, the engine, and live mode.' },
		{ label: 'Menu', value: 'Terminal › New terminal', note: 'Opens another shell alongside the running one.' },
		{ label: 'Shortcut', value: 'Ctrl+Alt+Enter', note: 'Start or stop a compile.' },
		{ label: 'Panel', value: 'Problems', note: 'In the dock at the bottom of the window.' }
	];
</script>

<DocsHead
	title={'Compiling'}
	description={'Texpile runs your own compile command in a built-in terminal, parses the compile and bibliography logs into a Problems panel, and supports SyncTeX both ways.'}
	path="/docs/compiling"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Compiling'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Texpile does not ship a TeX distribution and does not compile in the cloud. It runs the compile command you choose, on your machine, and shows you what came back.'}
	</p>
</header>

<div class="mt-6 space-y-4">
	<Where rows={where} />
	<Note body={'You need a TeX distribution installed: TeX Live, MiKTeX, or MacTeX. Editing works without one; compiling does not.'} />
</div>

<div class="mt-10 space-y-10">
	<Section
		title={'Setting the command'}
		body={'Terminal › Configure compile command… sets what runs. Any shell command works, `{main}` expands to your main file, and the command is remembered per folder.'}
	>
		{@html data.commandHtml}
	</Section>

	<Section
		title={'Using the default'}
		body={'Texpile fills in a sensible default the first time. If you have changed it and want it back, the same dialog has a Use default button.'}
	>
		<Figure src={compileModalShot} alt={'The compile command dialog: engine picker, the shell command, and the Live mode toggle'} narrow />
	</Section>

	<Section title={'Live mode'} body={'The Live mode switch, in the same dialog, is what makes the page update as you type.'}>
		<a
			href="/docs/live-preview"
			class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
		>
			{'Live preview, in full'}
			<ArrowRight class="h-4 w-4" />
		</a>
	</Section>

	<Section
		title={'Advanced: output paths'}
		body={'Texpile detects the compiled PDF and log file from your command automatically, and in very rare cases you need to override that: a custom `-jobname`, or an unusual output layout. Both paths are relative to the folder root, and SyncTeX follows whichever PDF you point it at.'}
	>
		<Figure src={advancedPathsShot} alt={'Advanced output paths: overriding the detected PDF and log file locations'} narrow />
	</Section>

	<Section
		title={'Built-in terminal'}
		body={'Terminal › New terminal opens another shell alongside whatever is already running. Compiles always run in a terminal named Compile, which Texpile creates the first time you compile if one does not already exist.'}
	/>

	<Section
		title={'Problems panel'}
		body={'Texpile reads the compile log and the bibliography log and lists errors and warnings with plain-language explanations. Click a problem to jump to its line; a bibliography warning jumps to the entry in the .bib file. Even a large log does not stall the app. Toggle the panel from the Problems tab in the terminal dock, or the warning or error badge beside the Visual / Source toggle in the top right corner.'}
	>
		<Figure src={problemsShot} alt={'The Problems panel listing a compile error and warnings'} />
	</Section>

	<Section
		title={'SyncTeX'}
		body={'SyncTeX only works in the source editor. To jump from source to PDF, right-click a line and choose Show in PDF, or click the crosshair icon that appears beside the Compile button while you are in Source mode. To jump from PDF back to source, double-click the text in the PDF.'}
	>
		<Figure src={syncIconShot} alt={'The sync-to-PDF crosshair icon, next to the Compile button in Source mode'} narrow />
	</Section>

	<Section
		title={'PDF preview'}
		body={'The compiled PDF sits next to the editor. Preferences has a dark-page option for reading at night without inverting the whole document.'}
	/>
</div>
