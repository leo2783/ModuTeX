// PDF.js 6 loads character maps, fallback fonts and codecs through BinaryDataFactory.
// Vite emits local assets for both development and packaged, offline desktop builds.
const maps = import.meta.glob('../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
	eager: true, query: '?url', import: 'default'
}) as Record<string, string>;
const fonts = import.meta.glob('../../../../../node_modules/pdfjs-dist/standard_fonts/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const wasm = import.meta.glob('../../../../../node_modules/pdfjs-dist/wasm/*.wasm', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const resources = Object.fromEntries(Object.entries({ cMapUrl: maps, standardFontDataUrl: fonts, wasmUrl: wasm }).map(([kind, entries]) =>
	[kind, new Map(Object.entries(entries).map(([path, url]) => [path.split('/').at(-1)!, url]))]));

export class LocalPdfDataReader {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const url = resources[kind]?.get(filename);
		if (!url) throw new Error(`Unknown PDF resource: ${kind}/${filename}`);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Unable to load PDF resource: ${kind}/${filename}`);
		return new Uint8Array(await response.arrayBuffer());
	}
}
