<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Where from '$lib/docs/Where.svelte';

	const where = [
		{ label: 'Setting', value: 'Preferences › Spell check', note: 'Off by default.' },
		{ label: 'Menu', value: 'Spelling › Check spelling & grammar', note: 'The same toggle, checked when on.' },
		{ label: 'Menu', value: 'Spelling › Edit dictionary…', note: 'Add or remove your own words.' }
	];
</script>

<DocsHead
	title={'Spell check'}
	description={'Enable spell check and grammar checking in Texpile: where the toggle lives, what it checks, and how to add your own words to the dictionary.'}
	path="/docs/spell-check"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Spell check'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Spell check currently only supports English.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<div class="mt-10 space-y-10">
	<Section
		title={'Turning it on'}
		body={'Spell check starts off. Switch it on from Preferences, or from the Spelling menu, and it applies immediately in both the visual and source editors.'}
	/>
	<Section
		title={'Adding your own words'}
		body={'Click a flagged word for suggestions and an Add to Dictionary button, or manage the whole list from Spelling › Edit dictionary…. Added words apply across every project you open, not just the current one.'}
	/>
</div>
