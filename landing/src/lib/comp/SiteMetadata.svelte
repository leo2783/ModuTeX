<script lang="ts">
	import { getLocale } from '$lib/paraglide/runtime';
	import { getSiteLanguageAlternates, getSiteUrl, type SiteLocale } from '$lib/site-origin';

	interface Props {
		path: string;
		title: string;
		description: string;
		localeIndependent?: boolean;
		includeLanguageAlternates?: boolean;
	}

	let { path, title, description, localeIndependent = false, includeLanguageAlternates = false }: Props = $props();

	const currentLocale = $derived((localeIndependent ? 'en' : getLocale()) as SiteLocale);
	const pageUrl = $derived(getSiteUrl(path, currentLocale));
	const alternates = $derived(includeLanguageAlternates ? getSiteLanguageAlternates(path) : []);
</script>

<svelte:head>
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="twitter:title" content={title} />
	<meta property="twitter:description" content={description} />
	{#if pageUrl}
		<meta property="og:url" content={pageUrl} />
		<meta property="twitter:url" content={pageUrl} />
		<link rel="canonical" href={pageUrl} />
	{/if}
	{#each alternates as alternate (alternate.hreflang)}
		<link rel="alternate" hreflang={alternate.hreflang} href={alternate.href} />
	{/each}
</svelte:head>
