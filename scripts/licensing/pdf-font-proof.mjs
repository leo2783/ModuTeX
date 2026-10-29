import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digest, inside } from './frontend-artifacts.mjs';

/** Additional byte/license evidence; package and build provenance are checked by the caller. */
export async function pdfFontProof(root, output) {
 const source = output?.sourceFile;
 if (output?.kind !== 'asset' || !/^node_modules\/pdfjs-dist\/standard_fonts\/[A-Za-z0-9_-]+\.ttf$/.test(source?.path ?? '') ||
     !/^apps\/frontend\/dist-tauri\/assets\/[A-Za-z0-9_.-]+\.ttf$/.test(output.rootPath ?? '')) return null;
 async function canonicalBytes(relative) {
  const candidate = path.resolve(root, relative), actual = await realpath(candidate);
  if (!inside(root, actual) || path.relative(root, actual).split(path.sep).join('/') !== relative) throw Error('PDF_RESOURCE_NOT_CANONICAL');
  return readFile(actual);
 }
 try {
  const original = await canonicalBytes(source.path), emitted = await canonicalBytes(output.rootPath);
  if (digest(original) !== source.sha256 || digest(emitted) !== output.sha256 || output.sha256 !== source.sha256) return null;
  const licenses = [];
  for (const name of ['LICENSE_FOXIT', 'LICENSE_LIBERATION']) {
   const installed = `node_modules/pdfjs-dist/standard_fonts/${name}`;
   const shipped = `apps/frontend/dist-tauri/licenses/pdfjs/standard_fonts/${name}.txt`;
   const a = await canonicalBytes(installed), b = await canonicalBytes(shipped);
   if (!a.length || !a.equals(b)) return null;
   licenses.push({ installed, shipped, sha256: digest(a) });
  }
  return { kind: 'verified-pdf-font-byte-trace', outputPath: output.rootPath, sourcePath: source.path, sha256: output.sha256, licenses };
 } catch { return null; }
}
