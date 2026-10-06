<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import KeyTable from '$lib/docs/KeyTable.svelte';
	import Where from '$lib/docs/Where.svelte';
	import shot from '$lib/assets/showcase/editor-source.webp';
	import toggleShot from '$lib/assets/showcase/app/visual-source-toggle.png';
	import tableGridShot from '$lib/assets/showcase/app/table-grid-picker.png';
	import mathPaletteShot from '$lib/assets/showcase/app/math-palette.png';

	const where = [
		{ label: 'In the editor', value: 'The Visual / Source toggle', note: 'Top right corner of the editor.' },
		{ label: 'Setting', value: 'File › Preferences… › Keybindings', note: 'Default, Vim, or Emacs.' }
	];

	const keys = [
		{ keys: 'Ctrl Alt ↑ / ↓', label: 'Add a cursor above or below' },
		{ keys: 'Ctrl D', label: 'Select the next occurrence' },
		{ keys: 'Ctrl Space', label: 'Open suggestions' },
		{ keys: 'F12', label: 'Go to definition (or Ctrl+Click)' },
		{ keys: 'Esc', label: 'Hide the math preview' }
	];
</script>

<DocsHead
	title={'Source editing'}
	description={"Texpile's source editor offers LaTeX syntax highlighting, Vim and Emacs keymaps, multiple cursors, inline math preview, and go-to-definition across files."}
	path="/docs/source-editing"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Source editing'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'The source editor is a full LaTeX code editor with syntax highlighting, showing the same document as the visual editor.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<Figure src={toggleShot} alt={'The Visual / Source toggle in the top right corner, with a compile-warning badge beside it'} narrow />

<Figure
	src={shot}
	alt={'A .tex file open in the source editor with syntax highlighting'}
	caption={'A .tex file open in the source editor with syntax highlighting'}
/>

<div class="space-y-10">
	<Section
		title={'Keymaps'}
		body={'Choose default, Vim, or Emacs keybindings in Preferences. The choice applies to the source editor only.'}
	/>
	<Section
		title={'Multiple cursors'}
		body={'Ctrl+Alt+Up and Ctrl+Alt+Down add a cursor above or below. Ctrl+D selects the next occurrence of the current selection, so repeated edits can be made in one pass.'}
	/>
	<Section
		title={'Inline math preview'}
		body={'Equations preview as you write them, rendered with your own macros so a formula built from your definitions still shows correctly. Click away or press Esc to dismiss it, and turn it off entirely from Preferences › Math preview.'}
	/>
	<Section
		title={'Navigation'}
		body={'F12, or Ctrl+Click, goes to where a macro, label, or citation is defined, including across files in a multi-file project. Hovering shows the same information without leaving the line.'}
	/>
	<Section title={'Spell check'} body={'Runs locally and checks prose only: your commands, math, and comments are skipped.'}>
		<a
			href="/docs/spell-check"
			class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors"
		>
			{'Turning it on, and adding your own words'}
			<ArrowRight class="h-4 w-4" />
		</a>
	</Section>
	<Section title={'Shortcuts'} body={'The source-specific keys, on top of the ones shared with the rest of the app.'}>
		<KeyTable rows={keys} />
	</Section>
	<Section
		title={'Toolbar'}
		body={"The same formatting commands as buttons, for the chords you don't have memorized. It also inserts a table by size, and math symbols by category (Greek, calculus, relations, sets, matrices), the same way the visual editor's toolbar does."}
	>
		<div class="grid gap-6 sm:grid-cols-2">
			<Figure src={tableGridShot} alt={"The source editor's table-insert grid, with caption, rules, and header-row toggles"} />
			<Figure src={mathPaletteShot} alt={"The source editor's math symbol dropdown, open on the Common tab"} />
		</div>
	</Section>
</div>
