import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFile } from 'node:fs/promises';

export default defineConfig({ plugins: [svelte(), {
	name: 'frontend-notices',
	async generateBundle() {
		this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md',
			source: await readFile(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8') });
	}
}], base: './', build: { sourcemap: true, manifest: true } });
