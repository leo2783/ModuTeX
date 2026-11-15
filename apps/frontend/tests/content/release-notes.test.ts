import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { releaseNotes, contentBlocks, inlineParts } from '../../src/features/release-notes/content.ts';

test('releaseNotes parses structured fixture versions, statuses, headings, lists and CRLF identically', () => {
	const fixture = [
		'# Changelog',
		'',
		'## [9.9.0] - Unreleased',
		'### Fixed',
		'- First unreleased fix.',
		'',
		'## [9.8.0] - 2026-10-15',
		'### Added',
		'- Added feature A.',
		'### Changed',
		'- Changed behavior B.',
		''
	].join('\n');
	const records = releaseNotes(fixture);
	assert.equal(records.length, 2);
	assert.deepEqual(records.map((record) => ({ version: record.version, status: record.status })), [
		{ version: '9.9.0', status: 'Unreleased' },
		{ version: '9.8.0', status: '2026-10-15' }
	]);
	assert.deepEqual(records[0]!.blocks.filter((block) => block.kind === 'heading').map((block) => block.text), ['Fixed']);
	assert.deepEqual(records[1]!.blocks.filter((block) => block.kind === 'heading').map((block) => block.text), ['Added', 'Changed']);
	assert.deepEqual(releaseNotes(fixture.replaceAll('\n', '\r\n')), records);
});
test('actual bundled changelog preserves version/status invariants and all recorded changes', async () => {
	const text = await readFile(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');
	const records = releaseNotes(text);
	assert.ok(records.length >= 4, 'bundled changelog must contain the historical release series');
	for (const record of records) {
		assert.match(record.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
		assert.ok(record.status === 'Unreleased' || /^\d{4}-\d{2}-\d{2}$/.test(record.status), `unexpected status: ${record.status}`);
		assert.ok(record.blocks.some((block) => block.kind === 'heading'));
		assert.ok(record.blocks.some((block) => block.kind === 'list' && block.items.length > 0));
	}
	assert.deepEqual(records.slice(-4).map((record) => record.version), ['0.2.1', '0.2.0', '0.2.0-dev.0', '0.1.0']);
	assert.equal(records.flatMap((record) => record.blocks.filter((block) => block.kind === 'list').flatMap((block) => block.items)).length, text.split(/\r?\n/).filter((line) => line.startsWith('- ')).length);
	assert.deepEqual(releaseNotes(text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')), records);
});
test('bounded release parser rejects duplicate/excessive input and retains unknown HTML as text', () => {
	assert.deepEqual(releaseNotes('# Empty'), []);
	assert.throws(() => releaseNotes('x'.repeat(128 * 1024 + 1)), /NOTES_TOO_LARGE/);
	assert.throws(() => releaseNotes('## [1]\n## [1]'), /INVALID_RELEASE_INDEX/);
	assert.throws(() => releaseNotes(Array.from({ length: 101 }, (_, i) => `## [${i}]`).join('\n')), /INVALID_RELEASE_INDEX/);
	const blocks = contentBlocks('### Safety\n<script>alert(1)</script>\n- one\n- two');
	assert.deepEqual(blocks[1], { kind: 'paragraph', text: '<script>alert(1)</script>' });
	assert.deepEqual(blocks[2], { kind: 'list', items: ['one', 'two'] });
	assert.ok(Object.isFrozen(blocks)); assert.ok(blocks[2]?.kind === 'list' && Object.isFrozen(blocks[2].items));
});
test('inline parser exposes only the bundled limitations route; code remains literal', () => {
	assert.deepEqual(inlineParts('Use `tabularx`.'), [{ kind: 'text', text: 'Use ' }, { kind: 'code', text: 'tabularx' }, { kind: 'text', text: '.' }]);
	assert.deepEqual(inlineParts('[Known limitations](docs/user/KNOWN_LIMITATIONS.md)'), [{ kind: 'link', text: 'Known limitations', href: '#/release-notes/limitations' }]);
	assert.deepEqual(inlineParts('[click](javascript:alert(1))'), [{ kind: 'text', text: '[click](javascript:alert(1))' }]);
});
test('real Svelte/Vite server render reads version documents and renders semantic safe content', { timeout: 15000 }, async () => {
	const text = await readFile(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');
	const latest = releaseNotes(text)[0]!;
	const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'error' });
	try {
		const module = await server.ssrLoadModule('/src/pages/ReleaseNotes.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');
		const notes = render(module.default).body;
		assert.match(notes, /版本紀錄/);
		assert.ok(notes.includes(latest.version));
		assert.ok(notes.includes(latest.status));
		assert.match(notes, /0\.1\.0/); // Historical releases remain in the index.
		assert.doesNotMatch(notes, /<script[ >]/i);
		const limits = render(module.default, { props: { showLimitations: true } }).body;
		assert.match(limits, /已知限制/); assert.match(limits, /Tectonic 首次準備編譯資源時需要網路/);
	} finally { await server.close(); }
});
