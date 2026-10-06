<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import KeyTable from '$lib/docs/KeyTable.svelte';
	import Bullets from '$lib/docs/Bullets.svelte';
	import Where from '$lib/docs/Where.svelte';
	import thumbTree from '$lib/assets/showcase/thumbs/thumb-tree.png';
	import paletteShot from '$lib/assets/showcase/app/command-palette.png';

	const explorerPoints = [
		"Drag files and folders in from your system's file manager to import them.",
		'Ctrl+V pastes: a screenshot on your clipboard becomes a new image file, and copied files are copied in.',
		'Drag and drop within the tree to move files between folders.'
	];

	const where = [
		{ label: 'Panel', value: 'The sidebar', note: 'The file explorer, with Contents below it.' },
		{ label: 'Shortcut', value: 'Ctrl+Shift+F', note: 'Find in files.' },
		{ label: 'Shortcut', value: 'Ctrl+K', note: 'The command palette: open a file or run an action.' },
		{ label: 'Menu', value: 'File › New Window', note: 'Also File › Open folder in new window.' }
	];

	const keys = [
		{ keys: 'Ctrl F', label: 'Find in this document' },
		{ keys: 'Ctrl Shift F', label: 'Find in every file in the folder' },
		{ keys: 'Ctrl K', label: 'Command palette' },
		{ keys: 'Ctrl Shift N', label: 'New window' }
	];
</script>

<DocsHead
	title={'Projects and files'}
	description={'Texpile treats the folder as the project: a file explorer with drag and drop, tabs, multi-file document support, find in files, and a table of contents.'}
	path="/docs/projects"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Projects and files'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'A paper is usually more than one file. Texpile treats the folder as the project, with no separate project file to keep in sync.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<Figure
	src={thumbTree}
	alt={'The file explorer showing a multi-file paper'}
	caption={'The file explorer showing a multi-file paper'}
	narrow
/>

<div class="space-y-10">
	<Section
		title={'File explorer'}
		body={'Every file in the folder, with multi-select using Ctrl and Shift and drag and drop within the tree.'}
	>
		<Bullets items={explorerPoints} />
	</Section>
	<Section title={'Tabs'} body={'Open files appear as tabs above the editor, and your open tabs come back when you reopen the folder.'} />
	<Section
		title={'Multi-file documents'}
		body={"Fragments pulled in with `\\input` parse using the main file's macros and packages, so a chapter file is understood the way the main file would understand it rather than as an orphan."}
	/>
	<Section
		title={'Table of contents'}
		body={'A contents panel lists your headings, figures, tables, and beamer frames. Click an entry to jump to it.'}
	/>
	<Section title={'Word count'} body={'Words and characters for the whole document, or for the current selection.'} />
	<Section
		title={'Getting around'}
		body={'The command palette opens files and runs editor actions without leaving the keyboard. You can also work in several windows at once, and relaunching reopens each on its last open file.'}
	>
		<Figure src={paletteShot} alt={'The command palette open on Ctrl+K, listing compile, view, and editor actions'} narrow />
		<KeyTable rows={keys} />
	</Section>
</div>
