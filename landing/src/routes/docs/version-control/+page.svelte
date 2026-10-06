<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Note from '$lib/docs/Note.svelte';
	import Where from '$lib/docs/Where.svelte';
	import panelShot from '$lib/assets/showcase/app/source-control-panel.png';
	import diffShot from '$lib/assets/showcase/diff-dark.png';

	const where = [{ label: 'Panel', value: 'Source Control', note: 'The branch icon in the sidebar header.' }];
</script>

<DocsHead
	title={'Version control'}
	description={'Texpile has git built in: see what changed, stage and commit files, discard changes, and diff side by side against the last commit.'}
	path="/docs/version-control"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Version control'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{"Texpile has git built in, so keeping a paper's history does not mean leaving the editor for a terminal."}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<Figure
	src={panelShot}
	alt={'The Source Control panel: seven staged changes and a commit message box'}
	caption={'The Source Control panel: seven staged changes and a commit message box'}
	narrow
/>

<div class="space-y-10">
	<Section
		title={'See what changed'}
		body={'The source control panel lists the files that differ from your last commit, updating as you work.'}
	/>
	<Section
		title={'Stage and commit'}
		body={'Stage or unstage individual files, discard changes you do not want to keep, and commit with a message. If the folder is not a repository yet, Texpile can initialise one for you.'}
	/>
	<Section title={'Diff'} body={'Compare any changed file side by side against the last commit, in the same window as the editor.'}>
		<Figure src={diffShot} alt={'A file diffed side by side against the last commit'} />
		<Note
			body={'This covers the everyday loop rather than all of git. For branches, remotes, and history rewriting, the built-in terminal is one panel away.'}
		/>
	</Section>
</div>
