import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { recentDocuments } from '../../src/features/files/recent.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const receipt = { id: '01234567-1234-4123-8123-012345678901', label: '論文', entryPath: 'main.tex', openedAt: 1 };
test('recent decoder bounds receipts, rejects renderer paths and copies only public fields', () => {
	const result = recentDocuments([receipt]);
	assert.throws(() => recentDocuments([{ ...receipt, selected: 'C:\\private\\main.tex' }]));
	assert.deepEqual(result, [receipt]); assert.ok(Object.isFrozen(result[0]));
	assert.doesNotMatch(JSON.stringify(result), /private|selected/);
	for (const value of [null, {}, [receipt, receipt], Array(21).fill(receipt), [{ ...receipt, id: '../main.tex' }],
		[{ ...receipt, label: 'C:\\private' }], [{ ...receipt, entryPath: '../main.tex' }], [{ ...receipt, entryPath: 'x'.repeat(4097) + '.tex' }],
		[{ ...receipt, openedAt: NaN }], [{ ...receipt, openedAt: -1 }]]) assert.throws(() => recentDocuments(value));
	assert.deepEqual(recentDocuments([{ ...receipt, entryPath: null }]), [{ ...receipt, entryPath: null }]);
});
test('real Home SSR shows actual recent names, removal, empty and failed history without executable content', { timeout: 15000 }, async () => {
	const server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'error' });
	try {
		const module = await server.ssrLoadModule('/src/pages/Home.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');
		const props = { desktop: true, busy: true, recent: [{ ...receipt, label: '<script>bad</script>' }], onRecent: () => {}, onRemoveRecent: () => {}, onOpen: () => {}, onCreate: () => {} };
		const dom = new JSDOM(render(module.default, { props }).body);
		try {
			assert.equal(dom.window.document.querySelector('.recent-open')?.textContent.trim(), '<script>bad</script> / main.tex');
			assert.equal(dom.window.document.querySelector('.recent-remove')?.textContent, '移除');
			assert.equal(dom.window.document.querySelectorAll('script').length, 0);
			assert.ok(dom.window.document.querySelector('.recent-open')?.hasAttribute('disabled'));
		} finally { dom.window.close(); }
		const empty = render(module.default, { props: { ...props, recent: [] } }).body;
		assert.match(empty, /尚未開啟文件/);
		const failed = render(module.default, { props: { ...props, recent: [], recentNotice: '無法讀取最近文件。' } }).body;
		assert.match(failed, /無法讀取最近文件/); assert.doesNotMatch(failed, /尚未開啟文件/);
	} finally { await server.close(); }
});
