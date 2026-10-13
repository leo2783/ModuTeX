import type { SourceDocument } from '@modutex/document-core';
import type { CompileIdentity } from '@modutex/frontend-contracts';

export function previewStatus(source: SourceDocument | null, path: string, identity: CompileIdentity | null): 'external' | 'current' | 'stale' {
	if (!identity) return 'external';
	return source?.documentId === identity.documentId && source.version === identity.documentVersion && path === identity.entryPath ? 'current' : 'stale';
}
