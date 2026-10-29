import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pdfResourceManifest } from '../../../apps/frontend/scripts/pdfjs-resources.mjs';

test('explicit PDF resource imports match the pinned installed inventory', async () => {
 const expected = await pdfResourceManifest();
 assert.equal(await readFile(new URL('../../../apps/frontend/src/features/pdf/resources.generated.ts', import.meta.url), 'utf8'), expected);
 assert.ok(expected.includes('UniGB-UTF16-H.bcmap?url&no-inline'));
 assert.ok(expected.includes('LiberationSans-Regular.ttf?url&no-inline'));
 assert.ok(!expected.includes('LICENSE_'), 'license texts ship separately under stable .txt paths');
});
