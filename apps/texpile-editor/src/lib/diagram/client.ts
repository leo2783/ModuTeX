import type {
	DiagramBundleStatusResult,
	DiagramPdfCancelRequest,
	DiagramPdfCancelResult,
	DiagramPdfRequest,
	DiagramPdfResult,
	DiagramReadRequest,
	DiagramReadResult,
	DiagramRelinkRequest,
	DiagramRelinkResult,
	DiagramType,
	DiagramWriteRequest
} from 'modutex-contracts';
import { isSafeDiagramSource } from './marker';
import type { DiagramFigureAttrs } from './events';
export type { DiagramFigureAttrs } from './events';

export interface DiagramBridge {
	diagramRead(request: DiagramReadRequest): Promise<DiagramReadResult>;
	diagramStatus(request: DiagramReadRequest): Promise<DiagramBundleStatusResult>;
	diagramWrite(request: DiagramWriteRequest): Promise<unknown>;
	diagramRelink(request: DiagramRelinkRequest): Promise<DiagramRelinkResult | null>;
	diagramRenderPdf(request: DiagramPdfRequest): Promise<DiagramPdfResult>;
	diagramCancelPdf?(request: DiagramPdfCancelRequest): Promise<DiagramPdfCancelResult>;
	diagramPrepareDrawioVector?(request: { xml: string }): Promise<{ xml: string }>;
}

export interface DiagramPdfReceipt {
	outputRelPath: string;
	svgRelPath: string;
	sourceSha256: string;
	svgSha256: string;
	pdfSha256: string;
}

export interface DiagramPublishOptions {
	/** Aborted when the canvas closes or its document/workspace identity changes. */
	signal?: AbortSignal;
	/** Allows the caller to cancel exactly this native render request. */
	requestId?: string;
	timeoutMs?: number;
}

export type DiagramRelinkBridge = Pick<DiagramBridge, 'diagramRelink'>;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SOURCE = new RegExp(`^assets/diagrams/[a-z0-9]+(?:-[a-z0-9]+)*-(${UUID_SOURCE})\\.(mmd|drawio)$`);
const SHA256 = /^[0-9a-f]{64}$/;

function parseRelinkResult(type: DiagramType, value: unknown): DiagramRelinkResult & { id: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RELINK_RESULT');
	const result = value as Record<string, unknown>;
	if (Object.keys(result).sort().join(',') !== 'content,mtimeMs,relativePath,sha256,size') {
		throw new Error('INVALID_RELINK_RESULT');
	}
	const match = typeof result.relativePath === 'string' ? SOURCE.exec(result.relativePath) : null;
	const expectedExtension = type === 'mermaid' ? 'mmd' : 'drawio';
	if (
		!match ||
		match[2] !== expectedExtension ||
		typeof result.content !== 'string' ||
		result.content.length === 0 ||
		typeof result.sha256 !== 'string' ||
		!SHA256.test(result.sha256) ||
		typeof result.mtimeMs !== 'number' ||
		!Number.isFinite(result.mtimeMs) ||
		result.mtimeMs < 0 ||
		typeof result.size !== 'number' ||
		!Number.isSafeInteger(result.size) ||
		result.size <= 0 ||
		new TextEncoder().encode(result.content).byteLength !== result.size
	) {
		throw new Error('INVALID_RELINK_RESULT');
	}
	return { ...(result as unknown as DiagramRelinkResult), id: match[1]! };
}

function nativeApi(): Partial<DiagramBridge> {
	if (typeof window === 'undefined') return {};
	return (window as unknown as { texpileNative?: Partial<DiagramBridge> }).texpileNative ?? {};
}

function nativeMethod<K extends keyof DiagramBridge>(name: K, unavailable: string): NonNullable<DiagramBridge[K]> {
	const api = nativeApi();
	const method = api[name];
	if (typeof method !== 'function') throw new Error(unavailable);
	return method.bind(api) as NonNullable<DiagramBridge[K]>;
}

function nativeRelinkBridge(): DiagramRelinkBridge {
	return { diagramRelink: nativeMethod('diagramRelink', 'DIAGRAM_RELINK_UNAVAILABLE') };
}

export async function relinkDiagram(
	type: DiagramType,
	bridge: DiagramRelinkBridge = nativeRelinkBridge(),
	timeoutMs = 20_000
): Promise<DiagramRelinkResult | null> {
	const result = await withDeadline(bridge.diagramRelink({ type }), timeoutMs, 'DIAGRAM_RELINK_TIMEOUT');
	if (result === null) return null;
	const { id: _id, ...validated } = parseRelinkResult(type, result);
	return validated;
}

function assertSafeSourcePath(relativePath: string): { id: string; type: DiagramType } {
	const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(mmd|drawio)$/.exec(relativePath);
	const type: DiagramType | null = match?.[2] === 'mmd' ? 'mermaid' : match?.[2] === 'drawio' ? 'drawio' : null;
	if (!match || !type || !isSafeDiagramSource(relativePath, type, match[1]!)) throw new Error('INVALID_DIAGRAM_SOURCE');
	return { id: match[1]!, type };
}

export function diagramOutputPaths(source: string): { svg: string; pdf: string } {
	assertSafeSourcePath(source);
	const stem = source.replace(/\.(?:mmd|drawio)$/, '');
	return { svg: `${stem}.svg`, pdf: `${stem}.pdf` };
}

export function diagramIdFromSource(relativePath: string, extension: 'mmd' | 'drawio'): string {
	const parsed = assertSafeSourcePath(relativePath);
	if (relativePath.endsWith(`.${extension}`) && parsed.type === (extension === 'mmd' ? 'mermaid' : 'drawio')) return parsed.id;
	throw new Error('INVALID_DIAGRAM_SOURCE');
}

export async function readDiagramSource(relativePath: string, timeoutMs = 15_000): Promise<DiagramReadResult> {
	const type = assertSafeSourcePath(relativePath).type;
	const result = await withDeadline(
		nativeMethod('diagramRead', 'DIAGRAM_READ_UNAVAILABLE')({ relativePath }),
		timeoutMs,
		'DIAGRAM_READ_TIMEOUT'
	);
	validateReadResult(result);
	const limit = type === 'mermaid' ? 1024 * 1024 : 10 * 1024 * 1024;
	if (result.size > limit) throw new Error('PAYLOAD_TOO_LARGE');
	return result;
}

export async function diagramStatus(relativePath: string, timeoutMs = 15_000): Promise<DiagramBundleStatusResult> {
	assertSafeSourcePath(relativePath);
	const result = await withDeadline(
		nativeMethod('diagramStatus', 'DIAGRAM_STATUS_UNAVAILABLE')({ relativePath }),
		timeoutMs,
		'DIAGRAM_STATUS_TIMEOUT'
	);
	if (!isPlainRecord(result) || !['error', 'missing', 'ready', 'stale'].includes(String(result.state)))
		throw new Error('INVALID_DIAGRAM_STATUS');
	for (const field of ['missing', 'stale', 'ready', 'error']) {
		if (typeof result[field] !== 'boolean') throw new Error('INVALID_DIAGRAM_STATUS');
	}
	for (const field of ['source', 'svg', 'pdf']) {
		const file = result[field];
		if (!isPlainRecord(file) || typeof file.exists !== 'boolean') throw new Error('INVALID_DIAGRAM_STATUS');
		if (
			file.exists &&
			(typeof file.sha256 !== 'string' || !HASH_RE.test(file.sha256) || !Number.isSafeInteger(file.size) || typeof file.size !== 'number')
		) {
			throw new Error('INVALID_DIAGRAM_STATUS');
		}
	}
	return result as unknown as DiagramBundleStatusResult;
}

export function relinkDiagramSource(type: DiagramType): Promise<DiagramRelinkResult | null> {
	return relinkDiagram(type);
}

export async function saveDiagramBundle(
	sourceRelPath: string,
	source: string,
	svg: string,
	options: DiagramPublishOptions | number = {}
): Promise<DiagramPdfReceipt> {
	const type = assertSafeSourcePath(sourceRelPath).type;
	const sourceLimit = type === 'drawio' ? 10 * 1024 * 1024 : 1024 * 1024;
	const sourceBytes = new TextEncoder().encode(source).byteLength;
	if (sourceBytes === 0 || sourceBytes > sourceLimit) throw new Error(sourceBytes === 0 ? 'INVALID_DIAGRAM_SOURCE' : 'PAYLOAD_TOO_LARGE');
	if (new TextEncoder().encode(svg).byteLength > 25 * 1024 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
	if (!/^<svg(?:\s[^>]*|\/?)>/i.test(svg.trimStart().replace(/^\uFEFF/, ''))) throw new Error('INVALID_SVG');
	const normalizedOptions = typeof options === 'number' ? { timeoutMs: options } : options;
	const timeoutMs = normalizedOptions.timeoutMs ?? 30_000;
	const signal = normalizedOptions.signal;
	assertNotAborted(signal);

	// The renderer supplies only the authored source path. The native process publishes both
	// sidecars from that path after it re-reads and hashes the saved source.
	const write = nativeMethod('diagramWrite', 'DIAGRAM_WRITE_UNAVAILABLE');
	const read = nativeMethod('diagramRead', 'DIAGRAM_READ_UNAVAILABLE');
	const renderPdf = nativeMethod('diagramRenderPdf', 'DIAGRAM_PDF_UNAVAILABLE');
	const cancelPdf = nativeMethod('diagramCancelPdf', 'DIAGRAM_CANCEL_UNAVAILABLE');
	const written = await withAbortDeadline(
		Promise.resolve().then(() => write({ relativePath: sourceRelPath, content: source })),
		timeoutMs,
		'DIAGRAM_WRITE_TIMEOUT',
		signal
	);
	const savedHash = validateWriteResult(written, sourceBytes);
	assertNotAborted(signal);

	const saved = await withAbortDeadline(
		Promise.resolve().then(() => read({ relativePath: sourceRelPath })),
		timeoutMs,
		'DIAGRAM_READ_TIMEOUT',
		signal
	);
	validateReadResult(saved);
	if (saved.content !== source || saved.sha256 !== savedHash) throw new Error('DIAGRAM_SOURCE_CHANGED');
	assertNotAborted(signal);

	const requestId = normalizedOptions.requestId ?? crypto.randomUUID();
	if (!UUID_RE.test(requestId)) throw new Error('INVALID_REQUEST_ID');
	let renderStarted = false;
	try {
		renderStarted = true;
		const result = await withAbortDeadline(
			Promise.resolve().then(() =>
				renderPdf({
					requestId,
					sourceRelPath,
					expectedSourceSha256: savedHash,
					svg
				})
			),
			timeoutMs,
			'RENDER_TIMEOUT',
			signal
		);
		const receipt = validatePdfReceipt(sourceRelPath, savedHash, result);
		if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('texpile:fs-changed'));
		return receipt;
	} catch (error) {
		if (renderStarted && (signal?.aborted || (error instanceof Error && error.message === 'RENDER_TIMEOUT'))) {
			await cancelDiagramPdf(cancelPdf, requestId);
		}
		throw error;
	}
}

/** Calls the native, memory-only Draw.io transformer; the returned XML is never persisted here. */
export async function prepareDrawioVectorCopy(xml: string, timeoutMs = 10_000): Promise<string> {
	const bytes = new TextEncoder().encode(xml).byteLength;
	if (bytes === 0 || bytes > 10 * 1024 * 1024) throw new Error(bytes === 0 ? 'INVALID_DRAWIO_XML' : 'PAYLOAD_TOO_LARGE');
	if (
		!/^<(?:mxfile|mxGraphModel)(?:\s|>)/i.test(
			xml
				.trimStart()
				.replace(/^\uFEFF/, '')
				.replace(/^<\?xml\s+[^?]*\?>\s*/i, '')
		)
	)
		throw new Error('INVALID_DRAWIO_XML');
	const prepare = nativeMethod('diagramPrepareDrawioVector', 'DIAGRAM_VECTOR_UNAVAILABLE');
	const prepared = await withDeadline(prepare({ xml }), timeoutMs, 'DIAGRAM_VECTOR_TIMEOUT');
	if (!prepared || typeof prepared !== 'object' || typeof prepared.xml !== 'string' || prepared.xml.length === 0) {
		throw new Error('INVALID_DRAWIO_VECTOR_RESULT');
	}
	if (new TextEncoder().encode(prepared.xml).byteLength > 10 * 1024 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
	return prepared.xml;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

function validateWriteResult(value: unknown, expectedBytes: number): string {
	if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== 'sha256,size') throw new Error('INVALID_DIAGRAM_WRITE_RESULT');
	if (typeof value.sha256 !== 'string' || !HASH_RE.test(value.sha256) || value.size !== expectedBytes) {
		throw new Error('INVALID_DIAGRAM_WRITE_RESULT');
	}
	return value.sha256;
}

function validateReadResult(value: unknown): asserts value is DiagramReadResult {
	if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== 'content,mtimeMs,sha256,size')
		throw new Error('INVALID_DIAGRAM_READ_RESULT');
	if (
		typeof value.content !== 'string' ||
		typeof value.sha256 !== 'string' ||
		!HASH_RE.test(value.sha256) ||
		typeof value.mtimeMs !== 'number' ||
		!Number.isFinite(value.mtimeMs) ||
		value.mtimeMs < 0 ||
		typeof value.size !== 'number' ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0 ||
		new TextEncoder().encode(value.content).byteLength !== value.size
	) {
		throw new Error('INVALID_DIAGRAM_READ_RESULT');
	}
}

function validatePdfReceipt(sourceRelPath: string, sourceSha256: string, value: DiagramPdfResult): DiagramPdfReceipt {
	if (!isPlainRecord(value)) throw new Error('INVALID_DIAGRAM_PDF_RESULT');
	if (value.ok === false) {
		if (Object.keys(value).sort().join(',') !== 'errorCode,ok' || typeof value.errorCode !== 'string') {
			throw new Error('INVALID_DIAGRAM_PDF_RESULT');
		}
		throw new Error(value.errorCode);
	}
	const expected = diagramOutputPaths(sourceRelPath);
	if (
		value.ok !== true ||
		Object.keys(value).sort().join(',') !== 'ok,outputRelPath,pdfSha256,sourceSha256,svgRelPath,svgSha256' ||
		value.outputRelPath !== expected.pdf ||
		value.svgRelPath !== expected.svg ||
		value.sourceSha256 !== sourceSha256 ||
		typeof value.svgSha256 !== 'string' ||
		!HASH_RE.test(value.svgSha256) ||
		typeof value.pdfSha256 !== 'string' ||
		!HASH_RE.test(value.pdfSha256)
	) {
		throw new Error('INVALID_DIAGRAM_PDF_RESULT');
	}
	return {
		outputRelPath: value.outputRelPath,
		svgRelPath: value.svgRelPath,
		sourceSha256: value.sourceSha256,
		svgSha256: value.svgSha256,
		pdfSha256: value.pdfSha256
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('DIAGRAM_ABORTED');
}

function withAbortDeadline<T>(operation: PromiseLike<T>, timeoutMs: number, timeoutCode: string, signal?: AbortSignal): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('INVALID_TIMEOUT'));
	if (signal?.aborted) return Promise.reject(new Error('DIAGRAM_ABORTED'));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = () => finish(() => reject(new Error('DIAGRAM_ABORTED')));
		const timer = setTimeout(() => finish(() => reject(new Error(timeoutCode))), timeoutMs);
		signal?.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(operation).then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error))
		);
	});
}

async function cancelDiagramPdf(
	cancel: (request: DiagramPdfCancelRequest) => Promise<DiagramPdfCancelResult>,
	requestId: string
): Promise<void> {
	try {
		await withDeadline(cancel({ requestId }), 5_000, 'DIAGRAM_CANCEL_TIMEOUT');
	} catch {
		// The render's original error is authoritative. A late cancel cannot turn it into success.
	}
}

/** Bounds a renderer wait; after a timeout callers must not retry the same live operation. */
export async function withDeadline<T>(operation: PromiseLike<T>, timeoutMs: number, timeoutCode: string): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_TIMEOUT');
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs);
			})
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Cancel is an identity operation; a successful relink preserves every ordinary figure attribute. */
export function applyDiagramRelink(attrs: DiagramFigureAttrs, type: DiagramType, result: DiagramRelinkResult | null): DiagramFigureAttrs {
	if (result === null) return attrs;
	const validated = parseRelinkResult(type, result);
	return {
		...attrs,
		src: validated.relativePath.replace(/\.(?:mmd|drawio)$/, '.pdf'),
		diagramType: type,
		diagramId: validated.id,
		diagramSource: validated.relativePath
	};
}

/** Removes only ModuTeX diagram metadata; the existing figure/PDF and its presentation remain untouched. */
export function convertDiagramToRegularImage(attrs: DiagramFigureAttrs): DiagramFigureAttrs {
	return { ...attrs, diagramType: null, diagramId: null, diagramSource: null };
}

/** Keep-raw is deliberately byte-preserving; parsing or formatting belongs to explicit editor actions. */
export function preserveRawDiagram(raw: string): string {
	return raw;
}
