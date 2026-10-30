import { inputOnlyMathLive } from '../../scripts/mathlive-input-only.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { inventoryFrontend } from '../../../../scripts/licensing/frontend-artifacts.mjs';
import { consumeFrontendBuildEvidence } from '../../../../scripts/licensing/verify-frontend-origin.mjs';

// Run after frontend:build: verify real emitted files, not a fabricated manifest.
const dist = process.env.MODUTEX_TEST_FRONTEND_DIST
	? pathToFileURL(resolve(process.env.MODUTEX_TEST_FRONTEND_DIST) + sep)
	: new URL('../../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', dist), 'utf8'));
const entry = Object.values(manifest).filter((chunk) => chunk.isEntry);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const distRelative = relative(root, fileURLToPath(dist)).split(sep).join('/');
let verifiedInventory;

function staticClosure(chunk, found = new Map()) {
	if (found.has(chunk.file)) return found;
	found.set(chunk.file, chunk);
	for (const name of chunk.imports ?? []) {
		assert.ok(manifest[name], `Missing static dependency: ${name}`);
		staticClosure(manifest[name], found);
	}
	return found;
}

async function chunkEvidence(file) {
	assert.ok((await stat(new URL(file, dist))).size > 0, `Missing/empty emitted chunk: ${file}`);
	try {
		const map = JSON.parse(await readFile(new URL(`${file}.map`, dist), 'utf8'));
		assert.equal(map.version, 3, `Invalid source map: ${file}`);
		assert.ok(Array.isArray(map.sources) && map.sources.length > 0, `Source map has no sources: ${file}`);
		return { map, sources: map.sources };
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	// Vite emits mapless virtual helpers and re-export facades. The existing
	// consumer verifies exact output/input hashes and pinned compiler identities.
	verifiedInventory ??= (async () => {
		const inventory = await inventoryFrontend(root, distRelative);
		const result = await consumeFrontendBuildEvidence(root, inventory);
		assert.equal(result.verified, true, 'Missing verified build evidence');
		assert.deepEqual(result.findings, [], 'Invalid build evidence');
		return inventory;
	})();
	const inventory = await verifiedInventory;
	const path = `${distRelative}/${file}`;
	assert.ok(inventory.resolved.some(item => item.finding.path === path &&
		item.evidence.kind === 'verified-script-module-graph'), `Unverified mapless chunk: ${file}`);
	const evidence = JSON.parse(await readFile(new URL('frontend-build-evidence.json', dist), 'utf8'));
	const output = evidence.outputs.find(item => item.path === file);
	assert.ok(output?.modules.length > 0, `Missing verified chunk modules: ${file}`);
	return { map: null, sources: output.modules.map(module => module.sourcePath ?? module.id) };
}

test('production startup defers the actual editor and retains its emitted assets', async () => {
	assert.equal(entry.length, 1);
	const initial = new Set(staticClosure(entry[0]).keys());
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
		const { sources } = await chunkEvidence(file);
		for (const source of sources) {
			assert.equal(typeof source, 'string', `Invalid mapped startup source: ${file}`);
			assert.doesNotMatch(source.replaceAll('\\', '/'), /(?:^|\/)packages\/document-core\/dist\/parser\.js(?:[?#]|$)/, `Complete parser must stay outside startup static closure: ${file}`);
			assert.doesNotMatch(source.replaceAll('\\', '/'), /(?:^|\/)src\/pages\/Settings\.svelte(?:[?#]|$)/, `Settings must stay outside startup static closure: ${file}`);
			assert.doesNotMatch(source.replaceAll('\\', '/'), /(?:^|\/)src\/pages\/ReleaseNotes\.svelte(?:[?#]|$)/, `Release notes must stay outside startup static closure: ${file}`);
		}
	}
	for (const dynamicChunk of [editor, help, settings, releaseNotes]) {
		const records = await Promise.all([...staticClosure(dynamicChunk).keys()].map(chunkEvidence));
		assert.ok(records.some(({ map }) => map?.sources.some(s => s.replaceAll('\\', '/').endsWith(dynamicChunk.src))),
			`Dynamic implementation source map does not reference source file: ${dynamicChunk.src}`);
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
	const licenseHeading = 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION';
	const helpCode = await Promise.all([...staticClosure(help).keys()].map(file => readFile(new URL(file, dist), 'utf8')));
	assert.ok(helpCode.some(code => code.includes(licenseHeading)));
	for (const file of initial) assert.equal((await readFile(new URL(file, dist), 'utf8')).includes(licenseHeading), false);
});

test('real MathLive and its font assets are deferred and shipped locally', async () => {
	const input = manifest['src/features/math/MathInput.svelte'];
	assert.ok(input, 'Actual lazy MathInput chunk missing');
	const initial = new Set(staticClosure(entry[0]).keys());
	assert.equal(initial.has(input.file), false);
	const library = manifest['src/features/math/field.ts'];
	assert.ok(library, 'Actual MathLive dynamic module missing');
	assert.ok(input.dynamicImports?.includes('src/features/math/field.ts'));
	const libraryChunks = staticClosure(library);
	const records = await Promise.all([...libraryChunks.keys()].map(chunkEvidence));
	const implementation = records.find(({ map }) => map?.sources.some(source => source.replaceAll('\\', '/').endsWith('/mathlive-input/runtime.mjs')));
	assert.ok(implementation, 'Deferred helper must contain the actual mapped MathLive implementation');
	const librarySource = implementation.map.sources.findIndex(source => source.replaceAll('\\', '/').endsWith('/mathlive-input/runtime.mjs'));
	assert.equal(implementation.map.sourcesContent[librarySource], inputOnlyMathLive(await readFile(new URL('../../../../node_modules/mathlive/mathlive.mjs', import.meta.url), 'utf8')));
	for (const file of libraryChunks.keys()) assert.equal(initial.has(file), false, `MathLive dependency belongs to startup: ${file}`);
	const cssFiles = [...new Set([...libraryChunks.values()].flatMap(chunk => chunk.css ?? []))];
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
