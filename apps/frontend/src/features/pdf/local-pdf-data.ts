// PDF.js 6 loads character maps, fallback fonts and codecs through BinaryDataFactory.
// Vite emits local assets for both development and packaged, offline desktop builds.
import { resources } from './resources.generated.ts';

export class LocalPdfDataReader {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const url = resources[kind]?.get(filename);
		if (!url) throw new Error(`Unknown PDF resource: ${kind}/${filename}`);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Unable to load PDF resource: ${kind}/${filename}`);
		return new Uint8Array(await response.arrayBuffer());
	}
}
