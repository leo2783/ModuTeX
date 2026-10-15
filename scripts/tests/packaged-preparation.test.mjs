import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {waitForPackagePreparation, NPM_PREPARATION_TIMEOUT_MS, APPLICATION_START_TIMEOUT_MS} from './packaged-preparation.mjs';

test('preparation waits for a genuinely delayed child and stops progress after exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60)'], {stdio:'ignore'});
  const exit = once(child, 'exit').then(([code]) => code);
  let progress = 0;
  try {
    assert.equal(await waitForPackagePreparation(exit, {timeoutMs:3000, progressIntervalMs:10, onProgress:()=>progress++}), 0);
    assert.ok(progress > 0);
    const stopped = progress;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(progress, stopped);
  } finally { if(child.exitCode === null) child.kill(); }
});

test('preparation keeps a real failing exit code rather than masking launcher failure', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(23)'], {stdio:'ignore'});
  try {
    assert.equal(await waitForPackagePreparation(once(child, 'exit').then(([code]) => code), {timeoutMs:3000}), 23);
  } finally { if(child.exitCode === null) child.kill(); }
});

test('preparation is bounded and a hung child is not declared ready', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
  const exit = once(child, 'exit').then(([code]) => code);
  try {
    await assert.rejects(waitForPackagePreparation(exit, {timeoutMs:50}), /preparation timed out/);
  } finally { if(child.exitCode === null) child.kill(); await exit; }
});

test('large archive preparation does not extend the application startup deadline', () => {
  assert.equal(NPM_PREPARATION_TIMEOUT_MS, 600_000);
  assert.equal(APPLICATION_START_TIMEOUT_MS, 45_000);
});
