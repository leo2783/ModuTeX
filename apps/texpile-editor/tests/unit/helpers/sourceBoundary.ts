import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const collaborationPatterns = [
	/collab\.texpile\.com/,
	/(?:\$lib\/collab|\.\/views\/SessionRoute\.svelte|['"]\/session(?:['"/?#])|openShareSession|file\.shareSession|menubar_share_session)/
];

export const telemetryPatterns = [
	/(?:@plausible-analytics\/tracker|plausible\.io|\/api\/event|\binitAnalytics\b|\btrackEvent\b|\btrackFeatureUsed\b|\bsetReferralSource\b|\boutboundLinks\b|\bfileDownloads\b)/
];

export async function productionFiles(root: string): Promise<string[]> {
	const absoluteRoot = path.resolve(root);
	const rootEntry = await lstat(absoluteRoot);
	if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error(`Invalid source root: ${absoluteRoot}`);
	const generated = path.join(absoluteRoot, 'lib', 'paraglide');
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Linked source entry: ${absolute}`);
			if (entry.isDirectory()) {
				if (absolute !== generated) await visit(absolute);
			} else if (/\.(?:ts|svelte)$/.test(entry.name)) {
				if (!entry.isFile()) throw new Error(`Non-regular source entry: ${absolute}`);
				files.push(absolute);
			}
		}
	}
	await visit(absoluteRoot);
	return files;
}

export async function assertSourceBoundary(roots: string[], forbidden: RegExp[]): Promise<{ sourceFiles: number; bytes: number }> {
	const files = (await Promise.all(roots.map(productionFiles))).flat();
	let next = 0;
	let bytes = 0;
	await Promise.all(
		Array.from({ length: Math.min(8, files.length) }, async () => {
			while (next < files.length) {
				const file = files[next++];
				const content = await readFile(file);
				bytes += content.byteLength;
				for (const pattern of forbidden) {
					pattern.lastIndex = 0;
					if (pattern.test(content.toString('utf8'))) throw new Error(`Forbidden production source in ${file}: ${pattern.source}`);
				}
			}
		})
	);
	return { sourceFiles: files.length, bytes };
}
