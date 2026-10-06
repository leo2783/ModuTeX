<script lang="ts">
	import SiteMetadata from '$lib/comp/SiteMetadata.svelte';
	// The docs are English only, written as plain strings rather than through Paraglide: the
	// screenshots are English-locked anyway, so translating the prose around them buys nothing.
	// The localized routes still exist so the nav can never 404, but they serve this same prose.
	// Hence a canonical pointing at the English URL and NO hreflang alternates, unlike the other
	// pages, which carry them because they are genuinely translated.
	let { title, description, path }: { title: string; description: string; path: string } = $props();

	const fullTitle = $derived(`${title} - ModuTeX docs`);
</script>

<svelte:head>
	<title>{fullTitle}</title>
	<meta name="description" content={description} />
</svelte:head>

<SiteMetadata {path} title={fullTitle} {description} localeIndependent />
