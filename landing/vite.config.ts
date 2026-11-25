import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

// Keep these routes in sync with TOPICS in src/lib/docs/nav.ts.
const docsSlugs = [
	'', '/installation', '/installation/windows', '/getting-started', '/live-preview',
	'/visual-editing', '/visual-editing/math', '/visual-editing/images', '/visual-editing/tables',
	'/visual-editing/citations', '/visual-editing/smart-selection', '/source-editing', '/spell-check',
	'/intellisense', '/compiling', '/projects', '/version-control', '/collaboration', '/mcp'
];
const localizedRoutes = ['zh-Hans', 'zh-Hant', 'de'].flatMap<`/${string}`>(locale => [
	`/${locale}`,
	`/${locale}/download`,
	...docsSlugs.map(slug => `/${locale}/docs${slug}` as const)
]);

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: adapter(),
			preprocess: [vitePreprocess()],
			alias: { $lib: './src/lib' },
			// The language menu is interactive, so static crawling needs explicit localized entries.
			prerender: { entries: ['*', ...localizedRoutes] },
			// Absolute assets let the static error page load at any URL depth.
			paths: { relative: false }
		}),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			emitTsDeclarations: true,
			strategy: ['url', 'cookie', 'baseLocale']
		})
	]
});
