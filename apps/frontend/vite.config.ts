import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFile } from 'node:fs/promises';
import { mathLiveInputOnlyPlugin } from './scripts/mathlive-input-only.mjs';
import { tauriCspPlugin } from './scripts/tauri-csp.mjs';
import { frontendBuildEvidencePlugin } from './scripts/frontend-build-evidence.mjs';

// These ESM grammars stay lazy. Selecting a new language must not reload the editor.
const languagePackages = ['angular', 'cpp', 'css', 'go', 'html', 'java', 'javascript', 'jinja', 'json', 'liquid', 'less', 'markdown', 'php', 'python', 'rust', 'sass', 'sql', 'vue', 'wast', 'xml', 'yaml'].map(name => `@codemirror/lang-${name}`);
export default defineConfig(({ mode, command }) => ({ optimizeDeps: { include: ['@codemirror/language', '@codemirror/state', '@codemirror/view', '@lezer/highlight', 'prosemirror-model', 'prosemirror-state', 'prosemirror-view'], exclude: ['mathlive', '@codemirror/language-data', '@codemirror/legacy-modes', ...languagePackages] }, ssr: { optimizeDeps: { exclude: ['svelte', 'svelte/server', 'svelte/internal/server'] } }, worker: { format: 'es' }, plugins: [...tauriCspPlugin(mode, command), mathLiveInputOnlyPlugin(), svelte({ configFile: false }), frontendBuildEvidencePlugin(mode === 'tauri' && command === 'build'), {
	name: 'frontend-notices',
	async generateBundle() {
		for (const fileName of ['LICENSE', 'NOTICE']) this.emitFile({ type: 'asset', fileName, source: await readFile(new URL('./' + fileName, import.meta.url), 'utf8') });
		this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md',
			source: await readFile(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8') });
		this.emitFile({ type: 'asset', fileName: 'RUST_THIRD_PARTY_NOTICES.md',
			source: await readFile(new URL('./src/features/document-core/generated/RUST_THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8') });
	}
}], base: './', build: { outDir: mode === 'tauri' ? 'dist-tauri' : 'dist', sourcemap: true, manifest: true } }));
