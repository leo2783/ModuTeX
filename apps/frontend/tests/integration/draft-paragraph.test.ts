// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import test from 'node:test';

const root=path.resolve(import.meta.dirname,'../../../..');
const frontend=path.resolve(root,process.env.MODUTEX_TEST_FRONTEND_ROOT??'apps/frontend');
const moduleUrl=pathToFileURL(path.join(frontend,'src/features/draft/utf8.ts')).href;
const api=await import(moduleUrl);

test('Draft paragraph ranges preserve LF, CRLF, whitespace separators and Unicode byte offsets',()=>{
 const source='first\r\n \t\r\n漢字 \u{20000} second\r\ncontinued\r\n\r\nlast';
 const from=source.indexOf('漢字'),to=source.indexOf('\r\n\r\n',from);
 const found=api.findEnclosingParagraph(source,{from:from+2,to:from+2});
 assert.equal(found.source,source.slice(from,to));
 assert.deepEqual(found.range,{startByte:Buffer.byteLength(source.slice(0,from)),endByte:Buffer.byteLength(source.slice(0,to))});
 const selected=api.findEnclosingParagraph(source,{from,to:from+2});
 assert.equal(selected.source,'漢字');
 assert.equal(api.findEnclosingParagraph(' \t\r\n'),null);
});

test('Draft offset conversion preserves complete Unicode characters and rejects torn boundaries',()=>{
 const source='A漢\u{20000}Z';
 for(const offset of [0,1,2,4,5]){
  const bytes=api.utf16OffsetToUtf8ByteOffset(source,offset);
  assert.equal(bytes,Buffer.byteLength(source.slice(0,offset)));
  assert.equal(api.utf8ByteOffsetToUtf16Offset(source,bytes),offset);
 }
 assert.throws(()=>api.utf16OffsetToUtf8ByteOffset(source,3));
 assert.throws(()=>api.utf8ByteOffsetToUtf16Offset(source,5));
});

test('Draft adversarial multiline source stays within a worker deadline and memory budget',{timeout:8_000},async()=>{
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
 import(workerData.moduleUrl).then(api=>{
  const source='line\\n'.repeat(900000)+'\\nlast paragraph';
  const last=source.lastIndexOf('last paragraph');
  const current=api.findEnclosingParagraph(source,{from:last,to:last});
  if(current.source!=='last paragraph')throw Error('wrong final paragraph');
  let bounded=false;
  try{api.findEnclosingParagraph(source,{from:2000000,to:2000000});}catch(error){bounded=error.message==='PARAGRAPH_TOO_LARGE';}
  if(!bounded)throw Error('oversized paragraph was not rejected');
  parentPort.postMessage({ok:true});
 }).catch(error=>parentPort.postMessage({error:error.message}));`,{eval:true,workerData:{moduleUrl},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:2}});
 let timer;
 try{
  const result=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Draft scan exceeded its 3-second execution budget')),3000);
   worker.once('message',resolve);worker.once('error',reject);
   worker.once('exit',code=>{if(code!==0)reject(Error('Draft worker exited '+code));});
  });
  assert.deepEqual(result,{ok:true});
 }finally{clearTimeout(timer);await worker.terminate();}
});
