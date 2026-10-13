import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lunaInput, commonLunaFiles } from '../agents/luna-input.mjs';
test('changing assignments keep the same shared prefix without duplicated source', async () => {
 const files = new Map(commonLunaFiles.map(path => [path, 'shared '+path]));
 files.set('one', 'one changed'); files.set('two', 'two changed');
 const read = async path => { assert.ok(files.has(path)); return files.get(path); };
 const a = await lunaInput({ files: ['one', ...commonLunaFiles], prompt: 'math' }, read);
 const b = await lunaInput({ files: ['two'], prompt: 'code' }, read);
 assert.deepEqual(a[0], b[0]);
 assert.equal(a[1].content[0].text.includes('shared '), false);
 assert.equal(a[2].content[0].text, 'math');
 assert.notDeepEqual(a[1], b[1]);
});
