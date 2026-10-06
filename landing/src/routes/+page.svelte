<script lang="ts">
	import {
		Download,
		ChevronDown,
		Check,
		ArrowRight,
		Terminal,
		GitCommitHorizontal,
		FolderTree,
		Command,
		Keyboard,
		TextCursorInput,
		SpellCheck,
		Plug,
		History
	} from '@lucide/svelte';
	import Hero from '$lib/comp/Hero.svelte';
	import typingWebm from '$lib/assets/showcase/visual-typing.webm';
	import typingMp4 from '$lib/assets/showcase/visual-typing.mp4';
	import livePreviewMp4 from '$lib/assets/showcase/live-preview.mp4';
	import collabShot from '$lib/assets/showcase/editor-collab.webp';
	// the -dark png over intellisense.webp: the webp is 579px and blurry at this column width
	import intellisenseShot from '$lib/assets/showcase/intellisense-dark.png';
	import SiteMetadata from '$lib/comp/SiteMetadata.svelte';
	import { m } from '$lib/paraglide/messages';
	import { getSiteUrl } from '$lib/site-origin';

	const features = [
		{ icon: Terminal, title: m.feature_terminal_title(), body: m.feature_terminal_body() },
		{ icon: GitCommitHorizontal, title: m.feature_history_title(), body: m.feature_history_body() },
		{ icon: FolderTree, title: m.feature_multifile_title(), body: m.feature_multifile_body() },
		{ icon: Command, title: m.feature_palette_title(), body: m.feature_palette_body() },
		{ icon: Keyboard, title: m.feature_keymaps_title(), body: m.feature_keymaps_body() },
		{ icon: TextCursorInput, title: m.feature_multicursor_title(), body: m.feature_multicursor_body() },
		{ icon: SpellCheck, title: m.feature_spellcheck_title(), body: m.feature_spellcheck_body() },
		{ icon: Plug, title: m.feature_mcp_title(), body: m.feature_mcp_body() },
		{ icon: History, title: m.feature_tabs_title(), body: m.feature_tabs_body() }
	];

	const editingPoints = [
		m.editing_point_1(),
		m.editing_point_2(),
		m.editing_point_3(),
		m.editing_point_5(),
		m.editing_point_6(),
		m.editing_point_4()
	];

	// every claim here is backed by the static project parse
	const sourcePoints = [
		m.intellisense_point_1(),
		m.intellisense_point_2(),
		m.intellisense_point_3(),
		m.intellisense_point_4(),
		m.feature_math_body(),
		m.feature_synctex_body()
	];

	const collabPoints = [m.collab_point_1(), m.collab_point_2(), m.collab_point_3(), m.collab_point_4()];

	const faqs = [
		{ q: m.faq_q_free(), a: m.faq_a_free() },
		{ q: m.faq_q_files(), a: m.faq_a_files() },
		{ q: m.faq_q_internet(), a: m.faq_a_internet() },
		{ q: m.faq_q_collab(), a: m.faq_a_collab() },
		{ q: m.faq_q_rewrite(), a: m.faq_a_rewrite() },
		{ q: m.faq_q_latex_installed(), a: m.faq_a_latex_installed() },
		{ q: m.faq_q_electron(), a: m.faq_a_electron() }
	];

	const jsonLdFeatureList = [
		m.home_jsonld_feature_1(),
		m.home_jsonld_feature_2(),
		m.home_jsonld_feature_3(),
		m.home_jsonld_feature_4(),
		m.home_jsonld_feature_5(),
		m.home_jsonld_feature_6()
	];

	// escape for embedding in a <script type="application/ld+json"> block below
	const structuredDataUrl = getSiteUrl('/');
	const jsonLd = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'ModuTeX',
		description: m.home_meta_description(),
		...(structuredDataUrl ? { url: structuredDataUrl } : {}),
		applicationCategory: 'ProductivityApplication',
		operatingSystem: 'Windows x64',
		offers: {
			'@type': 'Offer',
			availability: 'https://schema.org/InStock'
		},
		creator: {
			'@type': 'Organization',
			name: 'ModuTeX'
		},
		featureList: jsonLdFeatureList
	}).replace(/</g, '\\u003c');
</script>

<svelte:head>
	<title>{m.home_title()}</title>
	<meta name="description" content={m.home_meta_description()} />
	<meta name="keywords" content={m.home_meta_keywords()} />
	{@html `<script type="application/ld+json">${jsonLd}</script>`}
</svelte:head>

<SiteMetadata path="/" title={m.home_title()} description={m.home_social_description()} includeLanguageAlternates />

<Hero />

<section id="live-preview" class="border-surface-200 border-t bg-white py-16 md:py-20">
	<div class="container mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
		<h2 class="text-center text-surface-900 text-2xl font-semibold md:text-3xl">{m.live_preview_heading()}</h2>
		<p class="text-surface-600 mx-auto mt-4 max-w-2xl text-center text-lg leading-relaxed">
			{m.live_preview_body()}
		</p>
		<p class="mb-10 text-center">{@render docsLink('/docs/live-preview')}</p>
		<div class="overflow-hidden rounded-lg border-surface-200 border shadow-2xl">
			<!-- muted looping demo, behaves like an animated image -->
			<video autoplay muted loop playsinline disablepictureinpicture aria-label={m.live_preview_video_aria()} class="block w-full">
				<source src={livePreviewMp4} type="video/mp4" />
			</video>
		</div>
	</div>
</section>

<section id="editing" class="border-surface-200 border-t bg-surface-50 py-16 md:py-20">
	<div class="container mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
		<h2 class="text-surface-900 mb-12 text-center text-2xl font-semibold md:text-3xl">{m.editing_heading()}</h2>

		<!-- the two modes read as a pair, so they sit in one row rather than two stacked sections -->
		<div class="grid gap-10 lg:grid-cols-2 lg:gap-12">
			<div id="visual-editing" class="flex flex-col gap-5">
				<div class="border-surface-200 h-[240px] overflow-hidden rounded-lg border bg-white shadow-lg lg:h-[280px]">
					<!-- muted looping demo, behaves like an animated image -->
					<video
						autoplay
						muted
						loop
						playsinline
						disablepictureinpicture
						aria-label={m.visual_editing_video_aria()}
						class="h-full w-full object-cover object-top"
					>
						<source src={typingWebm} type="video/webm" />
						<source src={typingMp4} type="video/mp4" />
					</video>
				</div>
				<h3 class="text-surface-900 text-xl font-semibold">{m.visual_editing_heading()}</h3>
				<p class="text-surface-600 leading-relaxed">{m.visual_editing_body()}</p>
				<ul class="space-y-3">
					{#each editingPoints as point (point)}
						<li class="flex items-start gap-3">
							<Check class="text-primary-500 mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} />
							<span class="text-surface-700 leading-relaxed">{point}</span>
						</li>
					{/each}
				</ul>
				<div class="mt-auto pt-1">{@render docsLink('/docs/visual-editing')}</div>
			</div>

			<div id="source-editing" class="flex flex-col gap-5">
				<div class="border-surface-200 h-[240px] overflow-hidden rounded-lg border bg-white shadow-lg lg:h-[280px]">
					<img
						src={intellisenseShot}
						alt={m.intellisense_shot_alt()}
						loading="lazy"
						draggable="false"
						class="h-full w-full object-cover object-top"
					/>
				</div>
				<h3 class="text-surface-900 text-xl font-semibold">{m.source_editing_heading()}</h3>
				<p class="text-surface-600 leading-relaxed">{m.source_editing_body()}</p>
				<ul class="space-y-3">
					{#each sourcePoints as point (point)}
						<li class="flex items-start gap-3">
							<Check class="text-primary-500 mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} />
							<span class="text-surface-700 leading-relaxed">{point}</span>
						</li>
					{/each}
				</ul>
				<div class="mt-auto pt-1">{@render docsLink('/docs/intellisense')}</div>
			</div>
		</div>
	</div>
</section>

<section id="collaboration" class="border-surface-200 border-t bg-surface-50 py-16 md:py-20">
	<div class="container mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
		<h2 class="mb-10 text-center text-surface-900 text-2xl font-semibold md:text-3xl">{m.collab_heading()}</h2>
		<div class="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
			<div class="flex flex-col justify-center gap-6">
				<p class="text-surface-600 text-lg leading-relaxed">{m.collab_body()}</p>
				<ul class="space-y-3">
					{#each collabPoints as point (point)}
						<li class="flex items-start gap-3">
							<Check class="text-primary-500 mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} />
							<span class="text-surface-700 leading-relaxed">{point}</span>
						</li>
					{/each}
				</ul>
				<div>{@render docsLink('/docs/collaboration')}</div>
			</div>
			<div class="mx-auto w-full max-w-xl overflow-hidden rounded-lg border-surface-200 border shadow-2xl">
				<img src={collabShot} alt={m.collab_heading()} loading="lazy" draggable="false" class="block w-full" />
			</div>
		</div>
	</div>
</section>

<section id="features" class="border-surface-200 border-t bg-white py-16 md:py-20">
	<div class="container mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
		<h2 class="mb-10 text-center text-surface-900 text-2xl font-semibold md:text-3xl">{m.features_heading()}</h2>

		<div class="mx-auto grid max-w-5xl gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
			{#each features as f (f.title)}
				{@const Icon = f.icon}
				<div>
					<div class="bg-primary-50 text-primary-600 rounded-base mb-4 flex h-10 w-10 items-center justify-center">
						<Icon class="h-5 w-5" strokeWidth={2} />
					</div>
					<h3 class="text-surface-900 mb-1.5 text-base font-semibold">{f.title}</h3>
					<p class="text-surface-700 leading-relaxed">{f.body}</p>
				</div>
			{/each}
		</div>

		<p class="text-surface-600 mt-12 text-center">
			{m.features_docs_note()}
			<span class="ml-2 inline-block">{@render docsLink('/docs')}</span>
		</p>
	</div>
</section>

<section id="faq" class="border-surface-200 border-t bg-surface-50 py-16 md:py-20">
	<div class="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
		<h2 class="mb-10 text-center text-surface-900 text-2xl font-semibold md:text-3xl">{m.faq_heading()}</h2>
		<div class="border-surface-200 overflow-hidden rounded-lg border bg-white">
			{#each faqs as f (f.q)}
				<!-- details, not a JS accordion: the answers stay in the DOM for crawlers and work with JS off -->
				<details class="group border-surface-200 border-b last:border-b-0">
					<summary
						class="flex cursor-pointer list-none items-center justify-between text-surface-900 gap-4 px-5 py-4 font-medium [&::-webkit-details-marker]:hidden"
					>
						{f.q}
						<ChevronDown class="text-surface-400 h-5 w-5 shrink-0 transition-transform group-open:rotate-180" />
					</summary>
					<p class="text-surface-600 px-5 pb-5 leading-relaxed">{f.a}</p>
				</details>
			{/each}
		</div>
	</div>
</section>

<section id="download" class="border-surface-200 border-t bg-white py-16 md:py-20">
	<div class="container mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
		<div class="space-y-6 text-center">
			<h2 class="text-surface-900 text-2xl font-semibold md:text-3xl">{m.download_section_heading()}</h2>
			<p class="text-surface-600">{m.download_section_body()}</p>
			<a
				href="/download"
				class="btn preset-filled-primary-500 rounded-base inline-flex items-center gap-2 px-7 py-3 font-semibold text-white"
			>
				<Download class="h-5 w-5" />
				{m.word_download()}
			</a>
		</div>
	</div>
</section>

<section id="ps" class="border-surface-200 border-t bg-surface-50 py-14">
	<div class="container mx-auto max-w-2xl px-4 text-center sm:px-6">
		<h2 class="text-surface-900 text-base font-semibold">{m.ps_heading()}</h2>
		<p class="text-surface-500 mt-3 text-sm leading-relaxed">
			{m.ps_body()}
		</p>
	</div>
</section>

{#snippet docsLink(href: string)}
	<a {href} class="text-primary-600 hover:text-primary-700 inline-flex items-center gap-1.5 font-medium transition-colors">
		{m.docs_link_label()}
		<ArrowRight class="h-4 w-4" />
	</a>
{/snippet}
