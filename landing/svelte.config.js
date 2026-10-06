import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// The docs prose is English-only for now, but the localized routes still have to exist so the
// nav can never 404 in another locale. Keep in sync with TOPICS in src/lib/docs/nav.ts.
const DOC_SLUGS = [
	'',
	'/installation',
	'/installation/windows',
	'/getting-started',
	'/live-preview',
	'/visual-editing',
	'/visual-editing/math',
	'/visual-editing/images',
	'/visual-editing/tables',
	'/visual-editing/citations',
	'/visual-editing/smart-selection',
	'/source-editing',
	'/spell-check',
	'/intellisense',
	'/compiling',
	'/projects',
	'/version-control',
	'/collaboration',
	'/mcp'
];
const NON_BASE_LOCALES = ['zh-Hans', 'zh-Hant', 'de'];
const localizedDocs = NON_BASE_LOCALES.flatMap((l) => DOC_SLUGS.map((s) => `/${l}/docs${s}`));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],
	kit: {
		// Fully static site (single landing page) — deployable to any static host at a domain root.
		adapter: adapter({ fallback: undefined }),
		// '*' crawls real <a href> tags for the locale variants; the Navbar's language switcher is a
		// Menu component (not anchors), so the non-base locales must be listed explicitly or they
		// silently stop being prerendered.
		prerender: {
			entries: ['*', '/zh-Hans', '/zh-Hans/download', '/zh-Hant', '/zh-Hant/download', '/de', '/de/download', ...localizedDocs]
		},
		// absolute asset URLs, so 404.html (served for any missing path) is styled at any URL depth
		paths: { relative: false }
	}
};

export default config;
