<script lang="ts">
	import SiteMetadata from '$lib/comp/SiteMetadata.svelte';
	import { m } from '$lib/paraglide/messages';
</script>

<svelte:head>
	<title>{m.dl_title()}</title>
	<meta name="description" content={m.dl_meta_description()} />
	<meta name="keywords" content={m.dl_meta_keywords()} />
</svelte:head>

<SiteMetadata path="/download" title={m.dl_title()} description={m.dl_meta_description()} includeLanguageAlternates />

<section class="bg-surface-50 border-surface-200 border-b">
	<div class="container mx-auto max-w-3xl px-4 py-14 text-center sm:px-6 md:py-16 lg:px-8">
		<h1 class="text-2xl font-bold sm:text-3xl md:text-4xl">{m.dl_heading()}</h1>
		<p class="text-surface-600 mx-auto mt-4 max-w-xl">{m.dl_subheading()}</p>
	</div>
</section>
