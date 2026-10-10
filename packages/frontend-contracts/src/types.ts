// Original ModuTeX implementation. License pending provenance review.
export interface FileRef {
	readonly workspaceId: string;
	readonly path: string;
}
export interface WorkspaceInfo {
	readonly id: string;
	readonly label: string;
	readonly entryPath: string | null;
}
export interface RecentDocument {
	readonly id: string;
	readonly label: string;
	readonly entryPath: string | null;
	readonly openedAt: number;
}
export interface FileEntry {
	readonly path: string;
	readonly kind: 'file' | 'directory';
}
export interface ReadReceipt extends FileRef {
	readonly bytes: Uint8Array;
	readonly revision: string;
}
export interface WriteRequest extends FileRef {
	readonly bytes: Uint8Array;
	readonly expectedRevision: string | null;
	readonly documentId: string;
	readonly documentVersion: number;
}
export interface WriteReceipt extends FileRef {
	readonly revision: string;
	readonly documentId: string;
	readonly documentVersion: number;
}
export interface SaveAsRequest {
	readonly workspaceId: string | null;
	readonly bytes: Uint8Array;
	readonly documentId: string;
	readonly documentVersion: number;
}
export interface SaveAsReceipt {
	readonly workspace: WorkspaceInfo;
	readonly write: WriteReceipt;
}
export interface FileEvent extends FileRef {
	readonly kind: 'changed' | 'removed';
}
export type FileWatchFailure =
	| 'TREE_TOO_DEEP'
	| 'TREE_TOO_LARGE'
	| 'STALE_WORKSPACE'
	| 'LINK_NOT_ALLOWED'
	| 'FILE_OPERATION_FAILED';
export interface CompileIdentity {
	readonly runId: string;
	readonly workspaceId: string;
	readonly entryPath: string;
	readonly documentId: string;
	readonly documentVersion: number;
	readonly savedRevision: string;
}
export type CompileRequest = Omit<CompileIdentity, 'runId'> & { readonly engine: 'managed' | 'system' };
export interface Diagnostic {
	readonly severity: 'error' | 'warning' | 'info';
	readonly message: string;
	readonly path: string | null;
	readonly line: number | null;
	readonly column: number | null;
}
export type CompileResult =
	| {
			readonly status: 'success';
			readonly identity: CompileIdentity;
			readonly pdf: Uint8Array;
			readonly log: string;
			readonly diagnostics: readonly Diagnostic[];
	  }
	| {
			readonly status: 'failure' | 'cancelled';
			readonly identity: CompileIdentity;
			readonly log: string;
			readonly diagnostics: readonly Diagnostic[];
	  };
export interface CompileHandle {
	readonly identity: CompileIdentity;
	readonly finished: Promise<CompileResult>;
	cancel(): Promise<void>;
}
export type Unsubscribe = () => void;

// Single platform seam. It declares no fake host and exposes no raw IPC,
// executable paths, shell arguments, remote URL, or networking permission.
export interface DesktopPort {
	openWorkspace(kind: 'folder' | 'file'): Promise<WorkspaceInfo | null>;
	listRecent(): Promise<readonly RecentDocument[]>;
	openRecent(id: string): Promise<WorkspaceInfo>;
	removeRecent(id: string): Promise<void>;
	listFiles(workspaceId: string): Promise<readonly FileEntry[]>;
	readFile(file: FileRef): Promise<ReadReceipt>;
	writeFile(request: WriteRequest): Promise<WriteReceipt>;
	saveAs(request: SaveAsRequest): Promise<SaveAsReceipt | null>;
	watchFiles(
		workspaceId: string,
		listener: (event: FileEvent) => void,
		onError?: (failure: FileWatchFailure) => void
	): Promise<Unsubscribe>;
	compile(request: CompileRequest): Promise<CompileHandle>;
	closeWorkspace(workspaceId: string): Promise<void>;
}
