// Original identity guard; kept independent of the optional complete parser.
import type { SourceDocument } from './source.ts';
import type { SourceProjection } from './parser.ts';

export function projectionIsCurrent(document: SourceDocument, projection: SourceProjection): boolean {
	return document.documentId === projection.documentId && document.version === projection.version;
}
