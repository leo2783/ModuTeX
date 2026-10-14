import { defineConfig } from 'vitest/config';
import wasm from 'vite-plugin-wasm';
import type { Plugin } from 'vite';

// A root-looking helper ID is converted into file:///__vite-plugin-wasm-helper by
// Vitest 4 on Windows. Use Vite's virtual-module namespace, while letting the
// reviewed plugin generate its original helper and instantiate the real WASM.
const wasmPlugin = wasm();
const helperId = '/__vite-plugin-wasm-helper';
const virtualHelperId = '\0__vite-plugin-wasm-helper';
const windowsSafeWasm: Plugin = {
	...wasmPlugin,
	resolveId(id) {
		if (id === helperId) return virtualHelperId;
	},
	load(id, options) {
		const load = wasmPlugin.load;
		if (typeof load !== 'function') throw new Error('Expected vite-plugin-wasm load hook');
		return load.call(this, id === virtualHelperId ? helperId : id, options);
	}
};

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
