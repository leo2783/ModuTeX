import type {
	DiagramBundleState,
	DiagramBundleStatusResult,
	DiagramFileError,
	DiagramFileStatus,
	DiagramMarkerV1,
	DiagramNodeAttrs,
	DiagramPdfErrorCode,
	DiagramPdfCancelRequest,
	DiagramPdfCancelResult,
	DiagramPdfRequest,
	DiagramPdfResult,
	DiagramReadRequest,
	DiagramReadResult,
	DiagramRelinkRequest,
	DiagramRelinkResult,
	DiagramType,
	DiagramWriteRequest,
	Engine,
	ExistingEngine,
	FoldedSectionState
} from '../src/index';

const existingEngine = 'lualatex' satisfies ExistingEngine;
const engine = 'tectonic' satisfies Engine;
const type = 'mermaid' satisfies DiagramType;
const marker = {
	v: 1,
	id: '8a2d7f4b-3f52-4f4d-9cf0-d35650a421f1',
	type,
	source: 'assets/diagrams/overview-8a2d7f4b-3f52-4f4d-9cf0-d35650a421f1.mmd'
} satisfies DiagramMarkerV1;
const attrs = {
	diagramType: type,
	diagramId: marker.id,
	diagramSource: marker.source,
	src: 'assets/diagrams/overview-8a2d7f4b-3f52-4f4d-9cf0-d35650a421f1.pdf'
} satisfies DiagramNodeAttrs;
const pdfRequest = {
	requestId: '63e5fd80-3af3-4409-8a8f-19c3877aaf7c',
	sourceRelPath: marker.source,
	expectedSourceSha256: 'c'.repeat(64),
	svg: '<svg viewBox="0 0 1 1"></svg>'
} satisfies DiagramPdfRequest;
const pdfError = 'RENDER_FAILED' satisfies DiagramPdfErrorCode;
const pdfResult = { ok: false, errorCode: pdfError } satisfies DiagramPdfResult;
const publishedPdf = {
	ok: true,
	outputRelPath: attrs.src,
	svgRelPath: attrs.src.replace(/\.pdf$/, '.svg'),
	sourceSha256: pdfRequest.expectedSourceSha256,
	svgSha256: 'd'.repeat(64),
	pdfSha256: 'e'.repeat(64)
} satisfies DiagramPdfResult;
const cancelRequest = { requestId: pdfRequest.requestId } satisfies DiagramPdfCancelRequest;
const cancelResult = { cancelled: false } satisfies DiagramPdfCancelResult;
const writeRequest = { relativePath: marker.source, content: 'flowchart LR' } satisfies DiagramWriteRequest;
const readRequest = { relativePath: marker.source } satisfies DiagramReadRequest;
const readResult = { content: 'flowchart LR', sha256: 'a'.repeat(64), mtimeMs: 1, size: 12 } satisfies DiagramReadResult;
const relinkRequest = { type: 'drawio' } satisfies DiagramRelinkRequest;
const relinkResult = { ...readResult, relativePath: marker.source } satisfies DiagramRelinkResult;
const fileError = 'INVALID_FILE' satisfies DiagramFileError;
const fileStatus = { exists: false, mtimeMs: 0, error: fileError } satisfies DiagramFileStatus;
const bundleState = 'missing' satisfies DiagramBundleState;
const bundle = {
	state: bundleState,
	source: fileStatus,
	svg: { exists: false, mtimeMs: 0 },
	pdf: { exists: true, mtimeMs: 1, size: 100, sha256: 'b'.repeat(64) },
	missing: true,
	stale: false,
	ready: false,
	error: false
} satisfies DiagramBundleStatusResult;
const fold = {
	relativeFile: 'chapters/intro.tex',
	ancestorHeadingChain: ['Introduction'],
	level: 2,
	occurrence: 0,
	folded: true
} satisfies FoldedSectionState;

void [
	existingEngine,
	engine,
	marker,
	attrs,
	pdfRequest,
	pdfResult,
	publishedPdf,
	cancelRequest,
	cancelResult,
	writeRequest,
	readRequest,
	relinkRequest,
	relinkResult,
	bundle,
	fold
];

// @ts-expect-error only supported diagram types are accepted
const invalidType: DiagramType = 'plantuml';

const invalidRelink = {
	type: 'mermaid',
	// @ts-expect-error absolute workspace roots never cross this contract
	root: 'C:/workspaces/private'
} satisfies DiagramRelinkRequest;

void [invalidType, invalidRelink];

const rendererChosenOutput = {
	...pdfRequest,
	// @ts-expect-error only main may derive a publication destination
	outputRelPath: 'assets/diagrams/unrelated.pdf'
} satisfies DiagramPdfRequest;

// @ts-expect-error a source hash is mandatory for stale-source checks
const missingSourceHash: DiagramPdfRequest = { requestId: pdfRequest.requestId, sourceRelPath: marker.source, svg: pdfRequest.svg };

// @ts-expect-error staged data is not a successful publication
const incompleteSuccess: DiagramPdfResult = { ok: true, outputRelPath: attrs.src };

// @ts-expect-error a failure always has a stable error code
const incompleteFailure: DiagramPdfResult = { ok: false };

const crossSenderCancel = {
	...cancelRequest,
	// @ts-expect-error sender authority is never provided by the renderer
	senderId: 7
} satisfies DiagramPdfCancelRequest;

function publishedPath(result: DiagramPdfResult): string | null {
	if (result.ok) return result.outputRelPath;
	// @ts-expect-error failure has no purported output path
	void result.outputRelPath;
	return null;
}

void [rendererChosenOutput, missingSourceHash, incompleteSuccess, incompleteFailure, crossSenderCancel, publishedPath];
