export interface TerminalAvailability {
	readonly available: boolean;
	readonly reason: string | null;
	readonly detail: string | null;
}

export interface TerminalSize {
	readonly cols: number;
	readonly rows: number;
}

export interface TerminalSessionReceipt {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly generation: number;
	readonly size: TerminalSize;
}

export interface TerminalExit {
	readonly exitCode: number | null;
	readonly reason: string;
}

export class TerminalSessionError extends Error {
	readonly code: string;
	readonly detail: string;
	constructor(code: string, detail?: string);
}

export interface TerminalCallbacks {
	onOutput?(bytes: Uint8Array): void | Promise<void>;
	onExit?(exit: TerminalExit): void | Promise<void>;
	onFailure?(error: TerminalSessionError): void;
	onBackpressure?(): void;
	onCleanupFailure?(error: TerminalSessionError): void;
}

export interface TerminalController {
	availability(): Promise<TerminalAvailability>;
	start(cols: number, rows: number): Promise<TerminalSessionReceipt>;
	send(data: string): boolean;
	resize(cols: number, rows: number): boolean;
	close(): Promise<void>;
}

export interface TerminalControllerOptions {
	readonly ownerId: string;
	readonly workspaceId: string;
	readonly invokeCommand: (
		command: string,
		args?: Readonly<Record<string, unknown>>
	) => Promise<unknown>;
	readonly listenEvent: (
		eventName: string,
		listener: (payload: unknown) => void
	) => Promise<() => void>;
	readonly callbacks?: TerminalCallbacks;
	readonly signal?: AbortSignal;
}

export const TERMINAL_EVENT: string;
export const TERMINAL_LIMITS: Readonly<{
	maxOutputChunkBytes: number;
	maxOutputQueueBytes: number;
	maxOutputQueueEvents: number;
	maxEarlyBytes: number;
	maxEarlyEvents: number;
	maxEarlySessions: number;
	maxInputChunkBytes: number;
	maxInputQueueBytes: number;
}>;

export function createTerminalController(
	options: TerminalControllerOptions
): TerminalController;
