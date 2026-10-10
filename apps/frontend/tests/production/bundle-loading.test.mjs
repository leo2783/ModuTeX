import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';

// Run after frontend:build: verify real emitted files, not a fabricated manifest.
const dist = new URL('../../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', dist), 'utf8'));
const entry = Object.values(manifest).filter((chunk) => chunk.isEntry);

test('production startup defers the actual editor and retains its emitted assets', async () => {
	assert.equal(entry.length, 1);
	const initial = new Set();
	const visit = (chunk) => {
		if (initial.has(chunk.file)) return;
		initial.add(chunk.file);
		for (const name of chunk.imports ?? []) { assert.ok(manifest[name], `Missing static dependency: ${name}`); visit(manifest[name]); }
	};
	visit(entry[0]);
	const editor = manifest['src/features/source-editor/SourceView.svelte'];
	assert.ok(editor, 'Actual SourceView build chunk missing');
	assert.equal(initial.has(editor.file), false, 'Editor must not belong to startup static closure');
	assert.ok(entry[0].dynamicImports?.includes('src/features/source-editor/SourceView.svelte'));
	const help = manifest['src/pages/Help.svelte'];
	assert.ok(help, 'Actual Help build chunk missing');
	assert.equal(initial.has(help.file), false, 'Help/license documents must not belong to startup static closure');
	assert.ok(entry[0].dynamicImports?.includes('src/pages/Help.svelte'));
	const settings = manifest['src/pages/Settings.svelte'];
	assert.ok(settings, 'Actual Settings build chunk missing');
	assert.equal(initial.has(settings.file), false, 'Settings must not belong to startup static closure');
	assert.ok(settings.isDynamicEntry, 'Settings chunk must be marked as dynamic entry');
	assert.ok(entry[0].dynamicImports?.includes('src/pages/Settings.svelte'), 'Settings must be dynamically imported by entry');
	const releaseNotes = manifest['src/pages/ReleaseNotes.svelte'];
	assert.ok(releaseNotes, 'Actual ReleaseNotes build chunk missing');
	assert.equal(initial.has(releaseNotes.file), false, 'Release notes must not belong to startup static closure');
	assert.ok(releaseNotes.isDynamicEntry, 'ReleaseNotes chunk must be marked as dynamic entry');
	assert.ok(entry[0].dynamicImports?.includes('src/pages/ReleaseNotes.svelte'), 'ReleaseNotes must be dynamically imported by entry');
	let initialBytes = 0;
	for (const file of initial) {
		initialBytes += (await stat(new URL(file, dist))).size;
		const map = JSON.parse(await readFile(new URL(`${file}.map`, dist), 'utf8'));
		assert.equal(map.version, 3, `Invalid startup source map: ${file}`);
		assert.ok(Array.isArray(map.sources) && map.sources.length > 0, `Startup source map has no sources: ${file}`);
		for (const source of map.sources) {
			assert.equal(typeof source, 'string', `Invalid mapped startup source: ${file}`);
			assert.doesNotMatch(source.replaceAll('\\', '/'), /(?:^|\/)packages\/document-core\/dist\/parser\.js(?:[?#]|$)/, `Complete parser must stay outside startup static closure: ${file}`);
			assert.doesNotMatch(source.replaceAll('\\', '/'), /(?:^|\/)src\/pages\/Settings\.svelte(?:[?#]|$)/, `Settings must stay outside startup static closure: ${file}`);
			assert.doesNotMatch(source.replaceAll('\\', '/'), /(?:^|\/)src\/pages\/ReleaseNotes\.svelte(?:[?#]|$)/, `Release notes must stay outside startup static closure: ${file}`);
		}
	}
	for (const dynamicChunk of [editor, help, settings, releaseNotes]) {
		const map = JSON.parse(await readFile(new URL(`${dynamicChunk.file}.map`, dist), 'utf8'));
		assert.equal(map.version, 3, `Invalid dynamic chunk source map: ${dynamicChunk.file}`);
		assert.ok(Array.isArray(map.sources) && map.sources.length > 0, `Dynamic chunk source map has no sources: ${dynamicChunk.file}`);
		assert.ok(map.sources.some((s) => s.replaceAll('\\', '/').endsWith(dynamicChunk.src)), `Dynamic source map does not reference source file: ${dynamicChunk.src}`);
	}
	assert.ok(initialBytes < 100 * 1024, `Startup JavaScript ${initialBytes} exceeds 100 KiB`);
	const pending = [
		...initial,
		editor.file, ...(editor.css ?? []),
		help.file, ...(help.css ?? []),
		settings.file, ...(settings.css ?? []),
		releaseNotes.file, ...(releaseNotes.css ?? [])
	];
	for (const file of pending) assert.ok((await stat(new URL(file, dist))).size > 0, `Missing/empty emitted asset: ${file}`);
	assert.match(await readFile(new URL(help.file, dist), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
	for (const file of initial) assert.doesNotMatch(await readFile(new URL(file, dist), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
});

test('real MathLive and its font assets are deferred and shipped locally', async () => {
	const input = manifest['src/features/math/MathInput.svelte'];
	assert.ok(input, 'Actual lazy MathInput chunk missing');
	const initial = new Set();
	const visit = chunk => { if (initial.has(chunk.file)) return; initial.add(chunk.file); for (const name of chunk.imports ?? []) visit(manifest[name]); };
	visit(entry[0]);
	assert.equal(initial.has(input.file), false);
	const library = manifest['src/features/math/field.ts'];
	assert.ok(library, 'Actual MathLive dynamic module missing');
	assert.ok(input.dynamicImports?.includes('src/features/math/field.ts'));
	const map = JSON.parse(await readFile(new URL(library.file + '.map', dist), 'utf8'));
	const librarySource = map.sources.findIndex(source => source.endsWith('/mathlive/mathlive.min.mjs'));
	assert.ok(librarySource >= 0, 'Deferred helper must contain the actual MathLive implementation');
	assert.equal(map.sourcesContent[librarySource], await readFile(new URL('../../../../node_modules/mathlive/mathlive.min.mjs', import.meta.url), 'utf8'));
	assert.equal(initial.has(library.file), false);
	assert.ok((await stat(new URL(library.file, dist))).size > 0);
	const cssFiles = library.css ?? [];
	assert.ok(cssFiles.length > 0, 'Bundled font stylesheet missing');
	const css = (await Promise.all(cssFiles.map(file => readFile(new URL(file, dist), 'utf8')))).join('\n');
	assert.match(css, /@font-face/);
	assert.doesNotMatch(css, /url\(["']?https?:/);
	const fonts = [...css.matchAll(/url\((?:["']?)([^)"']+\.woff2)(?:["']?)\)/g)].map(match => match[1]);
	const embedded = [...css.matchAll(/url\((?:["']?)data:font\/woff2;base64,([A-Za-z0-9+/=]+)(?:["']?)\)/g)];
	assert.equal(fonts.length + embedded.length, 20, 'Actual MathLive font closure incomplete');
	for (const match of embedded) { const bytes = Buffer.from(match[1], 'base64'); assert.equal(bytes.subarray(0, 4).toString(), 'wOF2'); assert.ok(bytes.length > 100); }
	for (const font of fonts) assert.ok((await stat(new URL(font, new URL(cssFiles[0], dist)))).size > 0, `Missing font: ${font}`);
});
