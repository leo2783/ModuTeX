import * as path from 'node:path';

export const DIAGRAM_DIR = 'assets/diagrams';
export const MERMAID_SOURCE_LIMIT = 1024 * 1024;
export const DRAWIO_SOURCE_LIMIT = 10 * 1024 * 1024;
export const DIAGRAM_OUTPUT_LIMIT = 25 * 1024 * 1024;

export type DiagramType = 'mermaid' | 'drawio';

export interface DiagramBundlePaths {
	source: string;
	svg: string;
	pdf: string;
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIAGRAM_FILE = new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-${UUID_SOURCE}\\.(mmd|drawio|svg|pdf)$`);

export function diagramBundlePaths(slug: unknown, id: unknown, type: unknown): DiagramBundlePaths {
	if (typeof slug !== 'string' || !SLUG.test(slug) || typeof id !== 'string' || !UUID.test(id)) {
		throw new Error('INVALID_DIAGRAM_NAME');
	}
	if (type !== 'mermaid' && type !== 'drawio') throw new Error('INVALID_DIAGRAM_NAME');
	const stem = `${DIAGRAM_DIR}/${slug}-${id}`;
	try {
		return {
			source: assertDiagramRelativePath(`${stem}.${type === 'mermaid' ? 'mmd' : 'drawio'}`),
			svg: assertDiagramRelativePath(`${stem}.svg`),
			pdf: assertDiagramRelativePath(`${stem}.pdf`)
		};
	} catch {
		throw new Error('INVALID_DIAGRAM_NAME');
	}
}

export function assertDiagramRelativePath(relativePath: unknown, expectedExtensions?: readonly string[]): string {
	if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 500) throw new Error('INVALID_PATH');
	if (relativePath.includes('\\') || relativePath.includes('\0') || path.posix.isAbsolute(relativePath)) {
		throw new Error('INVALID_PATH');
	}
	if (path.posix.normalize(relativePath) !== relativePath || !relativePath.startsWith(`${DIAGRAM_DIR}/`)) {
		throw new Error('INVALID_PATH');
	}
	const file = relativePath.slice(DIAGRAM_DIR.length + 1);
	const match = DIAGRAM_FILE.exec(file);
	if (!match || (expectedExtensions?.length && !expectedExtensions.includes(match[1]))) throw new Error('INVALID_PATH');
	return relativePath;
}

export function resolveDiagramPath(root: string, relativePath: unknown, expectedExtensions?: readonly string[]): string {
	if (!root || !path.isAbsolute(root)) throw new Error('INVALID_ROOT');
	const safeRelative = assertDiagramRelativePath(relativePath, expectedExtensions);
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(resolvedRoot, ...safeRelative.split('/'));
	const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
	if (!resolved.startsWith(prefix)) throw new Error('INVALID_PATH');
	return resolved;
}
