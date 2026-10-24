import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { helpText } from '../../src/features/help/content.ts';
import { helpTopics, helpTopic } from '../../src/features/help/topics.ts';
import { contentBlocks } from '../../src/features/release-notes/content.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('help routes allow only actual topics and instructions match connected features', () => {
	for (const topic of helpTopics) assert.equal(helpTopic('#/help/' + topic.id), topic.id);
	for (const hash of ['#/help', '#/help/javascript:alert(1)', '#/help/../private', '#/unknown']) assert.equal(helpTopic(hash), 'getting-started');
	assert.match(helpText.compilation!, /固定官方來源/);
	assert.match(helpText.shortcuts!, /Ctrl\+O/);
	assert.doesNotMatch(helpText.shortcuts!, /自動儲存|MathLive/);
	assert.match(helpText.licenses!, /Apache-2\.0/);
});
test('bounded reading parser preserves code line breaks and literal HTML without executable output', () => {
	const value = contentBlocks('## Guide\n```powershell\n<script>alert(1)</script>\n\n$actual = 1\n```\n- Next');
	assert.deepEqual(value[1], { kind: 'code', language: 'powershell', text: '<script>alert(1)</script>\n\n$actual = 1' });
	assert.ok(Object.isFrozen(value[1]));
	assert.throws(() => contentBlocks('```tex\nunclosed'), /UNCLOSED_CODE_BLOCK/);
	assert.throws(() => contentBlocks('x'.repeat(128 * 1024 + 1)), /NOTES_TOO_LARGE/);
});
test('actual Svelte/Vite Help renders retained topics and unchanged license texts', { timeout: 15000 }, async () => {
	const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'error' });
	try {
		const module = await server.ssrLoadModule('/src/pages/Help.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');
		for (const [topic, expectedTitle, expectedText] of [
			['getting-started', '開始使用', /開啟文件/],
			['compilation', 'PDF 編譯', /固定官方來源/]
		] as const) {
			const rendered = render(module.default, { props: { topic } }).body;
			const dom = new JSDOM(rendered);
			try {
				assert.equal(dom.window.document.querySelector('[aria-current="page"]')?.textContent, expectedTitle);
				assert.equal(dom.window.document.querySelector('#help-heading')?.textContent, expectedTitle);
				assert.equal(dom.window.document.querySelector('nav a[href="#/help/installation"]'), null);
				assert.match(rendered, expectedText);
				assert.equal(dom.window.document.querySelectorAll('script').length, 0);
			} finally { dom.window.close(); }
		}
		for (const [topic, path] of [['apache', '../../../desktop-tauri/LICENSE']] as const) {
			const actual = await readFile(new URL(path, import.meta.url), 'utf8');
			const dom = new JSDOM(render(module.default, { props: { topic } }).body);
			try { assert.equal(dom.window.document.querySelector('.license-text')?.textContent, actual.replaceAll('\r\n', '\n')); } finally { dom.window.close(); }
		}
		const notices = render(module.default, { props: { topic: 'notices' } }).body;
		assert.match(notices, /Tectonic 0\.17\.0/); assert.match(notices, /svelte 5\.56\.9/); assert.match(notices, /pdfjs-dist 6\.2\.108/);
		assert.match(notices, /Permission is hereby granted/); assert.doesNotMatch(notices, /<script[ >]/i);
		const actualNotices = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
		for (const locale of ['zh-Hant', 'en']) {
			const dom = new JSDOM(render(module.default, { props: { topic: 'notices', locale } }).body);
			try {
				const section = [...dom.window.document.querySelectorAll('section')].find(node =>
					node.querySelector('h2')?.textContent === (locale === 'en' ? 'Frontend components' : '前端元件'));
				assert.ok(section);
				assert.equal(section.querySelector('.license-text')?.textContent, actualNotices.replaceAll('\r\n', '\n'));
				assert.equal(dom.window.document.querySelectorAll('script').length, 0);
			} finally { dom.window.close(); }
		}
	} finally { await server.close(); }
});
