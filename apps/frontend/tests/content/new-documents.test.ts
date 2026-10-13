import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { SourceDocument } from '@modutex/document-core';
import { createDraft, templateOptions } from '../../src/features/files/templates.ts';
import { createSourceState, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('template choices are an immutable closed allowlist with actual descriptions', () => {
	assert.deepEqual(templateOptions.map((option) => option.id), ['blank', 'article', 'report']);
	assert.equal(Object.isFrozen(templateOptions), true);
	for (const option of templateOptions) {
		assert.equal(Object.isFrozen(option), true);
		assert.ok(option.title.trim());
		assert.ok(option.description.trim());
	}
	let invoked = false;
	for (const value of [undefined, null, '', 'Article', 'constructor', '__proto__', '../article', 'https://example.org/template', {}, ['article'], {
		toString() { invoked = true; return 'article'; }
	}]) assert.throws(() => createDraft(value));
	assert.equal(invoked, false);
});

test('each template creates an independent SourceDocument and never shares mutable bytes', () => {
	const ids = new Set<string>();
	for (const option of templateOptions) {
		const first = createDraft(option.id), second = createDraft(option.id);
		assert.ok(first instanceof SourceDocument);
		assert.equal(first.version, 0);
		assert.equal(second.version, 0);
		assert.ok(first.documentId);
		assert.notEqual(first.documentId, second.documentId);
		assert.ok(!ids.has(first.documentId) && !ids.has(second.documentId));
		ids.add(first.documentId); ids.add(second.documentId);
		const pristine = second.toBytes();
		const exported = first.toBytes();
		exported.fill(0);
		assert.deepEqual(first.toBytes(), pristine);
		assert.deepEqual(second.toBytes(), pristine);
		assert.deepEqual(createDraft(option.id).toBytes(), pristine);
	}
});

test('self-authored blank, article and report sources use only standard document classes', () => {
	const blank = createDraft('blank').read(), article = createDraft('article').read(), report = createDraft('report').read();
	assert.match(blank, /\\documentclass(?:\[[^\]]*\])?\{article\}/);
	assert.match(article, /\\documentclass(?:\[[^\]]*\])?\{article\}/);
	assert.match(article, /\\title\{/);
	assert.match(article, /\\maketitle\b/);
	assert.match(article, /\\section\{/);
	assert.match(report, /\\documentclass(?:\[[^\]]*\])?\{report\}/);
	assert.match(report, /\\chapter\{/);
	assert.equal(new Set([blank, article, report]).size, 3);
	for (const text of [blank, article, report]) {
		assert.match(text, /\\begin\{document\}/);
		assert.match(text, /\\end\{document\}/);
		assert.doesNotMatch(text, /\\(?:usepackage|RequirePackage|input|include|write18|openout)\b/);
		assert.doesNotMatch(text, /https?:\/\//);
	}
});

for (const id of ['blank', 'article', 'report'] as const) {
	test(`${id} draft uses genuine CodeMirror editing and undo restores original source bytes`, () => {
		const draft = createDraft(id), bytes = draft.toBytes();
		let state = createSourceState(draft);
		assert.equal(state.field(sourceState).projection.document.documentId, draft.documentId);
		state = state.update({ changes: { from: 0, insert: '% edited 雪\n' } }).state;
		const changed = state.field(sourceState).projection.document;
		assert.equal(changed.documentId, draft.documentId);
		assert.ok(changed.version > draft.version);
		assert.equal(state.field(sourceState).dirty, true);
		assert.match(changed.read(), /^% edited 雪\n/);
		assert.deepEqual(draft.toBytes(), bytes);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes);
		state = historyTransaction(state, 'redo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
		assert.deepEqual(createDraft(id).toBytes(), bytes);
	});
}

test('actual Home SSR exposes usable template controls, busy states and safely escaped filenames', { timeout: 15000 }, async () => {
	const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'error' });
	try {
		const module = await server.ssrLoadModule('/src/pages/Home.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');
		const filename = '<img src=x onerror=alert(1)>.tex';
		for (const desktop of [true, false]) for (const busy of [true, false]) {
			const dom = new JSDOM(render(module.default, { props: { desktop, busy, currentName: filename, dirty: true, onOpen() {}, onCreate() {} } }).body);
			try {
				const document = dom.window.document;
				assert.equal(document.querySelectorAll('script, img, [onerror]').length, 0);
				assert.ok(document.body.textContent.includes(filename));
				const buttons = [...document.querySelectorAll('button')];
				for (const option of templateOptions) {
					const matches = buttons.filter((button) => button.dataset.template === option.id || button.textContent.includes(option.title));
					assert.equal(matches.length, 1, `missing or ambiguous ${option.id} control`);
					assert.equal(matches[0].disabled, busy, `wrong busy state for ${option.id}`);
				}
				if (busy) assert.ok(buttons.every((button) => button.disabled));
				assert.equal(document.querySelectorAll('a[href^="javascript:"]').length, 0);
			} finally { dom.window.close(); }
		}
	} finally { await server.close(); }
});
