import { imageType, validateImageFile, IMAGE_BYTES_LIMIT } from '@modutex/frontend-contracts';
import type { FileDesktopPort } from '../files/desktop.ts';
import { parseSource, SourceDocument, type SyntaxNode } from '../document-core/core.ts';

export interface ImageContext { desktop: FileDesktopPort | null; workspaceId: string | null; path: string; documentId: string; documentVersion: number }
const prefix = 'modutex-image-';
export function imageSource(path: string): string {
	if (!/^[\w./-]+\.(png|jpe?g)$/i.test(path) || path.split('/').includes('..')) throw new Error('IMAGE_PATH');
	return '\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{' + path + '}\n\\end{figure}\n';
}
export function imagePath(source: string): string | null {
	const match = /^\\begin\{figure\}\[htbp\]\s*\\centering\s*\\includegraphics\[width=0\.8\\linewidth\]\{([\w./-]+\.(?:png|jpe?g))\}\s*\\end\{figure\}\s*$/i.exec(source.trim());
	return match && !match[1]!.split('/').includes('..') ? match[1]! : null;
}
function sibling(context: ImageContext, name: string): string { return context.path.includes('/') ? context.path.slice(0, context.path.lastIndexOf('/') + 1) + name : name; }
async function database(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('modutex-image-assets', 1);
		request.onupgradeneeded = () => request.result.createObjectStore('images');
		request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
	});
}
async function localAsset(name: string, bytes?: Uint8Array): Promise<Uint8Array> {
	const db = await database();
	try { return await new Promise((resolve, reject) => {
		const transaction = db.transaction('images', bytes ? 'readwrite' : 'readonly');
		const request = bytes ? transaction.objectStore('images').put(bytes, name) : transaction.objectStore('images').get(name);
		let result: Uint8Array;
		request.onsuccess = () => { result = bytes ?? request.result; };
		transaction.oncomplete = () => result ? resolve(result) : reject(new Error('IMAGE_MISSING'));
		transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error);
	}); } finally { db.close(); }
}
export async function storeImage(context: ImageContext, file: Blob): Promise<string> {
	if (file.size > IMAGE_BYTES_LIMIT) throw new Error('IMAGE_TOO_LARGE');
	const bytes = new Uint8Array(await file.arrayBuffer()), type = imageType(bytes);
	const decoded = await createImageBitmap(new Blob([bytes], { type })); decoded.close();
	const name = prefix + crypto.randomUUID() + (type === 'image/png' ? '.png' : '.jpg');
	if (context.desktop) {
		if (!context.workspaceId) throw new Error('IMAGE_SAVE_REQUIRED');
		// An asset is a separate file. Reusing the editor's ID attempts to rebind
		// the saved TeX document to this image and is rejected by the native host.
		await context.desktop.writeFile({ workspaceId: context.workspaceId, path: sibling(context, name), bytes, expectedRevision: null, documentId: 'image-' + crypto.randomUUID(), documentVersion: 0 });
	} else await localAsset(name, bytes);
	return name;
}
export async function readImage(context: ImageContext, name: string): Promise<Blob> {
	imageSource(name);
	const bytes = context.desktop && context.workspaceId ? (await context.desktop.readFile({ workspaceId: context.workspaceId, path: sibling(context, name) })).bytes : await localAsset(name);
	validateImageFile(name, bytes); return new Blob([new Uint8Array(bytes)], { type: imageType(bytes) });
}
export function referencedImages(source: SourceDocument): string[] {
	const names = new Set<string>();
	function visit(document: SourceDocument, nodes: readonly SyntaxNode[], depth = 0) {
		if (depth > 32) throw new Error('IMAGE_PLAN');
		for (const node of nodes) {
			if (node.kind === 'raw' && node.name === 'includegraphics') {
				const match = /\\includegraphics(?:\[[^\]]*\])?\{(modutex-image-[\da-f-]+\.(?:png|jpe?g))\}/i.exec(document.read(node.span.from, node.span.to));
				if (match) names.add(match[1]!);
			} else if (node.kind === 'raw' && node.name === 'figure' && node.content) {
				const inner = SourceDocument.open(new TextEncoder().encode(document.read(node.content.from, node.content.to)));
				const parsed = parseSource(inner); if (parsed.issues.some(issue => issue.code === 'BUDGET')) throw new Error('IMAGE_PLAN');
				visit(inner, parsed.nodes, depth + 1);
			} else if (node.kind === 'environment') visit(document, node.children, depth + 1);
		}
	}
	const parsed = parseSource(source); if (parsed.issues.some(issue => issue.code === 'BUDGET')) throw new Error('IMAGE_PLAN');
	visit(source, parsed.nodes); return [...names];
}
export async function saveAsImages(context: ImageContext, source: SourceDocument) {
	const names = referencedImages(source);
	const images = []; let total = 0;
	for (const path of names) { const bytes = new Uint8Array(await (await readImage(context, path)).arrayBuffer()); total += bytes.length; if (total > 32 * 1024 * 1024 || images.length >= 4096) throw new Error('IMAGE_TOO_LARGE'); images.push({ path, bytes }); }
	return images;
}
