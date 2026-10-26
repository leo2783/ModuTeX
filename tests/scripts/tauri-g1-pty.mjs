// SPDX-License-Identifier: Apache-2.0
// Native acceptance: build the g1-prototypes pty_probe example before running.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.platform,'win32','requires real Windows ConPTY');
const root=resolve(import.meta.dirname,'../..');
const executable=resolve(root,'apps/desktop-tauri/target/debug/examples/pty_probe.exe');
const output=resolve(root,'.verification-artifacts/tauri','pty-acceptance-'+randomUUID());
await mkdir(output);
const exeSha256=createHash('sha256').update(await readFile(executable)).digest('hex');

async function run(args) {
 const child=spawn(executable,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',b=>{stdout=(stdout+b).slice(-32768);});
 child.stderr.on('data',b=>{stderr=(stderr+b).slice(-8192);});
 return new Promise((ok,bad)=>{
  const deadline=setTimeout(()=>{
   if(child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>bad(Error('PTY acceptance timeout')));
   else bad(Error('PTY acceptance timeout before launch'));
  },45000);
  child.once('error',error=>{clearTimeout(deadline);bad(error);});
  child.once('close',(code,signal)=>{clearTimeout(deadline);ok({code,signal,stdout,stderr});});
 });
}

async function assertProcessGone(pid) {
 assert.ok(Number.isSafeInteger(pid)&&pid>0,'real child PID recorded');
 for(let attempt=0;attempt<20;attempt++) {
  try {process.kill(pid,0);} catch(error) {
   if(error.code==='ESRCH')return;
   throw error;
  }
  await delay(50);
 }
 assert.fail(`PTY child ${pid} remains alive after teardown`);
}

const results=[];
for(const [mode,flag] of [['normal',null],['fail_after_reader','--fail-after-reader'],['cancel_live','--cancel-live']]) {
 const destination=resolve(output,mode);
 const execution=await run([destination,...flag?[flag]:[]]);
 assert.equal(execution.code,0,JSON.stringify(execution));
 const receipt=JSON.parse(await readFile(resolve(destination,'probe_result.json'),'utf8'));
 assert.equal(receipt.mode,mode);
 for(const key of ['overall_success','cleanup_succeeded','child_reaped','writer_closed','reader_joined'])assert.equal(receipt[key],true,key);
 assert.equal(receipt.actual_cleanup_failure,false);
 assert.equal(receipt.unexpected_sequence_error,null);
 assert.equal(receipt.overflow.has_overflow,false);
 assert.equal(receipt.forced_kill,Boolean(flag));
 assert.equal(receipt.expected_fault_injected,Boolean(flag));
 if(mode==='normal') {
  assert.equal(receipt.child_exit.exit_code,0);
  assert.equal(receipt.initial_size.matched,true);
  assert.equal(receipt.final_size.matched,true);
 }
 if(mode!=='fail_after_reader') {
  assert.equal(receipt.marker_detected,true);
  const transcript=await readFile(resolve(destination,'transcript.bin'));
  assert.ok(transcript.includes(Buffer.from('中文終端\ud840\udc00')),'actual shell produced combined Unicode marker');
 }
 await assertProcessGone(receipt.process_id);
 results.push({mode,receipt:resolve(destination,'probe_result.json'),childPid:receipt.process_id});
 console.log('PTY accepted: '+mode);
}
const invalidDestination=resolve(output,'must-not-exist');
const invalid=await run([invalidDestination,'--unknown-mode']);
assert.notEqual(invalid.code,0,'unknown flags must fail');
await assert.rejects(access(invalidDestination),{code:'ENOENT'});
const summary={status:'passed',exeSha256,results,unknownFlagRejectedBeforeFilesystem:true};
await writeFile(resolve(output,'acceptance.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({output,...summary}));
