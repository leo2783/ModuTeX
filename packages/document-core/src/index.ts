// Original ModuTeX implementation. License pending provenance review.
export { SourceDocument } from './source.ts';
export type { SourceTransaction, SourceUpdate } from './source.ts';
export { mapPosition, remapSpan } from './changes.ts';
export type { SourcePatch, SourceSpan, SourceChange } from './changes.ts';
export { SourceError } from './utf8.ts';
export type { SourceProfile, LineEnding } from './utf8.ts';
export { parseSource } from './parser.ts';
export { projectionIsCurrent } from './projection.ts';
export type { SyntaxNode, SyntaxKind, SourceProjection, ParseIssue, ParseLimits } from './parser.ts';
export { EditorProjection } from './editor-projection.ts';
export type { EditorPatch } from './editor-projection.ts';
