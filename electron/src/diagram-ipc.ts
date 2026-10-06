import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { DiagramRelinkRequest, DiagramRelinkResult, DiagramPdfResult, DiagramPdfErrorCode } from 'modutex-contracts';
import {
	DIAGRAM_DIR,
	assertDiagramRelativePath,
	DRAWIO_SOURCE_LIMIT,
	MERMAID_SOURCE_LIMIT,
	DIAGRAM_OUTPUT_LIMIT
} from './diagram-security';
import { readDiagram, atomicWriteDiagram } from './diagram-service';
import { DiagramSvgError } from './diagram-svg';
import { diagramCpu, type DiagramCpu } from './diagram-cpu';
import { recoverDiagramPublication, publishedDiagramStatus, publishDiagramPair, withDiagramPublicationLock } from './diagram-publication';

export const DIAGRAM_RELINK_CHANNEL = 'diagram:relink';

export interface DiagramPickerOptions {
	defaultPath: string;
	extensions: readonly ['mmd'] | readonly ['drawio'];
	parent?: unknown;
}

export interface DiagramPickerResult {
	canceled: boolean;
	filePaths: string[];
}

export interface DiagramRelinkEvent {
	sender: { id: number };
}

export interface DiagramIpcRegistrar {
	handle(channel: string, handler: (event: DiagramRelinkEvent, request: unknown) => Promise<unknown>): void;
}

export interface DiagramRelinkDependencies {
	workspaceForSender(senderId: number): string | null;
	pickFile(options: DiagramPickerOptions): Promise<DiagramPickerResult>;
	parentForSender?(sender: DiagramRelinkEvent['sender']): unknown;
}

export interface DiagramRelinkRegistrationDependencies extends DiagramRelinkDependencies {
	registrar: DiagramIpcRegistrar;
}

const SAFE_ERRORS = new Set([
	'DIAGRAM_NOT_FOUND',
	'DIAGRAM_READ_FAILED',
	'EMPTY_SOURCE',
	'INVALID_FILE',
	'INVALID_PATH',
	'INVALID_REQUEST',
	'INVALID_WORKSPACE',
	'PAYLOAD_TOO_LARGE',
	'WORKSPACE_NOT_CLAIMED'
]);

function rethrowSafe(error: unknown): never {
	if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw new Error(error.message);
	throw new Error('DIAGRAM_READ_FAILED');
}

function parseRequest(value: unknown): DiagramRelinkRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || (record.type !== 'mermaid' && record.type !== 'drawio')) {
		throw new Error('INVALID_REQUEST');
	}
	return { type: record.type };
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalDirectory(root: string): Promise<string> {
	if (!path.isAbsolute(root)) throw new Error('INVALID_WORKSPACE');
	try {
		const canonical = await realpath(root);
		if (!(await lstat(canonical)).isDirectory()) throw new Error('INVALID_WORKSPACE');
		return canonical;
	} catch (error) {
		if (error instanceof Error && error.message === 'INVALID_WORKSPACE') throw error;
		throw new Error('INVALID_WORKSPACE');
	}
}

/**
 * Creates the production-safe handler without importing Electron at test runtime. The only fakeable
 * edge is the native picker host; all path and file checks use the real filesystem services.
 */
export function createDiagramRelinkHandler(
	dependencies: DiagramRelinkDependencies
): (event: DiagramRelinkEvent, request: unknown) => Promise<DiagramRelinkResult | null> {
	return async (event, untrustedRequest) => {
		try {
			const request = parseRequest(untrustedRequest);
			const claimedRoot = dependencies.workspaceForSender(event.sender.id);
			if (!claimedRoot) throw new Error('WORKSPACE_NOT_CLAIMED');
			const root = await canonicalDirectory(claimedRoot);
			const extension = request.type === 'mermaid' ? 'mmd' : 'drawio';
			const picked = await dependencies.pickFile({
				defaultPath: path.join(root, ...DIAGRAM_DIR.split('/')),
				extensions: [extension],
				parent: dependencies.parentForSender?.(event.sender)
			});
			if (picked.canceled || picked.filePaths.length === 0) return null;
			if (picked.filePaths.length !== 1 || !path.isAbsolute(picked.filePaths[0]!)) throw new Error('INVALID_PATH');

			let selected: string;
			try {
				selected = await realpath(picked.filePaths[0]!);
				if (!(await lstat(selected)).isFile()) throw new Error('INVALID_PATH');
			} catch (error) {
				if (error instanceof Error && error.message === 'INVALID_PATH') throw error;
				throw new Error('INVALID_PATH');
			}
			if (!isContained(root, selected)) throw new Error('INVALID_PATH');

			const relativePath = path.relative(root, selected).split(path.sep).join('/');
			const safeRelativePath = assertDiagramRelativePath(relativePath, [extension]);
			const result = await readDiagram(root, safeRelativePath);
			if (result.size === 0 || result.content.length === 0) throw new Error('EMPTY_SOURCE');
			return { relativePath: safeRelativePath, ...result };
		} catch (error) {
			rethrowSafe(error);
		}
	};
}

/** Registered by the dedicated production-wiring issue; this module never accepts a workspace root from renderer input. */
export function registerDiagramRelinkIpc(dependencies: DiagramRelinkRegistrationDependencies): void {
	dependencies.registrar.handle(DIAGRAM_RELINK_CHANNEL, createDiagramRelinkHandler(dependencies));
}

export interface DiagramWorkspaceLease {
	root: string;
	generation: number;
	assertCurrent(): void;
}
export interface DiagramNativeDependencies {
	registrar: DiagramIpcRegistrar;
	authorize(event: DiagramRelinkEvent): DiagramWorkspaceLease;
	render(svg: string, signal: AbortSignal): Promise<{ pdf: Uint8Array; widthPx: number; heightPx: number }>;
	cpu?: DiagramCpu;
	/** Native-only negative fault adapter; no renderer payload controls filesystem operations. */
	publicationUnlink?: typeof import('node:fs/promises').unlink;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
		throw new Error('INVALID_REQUEST');
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(value).length !== keys.length ||
		keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value')) ||
		Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
	)
		throw new Error('INVALID_REQUEST');
	return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
	if (typeof value !== 'string' || value.length > limit || Buffer.byteLength(value, 'utf8') > limit) throw new Error('INVALID_REQUEST');
	return value;
}
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_HASH = /^[a-f0-9]{64}$/;
function nativeError(error: unknown): DiagramPdfErrorCode {
	if (error instanceof DiagramSvgError) return 'SVG_REJECTED';
	const code = error instanceof Error ? error.message : '';
	const known: DiagramPdfErrorCode[] = [
		'INVALID_REQUEST',
		'INVALID_PATH',
		'UNTRUSTED_SENDER',
		'STALE_WORKSPACE',
		'REQUEST_ALREADY_RUNNING',
		'SOURCE_CHANGED',
		'RENDER_TIMEOUT',
		'RENDER_ABORTED',
		'RENDER_FAILED',
		'WRITE_FAILED'
	];
	if (known.includes(code as DiagramPdfErrorCode)) return code as DiagramPdfErrorCode;
	if (code === 'DIAGRAM_NOT_FOUND') return 'SOURCE_NOT_FOUND';
	if (code === 'PAYLOAD_TOO_LARGE') return 'SOURCE_TOO_LARGE';
	return 'WRITE_FAILED';
}
/** All authority comes from the native host lease; no renderer root/output path is accepted. */
export function registerDiagramNativeIpc(dependencies: DiagramNativeDependencies): { invalidate(senderId: number): void } {
	const cpu = dependencies.cpu ?? diagramCpu;
	const preparing = new Map<number, Set<AbortController>>();
	const active = new Map<number, { id: string; controller: AbortController; phase: 'preparing' | 'committed' }>();
	const seen = new Map<number, { generation: number; ids: Set<string> }>();
	const readSafe = (lease: DiagramWorkspaceLease, relative: string) =>
		withDiagramPublicationLock(lease.root, relative, async () => {
			lease.assertCurrent();
			await recoverDiagramPublication(lease.root, relative);
			const result = await readDiagram(lease.root, relative);
			lease.assertCurrent();
			return result;
		});
	for (const action of ['read', 'write', 'status'] as const) {
		dependencies.registrar.handle(`diagram:${action}`, async (event, payload) => {
			try {
				const lease = dependencies.authorize(event);
				const request = exact(payload, action === 'write' ? ['relativePath', 'content'] : ['relativePath']);
				const relative = assertDiagramRelativePath(request.relativePath, ['mmd', 'drawio']);
				if (action === 'read') return await readSafe(lease, relative);
				if (action === 'status') {
					const result = await publishedDiagramStatus(lease.root, relative);
					lease.assertCurrent();
					return result;
				}
				const content = text(request.content, relative.endsWith('.mmd') ? MERMAID_SOURCE_LIMIT : DRAWIO_SOURCE_LIMIT);
				return await withDiagramPublicationLock(lease.root, relative, async () => {
					lease.assertCurrent();
					await recoverDiagramPublication(lease.root, relative);
					const result = await atomicWriteDiagram(lease.root, relative, content, async () => lease.assertCurrent());
					lease.assertCurrent();
					return result;
				});
			} catch (error) {
				throw new Error(nativeError(error));
			}
		});
	}
	dependencies.registrar.handle('diagram:prepare-drawio-vector', async (event, payload) => {
		const controller = new AbortController();
		let owned: Set<AbortController> | undefined;
		try {
			const lease = dependencies.authorize(event);
			const request = exact(payload, ['xml']);
			owned = preparing.get(event.sender.id) ?? new Set();
			preparing.set(event.sender.id, owned);
			owned.add(controller);
			const result = await cpu.prepare(text(request.xml, DRAWIO_SOURCE_LIMIT), controller.signal);
			lease.assertCurrent();
			return result;
		} catch (error) {
			throw new Error(nativeError(error));
		} finally {
			owned?.delete(controller);
			if (owned?.size === 0 && preparing.get(event.sender.id) === owned) preparing.delete(event.sender.id);
		}
	});
	dependencies.registrar.handle('diagram:cancel-pdf', async (event, payload) => {
		try {
			dependencies.authorize(event).assertCurrent();
			const request = exact(payload, ['requestId']);
			if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) throw new Error('INVALID_REQUEST');
			const operation = active.get(event.sender.id);
			if (!operation || operation.id !== request.requestId || operation.controller.signal.aborted || operation.phase === 'committed')
				return { cancelled: false };
			operation.controller.abort();
			return { cancelled: true };
		} catch (error) {
			throw new Error(nativeError(error));
		}
	});
	dependencies.registrar.handle('diagram:render-pdf', async (event, payload): Promise<DiagramPdfResult> => {
		let operation: { id: string; controller: AbortController; phase: 'preparing' | 'committed' } | undefined;
		try {
			const lease = dependencies.authorize(event);
			const request = exact(payload, ['requestId', 'sourceRelPath', 'expectedSourceSha256', 'svg']);
			if (
				typeof request.requestId !== 'string' ||
				!REQUEST_ID.test(request.requestId) ||
				typeof request.expectedSourceSha256 !== 'string' ||
				!SOURCE_HASH.test(request.expectedSourceSha256)
			)
				throw new Error('INVALID_REQUEST');
			const source = assertDiagramRelativePath(request.sourceRelPath, ['mmd', 'drawio']);
			const svg = text(request.svg, DIAGRAM_OUTPUT_LIMIT);
			let history = seen.get(event.sender.id);
			if (!history || history.generation !== lease.generation) {
				history = { generation: lease.generation, ids: new Set() };
				seen.set(event.sender.id, history);
			}
			if (active.has(event.sender.id) || history.ids.has(request.requestId) || history.ids.size >= 10_000)
				throw new Error('REQUEST_ALREADY_RUNNING');
			history.ids.add(request.requestId);
			operation = { id: request.requestId, controller: new AbortController(), phase: 'preparing' };
			active.set(event.sender.id, operation);
			const signal = operation.controller.signal;
			const commitGuard = () => {
				lease.assertCurrent();
				if (signal.aborted) throw new Error('RENDER_ABORTED');
			};
			const checkpoint = async () => commitGuard();
			await checkpoint();
			const saved = await readSafe(lease, source);
			if (saved.sha256 !== request.expectedSourceSha256) throw new Error('SOURCE_CHANGED');
			const validated = source.endsWith('.drawio') ? await cpu.normalize(svg, signal) : await cpu.validate(svg, signal);
			await checkpoint();
			const rendered = await dependencies.render(validated.svg, signal);
			await checkpoint();
			if ((await readSafe(lease, source)).sha256 !== saved.sha256) throw new Error('SOURCE_CHANGED');
			const receipt = await publishDiagramPair(lease.root, source, saved.sha256, validated.svg, rendered.pdf, checkpoint, undefined, {
				commitGuard,
				onCommitted: () => {
					operation!.phase = 'committed';
				},
				unlinkFile: dependencies.publicationUnlink
			});
			// Cleanup may have yielded to a workspace change. Check synchronously and
			// return in the same turn; never acknowledge success to the old lease.
			lease.assertCurrent();
			const stem = source.replace(/\.(mmd|drawio)$/, '');
			return {
				ok: true,
				outputRelPath: `${stem}.pdf`,
				svgRelPath: `${stem}.svg`,
				sourceSha256: receipt.sourceSha256,
				svgSha256: receipt.svgSha256,
				pdfSha256: receipt.pdfSha256
			};
		} catch (error) {
			return { ok: false, errorCode: nativeError(error) };
		} finally {
			if (operation && active.get(event.sender.id) === operation) active.delete(event.sender.id);
		}
	});
	return {
		invalidate(senderId) {
			for (const controller of preparing.get(senderId) ?? []) controller.abort();
			preparing.delete(senderId);
			const operation = active.get(senderId);
			if (operation?.phase === 'preparing') operation.controller.abort();
			seen.delete(senderId);
		}
	};
}
