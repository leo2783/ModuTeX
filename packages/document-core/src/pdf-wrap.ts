// SPDX-License-Identifier: Apache-2.0
import { SourceDocument } from './source.ts';
import { parseSource, type SyntaxNode } from './parser.ts';
/** Typesetting-only break opportunities; never mutate source, math, code or opaque macro arguments. */
export function pdfWrappedText(bytes: Uint8Array): Uint8Array {
 const source = SourceDocument.open(bytes), parsed = parseSource(source);
 if (parsed.issues.some(issue => issue.code === 'BUDGET')) return bytes;
 const patches: { from: number; to: number; insert: string; expected: string }[] = [];
 function visit(nodes: readonly SyntaxNode[], body = false) {
  for (const node of nodes) {
   if (node.kind === 'environment') visit(node.children, body || node.name === 'document');
   else if (body && node.kind === 'format') visit(node.children, true);
   else if (body && node.kind === 'text') {
    const text = source.read(node.span.from, node.span.to);
    for (const match of text.matchAll(/[A-Za-z0-9]{32,}/g)) {
     const value = match[0], from = node.span.from + match.index;
     patches.push({ from, to: from + value.length, insert: value.match(/.{1,16}/g)!.join('\\allowbreak{}'), expected: value });
    }
   }
  }
 }
 visit(parsed.nodes);
 return patches.length ? source.apply({ expectedVersion: source.version, patches }).document.toBytes() : bytes;
}
