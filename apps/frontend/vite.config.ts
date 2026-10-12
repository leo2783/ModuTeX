import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFile } from 'node:fs/promises';
import { mathLiveInputOnlyPlugin } from './scripts/mathlive-input-only.mjs';

// These ESM grammars stay lazy. Selecting a new language must not reload the editor.
const languagePackages = ['angular', 'cpp', 'css', 'go', 'html', 'java', 'javascript', 'jinja', 'json', 'liquid', 'less', 'markdown', 'php', 'python', 'rust', 'sass', 'sql', 'vue', 'wast', 'xml', 'yaml'].map(name => `@codemirror/lang-${name}`);
export default defineConfig({ optimizeDeps: { include: ['@codemirror/language', '@codemirror/state', '@codemirror/view', '@lezer/highlight', 'prosemirror-model', 'prosemirror-state', 'prosemirror-view'], exclude: ['mathlive', '@codemirror/language-data', '@codemirror/legacy-modes', ...languagePackages] }, ssr: { optimizeDeps: { exclude: ['svelte', 'svelte/server', 'svelte/internal/server'] } }, plugins: [mathLiveInputOnlyPlugin(), svelte(), {
	name: 'frontend-notices',
	async generateBundle() {
		this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md',
			source: await readFile(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8') });
	}
}], base: './', build: { sourcemap: true, manifest: true } });
