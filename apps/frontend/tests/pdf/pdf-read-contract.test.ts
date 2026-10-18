// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pdfLimit, readPdf} from '../../src/features/files/pdf-read.ts';

test('PDF header validation preserves every input byte, including binary payload', async()=>{
 const bytes=new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0,255,128,10,13]);
 const file=new File([bytes],'中文.PDF');
 const result=await readPdf(file);
 assert.deepEqual(result,bytes);
 result[0]=0;
 assert.deepEqual(new Uint8Array(await file.arrayBuffer()),bytes);
});

test('short and near-matching PDF signatures are rejected', async()=>{
 const header=new Uint8Array([0x25,0x50,0x44,0x46,0x2d]);
 for(let length=0;length<header.length;length++) {
  await assert.rejects(readPdf(new File([header.slice(0,length)],'short.pdf')),/PDF_HEADER/);
 }
 for(let index=0;index<header.length;index++) {
  const wrong=header.slice();wrong[index]=header.at(index)!^1;
  await assert.rejects(readPdf(new File([wrong],'wrong.pdf')),/PDF_HEADER/);
 }
});

test('wrong extension and over-limit size are rejected before reading bytes', async()=>{
 for(const file of [new File(['text'],'source.tex'),new File([new Uint8Array(pdfLimit+1)],'large.pdf')]) {
  let reads=0;
  file.arrayBuffer=async()=>{reads++;throw new Error('UNEXPECTED_READ');};
  await assert.rejects(readPdf(file),file.name.endsWith('.tex')?/FILE_TYPE/:/PDF_TOO_LARGE/);
  assert.equal(reads,0);
 }
});
