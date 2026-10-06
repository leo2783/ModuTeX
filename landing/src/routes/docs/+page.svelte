<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import { TOPICS, hrefFor } from '$lib/docs/nav';
	import { m } from '$lib/paraglide/messages';
</script>

<DocsHead
	title={'Documentation'}
	description={'How the Texpile editor works, feature by feature: live preview, visual and source editing, intellisense, compiling, projects, git, real-time collaboration, and MCP.'}
	path="/docs"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'Documentation'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'How Texpile works, feature by feature. Everything described here runs on your own machine, against the .tex files already in your folder.'}
	</p>
</header>

<div class="mt-10 grid gap-4 sm:grid-cols-2">
	{#each TOPICS as topic (topic.slug)}
		{@const Icon = topic.icon}
		<a
			href={hrefFor(topic.slug)}
			class="border-surface-200 hover:border-primary-400 group flex flex-col rounded-lg border p-5 transition-colors"
		>
			<span class="bg-primary-500/10 text-primary-600 mb-3 flex h-9 w-9 items-center justify-center rounded-md">
				<Icon class="h-4.5 w-4.5" />
			</span>
			<span class="text-surface-900 group-hover:text-primary-600 font-semibold">{topic.title}</span>
			<span class="text-surface-600 mt-1.5 text-sm leading-relaxed">{topic.blurb}</span>
		</a>
	{/each}
</div>

<div class="border-surface-200 mt-12 rounded-lg border p-6 text-center">
	<p class="text-surface-600">{'ModuTeX is free and open source, for Windows x64.'}</p>
	<a
		href="/download"
		class="btn preset-filled-primary-500 rounded-base mt-4 inline-flex items-center gap-2 px-6 py-2.5 font-semibold text-white"
	>
		{m.word_download()}
		<ArrowRight class="h-4 w-4" />
	</a>
</div>
