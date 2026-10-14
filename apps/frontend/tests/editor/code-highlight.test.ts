import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error jsdom is an untyped test-only dependency in this workspace.
import { JSDOM } from 'jsdom';
import { CODE_LANGUAGES, codeSource, parseCodeContent } from '../../src/features/code/source.ts';
import { highlightCode, MAX_HIGHLIGHT_UNITS } from '../../src/features/code/highlight.ts';

test('oversized code stays complete literal text without creating token DOM or losing later edits', async () => {
	const dom = new JSDOM('<pre></pre>'), host = dom.window.document.querySelector('pre')!;
	try {
		const code = '<script>literal</script>\n' + 'const x = 1;\n'.repeat(MAX_HIGHLIGHT_UNITS);
		const cancel = highlightCode(host, code, 'typescript');
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(host.textContent, code); assert.equal(host.children.length, 0);
		cancel(); highlightCode(host, 'next draft', 'text');
		assert.equal(host.textContent, 'next draft');
	} finally { dom.window.close(); }
});

test('the shared language catalogue has unique safe identifiers and literal source round trips', () => {
	assert.ok(CODE_LANGUAGES.length > 100);
	assert.equal(new Set(CODE_LANGUAGES.map(entry => entry[0])).size, CODE_LANGUAGES.length);
	for (const id of ['rust', 'r', 'go', 'xml', 'markdown', 'java', 'wsl', 'bash', 'python', 'typescript']) assert.ok(CODE_LANGUAGES.some(entry => entry[0] === id), id);
	for (const entry of CODE_LANGUAGES) {
		const code = '<script>alert(1)</script>\n\tvalue = 1';
		const serialized = codeSource(code, false, entry[0]);
		const environment = entry[0] === 'text' ? 'verbatim' : 'lstlisting';
		const body = serialized.replace(new RegExp(`^\\\\begin\\{${environment}\\}`), '').replace(new RegExp(`\\\\end\\{${environment}\\}$`), '');
		assert.deepEqual(parseCodeContent(body, environment), { code, language: entry[0] });
	}
});

test('syntax tokens preserve literal text and cancelled language loads cannot replace a newer draft', async () => {
	const dom = new JSDOM('<pre></pre>'), host = dom.window.document.querySelector('pre')!;
	const literal = 'const text = "<img src=x onerror=alert(1)>";\n// comment';
	const release = highlightCode(host, literal, 'typescript');
	for (let i = 0; i < 100 && !host.querySelector('.tok-keyword'); i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(host.querySelector('.tok-keyword')); assert.ok(host.querySelector('.tok-string')); assert.ok(host.querySelector('.tok-comment'));
	assert.equal(host.textContent, literal); assert.equal(host.querySelectorAll('img,script').length, 0);
	release(); const cancel = highlightCode(host, 'fn stale() {}', 'rust'); cancel(); highlightCode(host, 'new draft', 'text');
	await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(host.textContent, 'new draft'); dom.window.close();
});
