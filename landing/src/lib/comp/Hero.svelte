<script lang="ts">
	import { Download, Github } from '@lucide/svelte';
	import ShowcaseToggle from './ShowcaseToggle.svelte';
	import { m } from '$lib/paraglide/messages';
	import { PROJECT_REPOSITORY_URL } from '$lib/site-origin';

	const downloadLabel = m.dl_download_for({ name: m.word_windows() });

	// split on * so translators can move the accent word instead of us splitting the sentence into keys
	const headingParts = m.hero_heading().split('*');
</script>

<section id="top" class="bg-primary-50 overflow-hidden">
	<div class="container mx-auto px-4 pt-20 pb-14 sm:px-6 md:pt-28 lg:px-8">
		<div class="mx-auto max-w-4xl space-y-7 text-center">
			<h1 class="text-surface-950 text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl lg:text-6xl">
				{#each headingParts as part, i (i)}{#if i % 2}<span class="text-primary-600">{part}</span>{:else}{part}{/if}{/each}
			</h1>

			<p class="text-surface-800 mx-auto max-w-3xl text-lg leading-relaxed">
				{m.hero_body()}
			</p>

			<div class="flex flex-col items-center gap-4">
				<div class="flex flex-wrap items-center justify-center gap-3">
					<a
						href="/download"
						class="btn preset-filled-primary-500 rounded-base inline-flex items-center gap-2 px-7 py-3 font-semibold text-white"
					>
						<Download class="h-5 w-5" />
						{downloadLabel}
					</a>
					<a
						href={PROJECT_REPOSITORY_URL}
						target="_blank"
						rel="noopener noreferrer"
						class="rounded-base border-surface-300 text-surface-900 hover:bg-surface-100 inline-flex items-center gap-2 border bg-white px-7 py-3 font-semibold transition-colors"
					>
						<Github class="h-5 w-5" />
						{m.hero_cta_github()}
					</a>
				</div>
				<p class="text-surface-800 font-mono text-xs">{m.hero_tagline()}</p>
			</div>
		</div>
	</div>

	<div class="pb-20 md:pb-24">
		<ShowcaseToggle />
	</div>
</section>
