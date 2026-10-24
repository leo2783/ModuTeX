// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Capture only this launch and its descendants, before the caller's cleanup.
export async function waitNativeCdp({ app, port, evidence, lane, stderr, launchError, timeoutMs = 30000 }) {
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (launchError()) throw launchError();
      if (app.exitCode !== null) throw Error(`host exited ${app.exitCode}: ${stderr()}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(Math.min(500, Math.max(1, deadline - Date.now())))
        })).ok) return;
      } catch {}
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw Error(`WebView2 CDP endpoint unavailable after ${timeoutMs}ms`);
  } catch (error) {
    const diagnostic = {
      createdAt: new Date().toISOString(), error: String(error), ownedProcessId: app.pid,
      exitCode: app.exitCode, signalCode: app.signalCode, stderr: stderr().slice(-8192)
    };
    if (app.pid) {
      const command = `$ErrorActionPreference = 'Stop'; . $env:MODUTEX_PROCESS_DIAGNOSTICS; ConvertTo-Json -InputObject @(Get-OwnedProcessSnapshot -OwnedProcessId ${app.pid}) -Depth 4 -Compress`;
      const result = await new Promise(accept => execFile(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe',
        ['-NoProfile', '-Command', command], {
          windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
          env: { ...process.env, MODUTEX_PROCESS_DIAGNOSTICS: join(import.meta.dirname, 'owned-process-diagnostics.ps1') }
        }, (failure, stdout, output) => accept({ failure, stdout, output })));
      try {
        if (result.failure) throw result.failure;
        diagnostic.processes = JSON.parse(result.stdout);
      } catch (failure) { diagnostic.snapshotError = `${failure}: ${result.output}`; }
    }
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, `${lane}-startup-e2e.json`), JSON.stringify(diagnostic, null, 2));
    throw error;
  }
}
