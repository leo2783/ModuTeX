// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '../..');
const wasm = path.resolve(root, process.env.MODUTEX_DOCUMENT_CORE_WASM_DIR ?? 'apps/frontend/src/features/document-core/generated');
const core = await import(pathToFileURL(path.join(wasm, 'modutex_document_core.js')).href);
core.initSync({ module: await readFile(path.join(wasm, 'modutex_document_core_bg.wasm')) });

test('real Tectonic absolute entry and included paths map through Rust WASM', { timeout: 180_000 }, async t => {
	assert.ok(process.env.TECTONIC_CACHE_DIR, 'Set TECTONIC_CACHE_DIR to a prepared engine cache');
	const fixtures = path.join(root, '.verification-artifacts', 'tauri');
	await mkdir(fixtures, { recursive: true });
	const owned = await mkdtemp(path.join(fixtures, 'synctex-engine-'));
	t.after(async () => {
		const relative = path.relative(fixtures, owned);
		assert.ok(relative.startsWith('synctex-engine-') && !relative.includes(path.sep));
		await rm(owned, { recursive: true, force: true });
	});
	const input = path.join(owned, '\u8cc7\u6599');
	const output = path.join(owned, 'output');
	await mkdir(input);
	await mkdir(output);
	await writeFile(path.join(input, 'main.tex'), [
		'\\documentclass{article}', '\\begin{document}',
		'Entry source line.', '\\par\\newpage', '\\input{section.tex}', '\\end{document}', ''
	].join('\n'));
	await writeFile(path.join(input, 'section.tex'), 'Included source line.\n');
	const engine = path.resolve(root, 'vendor/tectonic/windows-x64/tectonic.exe');
	const result = spawnSync(engine, ['--untrusted', '--only-cached', '--keep-logs', '--synctex', '--outdir', output, 'main.tex'], {
		cwd: input, encoding: 'utf8', timeout: 150_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const bytes = await readFile(path.join(output, 'main.synctex.gz'));
	const text = gunzipSync(bytes).toString('utf8');
	let offset = 0, previousAnchor = 0, anchorCount = 0;
	for (const record of text.split('\n')) {
		if (/^!\d+$/.test(record)) {
			assert.equal(Number(record.slice(1)), offset - previousAnchor, 'SyncTeX anchors measure bytes since the preceding checkpoint');
			previousAnchor = offset;
			anchorCount++;
		}
		offset += Buffer.byteLength(record) + 1;
	}
	assert.ok(anchorCount >= 4, 'real multi-page engine output must contain multiple checkpoints');
	const inputs = text.split(/\r?\n/).filter(line => line.startsWith('Input:'));
	assert.ok(inputs.some(line => line.endsWith(':' + path.join(input, 'main.tex'))), inputs.join('\n'));
	assert.ok(inputs.some(line => line.endsWith(':' + path.join(input, 'section.tex'))), inputs.join('\n'));
	const index = core.SynctexIndex.parse(bytes);
	t.after(() => index.free());
	for (const [source, line] of [['main.tex', 3], ['section.tex', 1]]) {
		const absolute = path.join(input, source);
		assert.equal(JSON.parse(index.forwardSearch(source, line, null)), null, 'raw engine paths require the trusted compile-artifact normalization boundary');
		const location = JSON.parse(index.forwardSearch(absolute, line, null));
		assert.ok(location, `Missing forward mapping for ${source}:${line}`);
		assert.ok(location.page >= 1);
		assert.ok(Number.isFinite(location.x) && Number.isFinite(location.y));
		const inverse = JSON.parse(index.inverseSearch(location.page, location.x + location.width / 2, location.y + location.height / 2));
		assert.ok(inverse, `Missing inverse mapping for ${source}:${line}`);
		assert.equal(inverse.path, absolute);
		assert.equal(inverse.line, line);
	}
});
