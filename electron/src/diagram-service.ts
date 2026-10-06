import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import {
	DIAGRAM_DIR,
	DIAGRAM_OUTPUT_LIMIT,
	DRAWIO_SOURCE_LIMIT,
	MERMAID_SOURCE_LIMIT,
	assertDiagramRelativePath
} from './diagram-security';

export type DiagramBundleState = 'missing' | 'stale' | 'ready' | 'error';
export type DiagramFileError = 'INVALID_FILE' | 'IO_ERROR' | 'PAYLOAD_TOO_LARGE';

export interface DiagramFileStatus {
	exists: boolean;
	mtimeMs: number;
	size?: number;
	sha256?: string;
	error?: DiagramFileError;
}

export interface DiagramBundleStatus {
	state: DiagramBundleState;
	source: DiagramFileStatus;
	svg: DiagramFileStatus;
	pdf: DiagramFileStatus;
	missing: boolean;
	stale: boolean;
	ready: boolean;
	error: boolean;
}

export interface DiagramDirectory {
	root: string;
	directory: string;
}

const SAFE_ERROR_CODES = new Set([
	'DIAGRAM_NOT_FOUND',
	'DIAGRAM_READ_FAILED',
	'DIAGRAM_WRITE_FAILED',
	'INVALID_FILE',
	'INVALID_PATH',
	'INVALID_ROOT',
	'PAYLOAD_TOO_LARGE'
]);

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function isMissing(error: unknown): boolean {
	return errorCode(error) === 'ENOENT';
}

function rethrowSafe(error: unknown, fallback: string): never {
	if (error instanceof Error && SAFE_ERROR_CODES.has(error.message)) throw error;
	throw new Error(fallback);
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function limitFor(relativePath: string): number {
	if (relativePath.endsWith('.mmd')) return MERMAID_SOURCE_LIMIT;
	if (relativePath.endsWith('.drawio')) return DRAWIO_SOURCE_LIMIT;
	return DIAGRAM_OUTPUT_LIMIT;
}

async function canonicalWorkspaceRoot(root: string): Promise<string> {
	if (!root || !path.isAbsolute(root)) throw new Error('INVALID_ROOT');
	try {
		const canonical = await realpath(root);
		const metadata = await lstat(canonical);
		if (!metadata.isDirectory()) throw new Error('INVALID_ROOT');
		return canonical;
	} catch (error) {
		rethrowSafe(error, 'INVALID_ROOT');
	}
}

export async function diagramDirectory(root: string, create: boolean): Promise<DiagramDirectory> {
	const canonicalRoot = await canonicalWorkspaceRoot(root);
	let current = canonicalRoot;
	for (const segment of DIAGRAM_DIR.split('/')) {
		const next = path.join(current, segment);
		if (create) {
			try {
				await mkdir(next);
			} catch (error) {
				if (errorCode(error) !== 'EEXIST') rethrowSafe(error, 'DIAGRAM_WRITE_FAILED');
			}
		}

		let metadata;
		try {
			metadata = await lstat(next);
		} catch (error) {
			if (!create && isMissing(error)) throw new Error('DIAGRAM_NOT_FOUND');
			rethrowSafe(error, create ? 'DIAGRAM_WRITE_FAILED' : 'DIAGRAM_READ_FAILED');
		}
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('INVALID_PATH');

		let canonical;
		try {
			canonical = await realpath(next);
		} catch (error) {
			rethrowSafe(error, create ? 'DIAGRAM_WRITE_FAILED' : 'DIAGRAM_READ_FAILED');
		}
		if (!isContained(canonicalRoot, canonical)) throw new Error('INVALID_PATH');
		current = canonical;
	}
	return { root: canonicalRoot, directory: current };
}

async function targetPath(
	root: string,
	relativePath: string,
	extensions: readonly string[],
	createDirectory: boolean
): Promise<{ context: DiagramDirectory; target: string }> {
	const safeRelative = assertDiagramRelativePath(relativePath, extensions);
	const context = await diagramDirectory(root, createDirectory);
	const target = path.join(context.directory, path.basename(safeRelative));
	if (!isContained(context.root, target)) throw new Error('INVALID_PATH');
	try {
		if ((await lstat(target)).isSymbolicLink()) throw new Error('INVALID_PATH');
	} catch (error) {
		if (error instanceof Error && error.message === 'INVALID_PATH') throw error;
		if (!isMissing(error)) rethrowSafe(error, createDirectory ? 'DIAGRAM_WRITE_FAILED' : 'DIAGRAM_READ_FAILED');
	}
	return { context, target };
}

export async function verifyDirectoryUnchanged(context: DiagramDirectory): Promise<void> {
	const current = await diagramDirectory(context.root, false);
	if (current.directory !== context.directory) throw new Error('INVALID_PATH');
}

export async function atomicWriteDiagram(
	root: string,
	relativePath: string,
	content: string | Uint8Array,
	checkpoint: () => Promise<void> = async () => {}
): Promise<{ sha256: string; size: number }> {
	const safeRelative = assertDiagramRelativePath(relativePath, ['mmd', 'drawio', 'svg', 'pdf']);
	const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
	if (bytes.byteLength > limitFor(safeRelative)) throw new Error('PAYLOAD_TOO_LARGE');

	let temporary: string | undefined;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const { context, target } = await targetPath(root, safeRelative, ['mmd', 'drawio', 'svg', 'pdf'], true);
		temporary = path.join(context.directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
		handle = await open(temporary, 'wx', 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await verifyDirectoryUnchanged(context);
		try {
			if ((await lstat(target)).isSymbolicLink()) throw new Error('INVALID_PATH');
		} catch (error) {
			if (error instanceof Error && error.message === 'INVALID_PATH') throw error;
			if (!isMissing(error)) rethrowSafe(error, 'DIAGRAM_WRITE_FAILED');
		}
		await checkpoint();
		await rename(temporary, target);
		temporary = undefined;
		return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (temporary) await unlink(temporary).catch(() => undefined);
		rethrowSafe(error, 'DIAGRAM_WRITE_FAILED');
	}
}

async function readBoundedFile(
	root: string,
	relativePath: string,
	extensions: readonly string[]
): Promise<{ bytes: Buffer; sha256: string; mtimeMs: number; size: number }> {
	try {
		const { target } = await targetPath(root, relativePath, extensions, false);
		const handle = await open(target, 'r').catch((error) => {
			if (isMissing(error)) throw new Error('DIAGRAM_NOT_FOUND');
			throw error;
		});
		try {
			const metadata = await handle.stat();
			if (!metadata.isFile()) throw new Error('INVALID_FILE');
			if (metadata.size > limitFor(relativePath)) throw new Error('PAYLOAD_TOO_LARGE');
			const bytes = await handle.readFile();
			const verifiedMetadata = await handle.stat();
			if (
				bytes.byteLength > limitFor(relativePath) ||
				metadata.size !== verifiedMetadata.size ||
				metadata.mtimeMs !== verifiedMetadata.mtimeMs ||
				bytes.byteLength !== verifiedMetadata.size
			) {
				throw new Error(bytes.byteLength > limitFor(relativePath) ? 'PAYLOAD_TOO_LARGE' : 'DIAGRAM_READ_FAILED');
			}
			return {
				bytes,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				mtimeMs: verifiedMetadata.mtimeMs,
				size: bytes.byteLength
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'DIAGRAM_NOT_FOUND') throw error;
		rethrowSafe(error, 'DIAGRAM_READ_FAILED');
	}
}

export async function readDiagram(
	root: string,
	relativePath: string
): Promise<{ content: string; sha256: string; mtimeMs: number; size: number }> {
	const safeRelative = assertDiagramRelativePath(relativePath, ['mmd', 'drawio']);
	const result = await readBoundedFile(root, safeRelative, ['mmd', 'drawio']);
	return { content: result.bytes.toString('utf8'), sha256: result.sha256, mtimeMs: result.mtimeMs, size: result.size };
}

export async function readDiagramAsset(root: string, relativePath: string, extensions: readonly string[]): Promise<Buffer> {
	const safeRelative = assertDiagramRelativePath(relativePath, extensions);
	return (await readBoundedFile(root, safeRelative, extensions)).bytes;
}

const MISSING_STATUS: DiagramFileStatus = { exists: false, mtimeMs: 0 };

async function inspectFile(directory: string, relativePath: string): Promise<DiagramFileStatus> {
	const target = path.join(directory, path.basename(relativePath));
	try {
		const linkMetadata = await lstat(target);
		if (linkMetadata.isSymbolicLink()) throw new Error('INVALID_PATH');
		if (!linkMetadata.isFile()) return { ...MISSING_STATUS, error: 'INVALID_FILE' };
		const handle = await open(target, 'r');
		try {
			const metadata = await handle.stat();
			if (!metadata.isFile()) return { ...MISSING_STATUS, error: 'INVALID_FILE' };
			if (metadata.size > limitFor(relativePath)) return { ...MISSING_STATUS, error: 'PAYLOAD_TOO_LARGE' };
			const bytes = await handle.readFile();
			const verifiedMetadata = await handle.stat();
			if (bytes.byteLength > limitFor(relativePath)) return { ...MISSING_STATUS, error: 'PAYLOAD_TOO_LARGE' };
			if (
				metadata.size !== verifiedMetadata.size ||
				metadata.mtimeMs !== verifiedMetadata.mtimeMs ||
				bytes.byteLength !== verifiedMetadata.size
			) {
				return { ...MISSING_STATUS, error: 'IO_ERROR' };
			}
			return {
				exists: true,
				mtimeMs: verifiedMetadata.mtimeMs,
				size: bytes.byteLength,
				sha256: createHash('sha256').update(bytes).digest('hex')
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'INVALID_PATH') throw error;
		if (isMissing(error)) return { ...MISSING_STATUS };
		return { ...MISSING_STATUS, error: 'IO_ERROR' };
	}
}

function resultForState(
	state: DiagramBundleState,
	source: DiagramFileStatus,
	svg: DiagramFileStatus,
	pdf: DiagramFileStatus
): DiagramBundleStatus {
	return {
		state,
		source,
		svg,
		pdf,
		missing: state === 'missing',
		stale: state === 'stale',
		ready: state === 'ready',
		error: state === 'error'
	};
}

export async function diagramBundleStatus(root: string, sourceRelativePath: string): Promise<DiagramBundleStatus> {
	const sourcePath = assertDiagramRelativePath(sourceRelativePath, ['mmd', 'drawio']);
	const stem = sourcePath.replace(/\.(?:mmd|drawio)$/, '');
	let context: DiagramDirectory;
	try {
		context = await diagramDirectory(root, false);
	} catch (error) {
		if (error instanceof Error && error.message === 'DIAGRAM_NOT_FOUND') {
			return resultForState('missing', { ...MISSING_STATUS }, { ...MISSING_STATUS }, { ...MISSING_STATUS });
		}
		throw error;
	}

	const [source, svg, pdf] = await Promise.all([
		inspectFile(context.directory, sourcePath),
		inspectFile(context.directory, `${stem}.svg`),
		inspectFile(context.directory, `${stem}.pdf`)
	]);
	if (source.error || svg.error || pdf.error) return resultForState('error', source, svg, pdf);
	if (!source.exists) return resultForState('missing', source, svg, pdf);
	if (!svg.exists || !pdf.exists || source.mtimeMs > svg.mtimeMs || source.mtimeMs > pdf.mtimeMs) {
		return resultForState('stale', source, svg, pdf);
	}
	return resultForState('ready', source, svg, pdf);
}
