import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../../../scripts/licensing/frontend-artifacts.mjs';
import { pdfFontProof } from '../../../scripts/licensing/pdf-font-proof.mjs';

test('PDF font proof requires identical bytes and both shipped license texts', async t => {
 const root = await mkdtemp(path.join(tmpdir(), 'pdf-font-proof-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const source = 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf';
 const target = 'apps/frontend/dist-tauri/assets/LiberationSans-Regular-test.ttf';
 async function put(file, text) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
 const bytes = Buffer.from('original font fixture'), sha256 = digest(bytes);
 await put(source, bytes); await put(target, bytes);
 const output = { kind: 'asset', rootPath: target, sha256, sourceFile: { path: source, sha256 } };
 assert.equal(await pdfFontProof(root, output), null, 'missing licenses must fail');
 for (const name of ['LICENSE_FOXIT','LICENSE_LIBERATION']) {
  await put(`node_modules/pdfjs-dist/standard_fonts/${name}`, `${name} original license`);
  await put(`apps/frontend/dist-tauri/licenses/pdfjs/standard_fonts/${name}.txt`, `${name} original license`);
 }
 assert.equal((await pdfFontProof(root, output))?.licenses.length, 2);
 const alias = root + '-alias';
 await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
 t.after(() => rm(alias, { recursive: true, force: true }));
 assert.equal((await pdfFontProof(alias, output))?.licenses.length, 2, 'canonicalize the repository root before comparing contained paths');
 const fonts = path.join(root, 'node_modules/pdfjs-dist/standard_fonts'), outside = root + '-outside';
 await rename(fonts, outside);
 t.after(() => rm(outside, { recursive: true, force: true }));
 await symlink(outside, fonts, process.platform === 'win32' ? 'junction' : 'dir');
 assert.equal(await pdfFontProof(alias, output), null, 'matching font and license bytes outside the canonical root must still fail');
 await rm(fonts, { recursive: true }); await rename(outside, fonts);
 await put(target, 'tampered font'); assert.equal(await pdfFontProof(root, output), null);
 await put(target, bytes);
 await put('apps/frontend/dist-tauri/licenses/pdfjs/standard_fonts/LICENSE_LIBERATION.txt', 'truncated');
 assert.equal(await pdfFontProof(root, output), null);
 assert.equal(await pdfFontProof(root, { ...output, sourceFile: { ...output.sourceFile, path: '../outside.ttf' } }), null);
});
