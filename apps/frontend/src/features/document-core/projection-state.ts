// SPDX-License-Identifier: Apache-2.0
import type { SourceDocument, SourceProjection } from './core.ts';

/** Checking a projection's owner does not require initializing the document engine. */
export function projectionIsCurrent(document: SourceDocument, projection: SourceProjection): boolean {
	return document.documentId === projection.documentId && document.version === projection.version;
}
