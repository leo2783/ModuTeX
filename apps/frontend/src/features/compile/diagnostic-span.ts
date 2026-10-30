import type { SourceDocument, SourceSpan } from '../document-core/core.ts';
import type { CompileIdentity, Diagnostic } from '@modutex/frontend-contracts';

/** Resolve only the unchanged entry document; locations in includes remain log-only. */
export function diagnosticSpan(source: SourceDocument, path: string, identity: CompileIdentity, diagnostic: Diagnostic): SourceSpan | null {
	if (source.documentId !== identity.documentId || source.version !== identity.documentVersion || path !== identity.entryPath || diagnostic.path !== path || !Number.isSafeInteger(diagnostic.line) || diagnostic.line! < 1) return null;
	const text = source.read(); let row = 1, start = 0;
	for (const match of text.matchAll(/\r\n|\r|\n/g)) {
		if (row === diagnostic.line) return Object.freeze({ documentId: source.documentId, version: source.version, from: start, to: match.index! });
		start = match.index! + match[0].length; row++;
	}
	return row === diagnostic.line ? Object.freeze({ documentId: source.documentId, version: source.version, from: start, to: text.length }) : null;
}
