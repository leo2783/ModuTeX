import { defineConfig } from 'vitest/config';
import { windowsSafeWasm } from './scripts/windows-safe-wasm';

export default defineConfig({
	// the parser's glue imports the .wasm as an ES module, which Vite cannot do unaided
	plugins: [windowsSafeWasm],
	test: {
		include: ['tests/**/*.test.ts']
	},
	// wasm-pack's glue initialises with a top-level await
	oxc: { target: 'esnext' },
	optimizeDeps: { esbuildOptions: { target: 'esnext' } }
});
