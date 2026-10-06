/** TypeScript contracts do not replace runtime validation of untrusted IPC payloads. */

/** Debounced disk change; old bridges may omit the payload and require a full refresh. */
export type WorkspaceFsChange = { kind: 'project-state'; changedPaths: string[] } | { kind: 'workspace' };

export type ExistingEngine = 'pdflatex' | 'lualatex' | 'xelatex';
export type Engine = ExistingEngine | 'tectonic';

/** Runtime-validated native compile request; all other execution paths are main-owned. */
export interface ManagedCompileRequest {
	engine: Extract<Engine, 'tectonic'>;
	mainFile: string;
}
export type ManagedCompileError =
	| 'INVALID_REQUEST'
	| 'UNTRUSTED_SENDER'
	| 'STALE_WORKSPACE'
	| 'INVALID_PATH'
	| 'BUSY'
	| 'ENGINE_UNAVAILABLE'
	| 'COMPILE_FAILED'
	/** Legacy result from older desktop bridges; automatic downloads no longer emit it. */
	| 'DOWNLOAD_DECLINED'
	| 'CANCELLED'
	| 'TIMEOUT'
	| 'INVALID_PDF'
	| 'PUBLICATION_FAILED';
export type ManagedCompileResult =
	| { ok: true; engine: 'tectonic'; pdfPath: string; logPath: string; stdout: string }
	| { ok: false; error: ManagedCompileError; stdout: string; logPath?: string };

export type DiagramType = 'mermaid' | 'drawio';

export interface DiagramMarkerV1 {
	v: 1;
	id: string;
	type: DiagramType;
	source: string;
}

export interface DiagramNodeAttrs {
	diagramType?: DiagramType;
	diagramId?: string;
	diagramSource?: string;
	src: string;
	caption?: string;
	label?: string;
	width?: string;
}

export interface DiagramPdfRequest {
	/** UUID of one operation, scoped to its main-frame sender and workspace generation. */
	requestId: string;
	sourceRelPath: string;
	/** Lowercase SHA-256 of the saved source used to produce this SVG. */
	expectedSourceSha256: string;
	/** Renderer-produced SVG; Electron validates it before rendering. */
	svg: string;
}

export type DiagramPdfErrorCode =
	| 'INVALID_REQUEST'
	| 'INVALID_PATH'
	| 'UNTRUSTED_SENDER'
	| 'STALE_WORKSPACE'
	| 'REQUEST_ALREADY_RUNNING'
	| 'SOURCE_NOT_FOUND'
	| 'SOURCE_TOO_LARGE'
	| 'SOURCE_CHANGED'
	| 'SVG_REJECTED'
	| 'RENDER_TIMEOUT'
	| 'RENDER_ABORTED'
	| 'RENDER_FAILED'
	| 'WRITE_FAILED';

/** Success describes actual published files, never a merely rendered or staged buffer. */
export type DiagramPdfResult =
	| {
			ok: true;
			/** Main derives both paths from the validated source stem. */
			outputRelPath: string;
			svgRelPath: string;
			sourceSha256: string;
			svgSha256: string;
			pdfSha256: string;
	  }
	| { ok: false; errorCode: DiagramPdfErrorCode };

export interface DiagramPdfCancelRequest {
	/** Cancellation cannot name another sender, workspace, or file. */
	requestId: string;
}

export interface DiagramPdfCancelResult {
	/** True only if a matching live operation owned by this sender was cancelled. */
	cancelled: boolean;
}

export interface DiagramWriteRequest {
	relativePath: string;
	content: string;
}

export interface DiagramReadRequest {
	relativePath: string;
}

export interface DiagramReadResult {
	content: string;
	sha256: string;
	mtimeMs: number;
	size: number;
}

export interface DiagramRelinkRequest {
	type: DiagramType;
}

export interface DiagramRelinkResult extends DiagramReadResult {
	relativePath: string;
}

export type DiagramFileError = 'INVALID_FILE' | 'IO_ERROR' | 'PAYLOAD_TOO_LARGE';

export interface DiagramFileStatus {
	exists: boolean;
	mtimeMs: number;
	size?: number;
	sha256?: string;
	error?: DiagramFileError;
}

export type DiagramBundleState = 'missing' | 'stale' | 'ready' | 'error';

export interface DiagramBundleStatusResult {
	state: DiagramBundleState;
	source: DiagramFileStatus;
	svg: DiagramFileStatus;
	pdf: DiagramFileStatus;
	missing: boolean;
	stale: boolean;
	ready: boolean;
	error: boolean;
}

export interface FoldedSectionState {
	relativeFile: string;
	ancestorHeadingChain: string[];
	level: number;
	occurrence: number;
	folded: boolean;
}
