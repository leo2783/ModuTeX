// SPDX-License-Identifier: Apache-2.0
import type { CompileIdentity } from '@modutex/frontend-contracts';

export function sameCompileIdentity(
	left: CompileIdentity | null | undefined,
	right: CompileIdentity | null | undefined
): boolean {
	return !!left && !!right &&
		left.runId === right.runId &&
		left.workspaceId === right.workspaceId &&
		left.entryPath === right.entryPath &&
		left.documentId === right.documentId &&
		left.documentVersion === right.documentVersion &&
		left.savedRevision === right.savedRevision;
}
