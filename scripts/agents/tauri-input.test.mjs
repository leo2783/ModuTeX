import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { commonLunaFiles, lunaInput } from './tauri-input.mjs';

const snapshot = Object.fromEntries([...commonLunaFiles,'module-a.ts','module-b.ts'].map(path=>[path,'fixed source: '+path]));
const hashes=Object.fromEntries(Object.entries(snapshot).map(([path,text])=>[path,createHash('sha256').update(text).digest('hex')]));
const read=async path=>snapshot[path];

test('different tasks preserve identical common and ordered module cache prefixes',async()=>{
 const a=await lunaInput({files:['module-b.ts','module-a.ts','module-a.ts'],prompt:'task one',sourceHashes:hashes},read);
 const b=await lunaInput({files:['module-a.ts','module-b.ts'],prompt:'task two',sourceHashes:hashes},read);
 assert.deepEqual(a.slice(0,2),b.slice(0,2));
 assert.notDeepEqual(a[2],b[2]);
 assert.equal(a[1].content[0].text.match(/FILE: module-a.ts/g).length,1);
});
test('stale or missing snapshot hashes reject input construction before an API request',async()=>{
 const task={files:['module-a.ts'],prompt:'inventory',sourceHashes:hashes};
 await assert.rejects(lunaInput(task,async path=>path==='module-a.ts'?'changed':snapshot[path]),/STALE_SOURCE/);
 await assert.rejects(lunaInput({...task,sourceHashes:{}},read),/STALE_SOURCE/);
});
