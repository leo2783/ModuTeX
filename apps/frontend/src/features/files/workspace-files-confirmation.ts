// SPDX-License-Identifier: Apache-2.0
import type {
	WorkspaceFileDeleteReceipt,
	WorkspaceFilesPort
} from './workspace-files.ts';

export interface WorkspaceFileDestructiveConfirmation {
	readonly action: 'recycle' | 'delete';
	readonly path: string;
}

export type ConfirmedWorkspaceFileRequest = () => Promise<void | WorkspaceFileDeleteReceipt>;

/** Return a request only after the UI has obtained an explicit confirmation. */
export function confirmedWorkspaceFileRequest(
	files: Pick<WorkspaceFilesPort, 'recycle' | 'delete'>,
	workspaceId: string,
	confirmation: WorkspaceFileDestructiveConfirmation | null,
	confirmed: boolean
): ConfirmedWorkspaceFileRequest | null {
	if (!confirmed || !confirmation) return null;
	if (confirmation.action === 'delete') {
		return () => files.delete(workspaceId, confirmation.path);
	}
	return () => files.recycle(workspaceId, confirmation.path);
}
