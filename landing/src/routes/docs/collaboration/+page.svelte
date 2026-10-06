<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Note from '$lib/docs/Note.svelte';
	import Where from '$lib/docs/Where.svelte';
	import shot from '$lib/assets/showcase/editor-collab.webp';

	// the menu still says "Shared session"; the docs call the feature real-time collaboration.
	// hosting and joining are reached from different places, so both are listed.
	const where = [
		{ label: 'Menu', value: 'File › Shared session', note: 'Share a folder of your own.' },
		{ label: 'Start screen', value: 'Join session', note: "Join someone else's." }
	];
</script>

<DocsHead
	title={'Real-time collaboration'}
	description={'Real-time collaboration in Texpile: share a folder and edit it with others live. Guests join with a code, no account needed, end to end encrypted.'}
	path="/docs/collaboration"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Real-time collaboration'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'A shared session lets several people edit the same folder at once, in either the visual or the source editor.'}
	</p>
</header>

<div class="mt-6 space-y-4">
	<Where rows={where} />
	<Note
		body={'Real-time collaboration is experimental. Everything else in Texpile works fully offline; this is the one feature that uses the network.'}
	/>
</div>

<Figure
	src={shot}
	alt={"Two people editing the same document, with each other's cursors visible"}
	caption={"Two people editing the same document, with each other's cursors visible"}
/>

<div class="space-y-10">
	<Section
		title={'Joining'}
		body={'The host shares a folder from File › Shared session and gets a code. Everyone else picks Join session on the start screen and enters it. There is no account and no sign-up on either side, and a guest does not need the folder, a TeX distribution, or even a project of their own.'}
	/>
	<Section
		title={'Encryption'}
		body={'Sessions are end to end encrypted. The relay server forwards data it cannot read, so the content of your document is never available to it.'}
	/>
	<Section
		title={'What guests see'}
		body={'Guests co-edit in both the visual and source editors and see where everyone else is working, cursors and selections included.'}
	/>
	<Section
		title={'Who compiles'}
		body={'The host runs the compile with their own toolchain. Guests watch the resulting PDF and the compile problems update live, without needing a TeX distribution themselves.'}
	/>
	<Section
		title={'What a guest cannot do'}
		body={"Actions that belong to the host's machine, such as starting a compile or changing the compile command, are left out of a guest's menus rather than failing when used."}
	/>
</div>
