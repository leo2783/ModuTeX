<script lang="ts">
	import { CircleHelp, Github, Globe, Check } from '@lucide/svelte';
	import LogoDark from '$lib/assets/Logo-dark.svg';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Menu, Portal } from '@skeletonlabs/skeleton-svelte';
	import { locales, localizeHref, getLocale, type Locale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import { LOCALE_META } from '$lib/localeMeta';
	import { PROJECT_ISSUES_URL, PROJECT_REPOSITORY_URL } from '$lib/site-origin';

	// absolute hrefs so they resolve from any route, not just the home page
	const navLinks = [
		{ href: '/#features', label: m.nav_features() },
		{ href: '/docs', label: m.nav_docs() },
		{ href: '/download', label: m.nav_download() },
		{ href: '/#faq', label: m.nav_faq() }
	];

	const currentLocale = getLocale();

	// full document navigation (not client-side routing), same as every other locale switch on this site.
	// details.value is always one of `locales` (that's all the menu ever renders), hence the cast.
	function onLocaleSelect(details: { value: string }) {
		const href = localizeHref(page.url.pathname, { locale: details.value as Locale });
		window.location.href = href;
	}

	let atTop = $state(true);
	onMount(() => {
		const onScroll = () => (atTop = window.scrollY < 30);
		window.addEventListener('scroll', onScroll);
		onScroll();
		return () => window.removeEventListener('scroll', onScroll);
	});
</script>

<header
	class="sticky top-0 z-50 border-b backdrop-blur-sm transition-colors duration-200 {atTop
		? 'border-transparent bg-transparent'
		: 'border-surface-200 bg-surface-50/95'}"
>
	<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<nav class="relative flex h-16 items-center justify-between">
			<a href="/" class="flex items-center">
				<img src={LogoDark} alt={m.nav_logo_alt()} class="h-8" />
			</a>

			<div class="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">
				{#each navLinks as link (link.href)}
					<a href={link.href} class="text-surface-700 hover:text-primary-600 font-medium transition-colors">
						{link.label}
					</a>
				{/each}
			</div>

			<div class="flex items-center gap-4">
				<Menu onSelect={onLocaleSelect} positioning={{ placement: 'bottom-end' }}>
					<Menu.Trigger
						class="text-surface-600 hover:text-surface-950 flex items-center gap-1.5 text-sm font-medium transition-colors"
						aria-label={m.nav_languages_aria()}
					>
						<Globe class="h-4 w-4" />
						{LOCALE_META[currentLocale]?.short ?? currentLocale}
					</Menu.Trigger>
					<Portal>
						<Menu.Positioner>
							<Menu.Content class="border-surface-200 z-50 min-w-48 rounded-lg border bg-white p-1 shadow-lg outline-none">
								{#each locales as locale (locale)}
									<Menu.Item
										value={locale}
										class="rounded-base hover:bg-surface-100 data-[highlighted]:bg-surface-100 flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-medium"
									>
										<Menu.ItemText>
											{LOCALE_META[locale]?.label ?? locale}
											{#if LOCALE_META[locale]?.machineTranslated}
												<span class="text-surface-400 font-normal">{m.nav_machine_translated_tag({}, { locale })}</span>
											{/if}
										</Menu.ItemText>
										{#if locale === currentLocale}
											<Check class="text-primary-600 h-4 w-4 shrink-0" />
										{/if}
									</Menu.Item>
								{/each}
							</Menu.Content>
						</Menu.Positioner>
					</Portal>
				</Menu>
				<a
					href={PROJECT_ISSUES_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="text-surface-600 hover:text-surface-950 flex items-center transition-colors"
					aria-label="GitHub Issues"
				>
					<CircleHelp class="h-5 w-5" aria-hidden="true" />
				</a>
				<a
					href={PROJECT_REPOSITORY_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="text-surface-600 hover:text-surface-950 flex items-center transition-colors"
					aria-label={m.nav_github_aria()}
				>
					<Github class="h-5 w-5" />
				</a>
			</div>
		</nav>
	</div>
</header>
