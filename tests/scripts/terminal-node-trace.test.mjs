import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('terminal fixture records startup and flushed markers independently of PTY output', { timeout: 10000 }, async t => {
 const directory = await mkdtemp(path.join(tmpdir(), 'terminal-trace-'));
 await copyFile(new URL('../../apps/desktop-tauri/tests/fixtures/terminal-node-tree.cjs', import.meta.url), path.join(directory, 'fixture.cjs'));
 const child = spawn(process.execPath, [path.join(directory, 'fixture.cjs')], { cwd: directory });
 let output = '';
 t.after(async () => { const pid = /_CHILD_(\d+)/.exec(output)?.[1]; if (pid) { try { process.kill(Number(pid)); } catch (error) { if (error.code !== 'ESRCH') throw error; } } child.kill(); await rm(directory, { recursive: true, force: true }); });
 await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('markers not received within original six-second budget')), 6000);
  child.on('error', reject);
  child.stdout.on('data', bytes => { output += bytes; if (output.includes('GRANDCHILD_NODE_UTF8_終端𠀀_READY_') && output.includes('LEADER_NODE_PID_')) { clearTimeout(timer); resolve(); } });
 });
 const trace = (await readFile(path.join(directory, 'startup-trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
 for (const phase of ['leader-start', 'child-spawned', 'grandchild-start', 'leader-marker-flushed', 'grandchild-marker-flushed']) assert.ok(trace.some(event => event.phase === phase), `missing ${phase}: ${JSON.stringify(trace)}`);
 await writeFile(path.join(directory, 'release-leader'), 'exit');
 await new Promise(resolve => child.once('exit', resolve));
});
