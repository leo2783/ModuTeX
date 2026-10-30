// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const generatedDirectory = path.resolve(
	process.env.MODUTEX_DOCUMENT_CORE_WASM_DIR ??
		path.join(frontendRoot, 'src', 'features', 'document-core', 'generated')
);
const wasmPath = path.resolve(generatedDirectory, 'modutex_document_core_bg.wasm');
const nativeFetch = globalThis.fetch;

if (typeof nativeFetch !== 'function') throw new Error('FETCH_UNAVAILABLE');

globalThis.fetch = async (input, init) => {
	let url = null;
	if (input instanceof URL) url = input;
	else if (typeof input === 'string') {
		try {
			url = new URL(input);
		} catch {
			url = null;
		}
	} else if (typeof input === 'object' && input !== null && 'url' in input) {
		try {
			url = new URL(String(input.url));
		} catch {
			url = null;
		}
	}

	if (url?.protocol === 'file:' && path.resolve(fileURLToPath(url)) === wasmPath) {
		return new Response(await readFile(wasmPath), {
			headers: { 'Content-Type': 'application/wasm' }
		});
	}
	return Reflect.apply(nativeFetch, globalThis, [input, init]);
};
