import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const text = value => value.replaceAll('\r\n', '\n').trimEnd();

test('production ships the complete notice document and unchanged installed license texts', async () => {
	const source = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
	const shipped = await readFile(new URL('../../dist/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
	assert.equal(shipped, source);
	const sections = source.split(/^## /m).slice(1);
	assert.ok(sections.length > 0, 'Notice document must contain component sections');
	const names = new Set();
	for (const section of sections) {
		const header = section.split(/\r?\n/, 1)[0];
		assert.ok(!names.has(header), 'Duplicate notice: ' + header);
		names.add(header);
		const path = section.match(/^Source: (node_modules\/[A-Za-z0-9@._/-]+)$/m)?.[1];
		const license = section.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1];
		assert.ok(path && !path.split('/').includes('..'), 'Missing or unsafe license source: ' + header);
		assert.ok(license, 'Missing license text: ' + header);
		const installed = await readFile(new URL('../../../../' + path, import.meta.url), 'utf8');
		assert.equal(text(license), text(installed), 'License mismatch: ' + header);
	}
});
