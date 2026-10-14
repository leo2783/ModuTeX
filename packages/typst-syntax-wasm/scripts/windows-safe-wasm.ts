import wasm from 'vite-plugin-wasm';
import type { Plugin } from 'vite';

// Vitest 4 on Windows cannot create a Node require() from the root-looking helper ID.
// Keep the installed plugin's genuine WASM loader, with a valid virtual-module ID.
const wasmPlugin = wasm();
const helperId = '/__vite-plugin-wasm-helper';
const virtualHelperId = '\0__vite-plugin-wasm-helper';
export const windowsSafeWasm: Plugin = {
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
