// SPDX-License-Identifier: Apache-2.0
export type GitUnavailableReason =
	| 'NOT_INSTALLED'
	| 'UNSUPPORTED_PLATFORM'
	| 'UNSAFE_EXECUTABLE'
	| 'UNSAFE_ENVIRONMENT';

export type GitAvailability =
	| { readonly status: 'available' }
	| { readonly status: 'unavailable'; readonly reason: GitUnavailableReason };

export type GitStatusCode =
	| 'UNCHANGED'
	| 'MODIFIED'
	| 'TYPE_CHANGED'
	| 'ADDED'
	| 'DELETED'
	| 'RENAMED'
	| 'COPIED'
	| 'UNMERGED'
	| 'UNTRACKED';

export interface GitStatusEntry {
	readonly index: GitStatusCode;
	readonly worktree: GitStatusCode;
	readonly path: string;
	readonly originalPath: string | null;
}

export interface GitStatus {
	readonly entries: readonly GitStatusEntry[];
}

export class GitCommandError extends Error {
	readonly code: string;
	constructor(code: string, message: string);
}

export interface TauriGitAdapter {
	availability(): Promise<GitAvailability>;
	status(workspaceId: string): Promise<GitStatus>;
	diff(workspaceId: string, staged: boolean, paths: readonly string[]): Promise<Uint8Array>;
	log(workspaceId: string): Promise<Uint8Array>;
	show(workspaceId: string): Promise<Uint8Array>;
	init(workspaceId: string): Promise<void>;
	stage(workspaceId: string, paths: readonly string[]): Promise<void>;
	unstage(workspaceId: string, paths: readonly string[]): Promise<void>;
	discard(workspaceId: string, paths: readonly string[]): Promise<boolean>;
	commit(workspaceId: string, message: string): Promise<Uint8Array>;
	userName(workspaceId: string): Promise<string | null>;
}

export type GitInvoke = (
	command: string,
	args?: Record<string, unknown>
) => Promise<unknown>;

export function createTauriGitAdapter(invokeCommand?: GitInvoke): TauriGitAdapter;
export function tauriGitAdapter(): TauriGitAdapter | null;
