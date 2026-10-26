// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Capture only this launch and its descendants, before the caller's cleanup.
export async function waitNativeCdp({ app, port, evidence, lane, stderr, launchError, timeoutMs = 30000 }) {
  let observedListeners;
  try {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('Native WebView2 CDP port must be an integer between 1 and 65535');
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (launchError()) throw launchError();
      if (app.exitCode !== null) throw Error(`host exited ${app.exitCode}: ${stderr()}`);
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(Math.min(500, Math.max(1, deadline - Date.now())))
        });
      } catch {}
      if (response?.ok) {
        const endpoint = await response.json();
        if (typeof endpoint?.Browser !== 'string' || typeof endpoint?.webSocketDebuggerUrl !== 'string') {
          throw new Error('WebView2 /json/version did not return a CDP endpoint');
        }
        observedListeners = await inspectCdpListeners(app.pid, port);
        assertCdpListenersAreOwnedLoopback(observedListeners, port);
        return;
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw Error(`WebView2 CDP endpoint unavailable after ${timeoutMs}ms`);
  } catch (error) {
    const diagnostic = {
      createdAt: new Date().toISOString(), error: String(error), expectedPort: port, ownedProcessId: app.pid,
      exitCode: app.exitCode, signalCode: app.signalCode, stderr: stderr().slice(-8192)
    };
    if (observedListeners) diagnostic.portListeners = observedListeners;
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

async function inspectCdpListeners(ownedProcessId, port) {
  if (!Number.isSafeInteger(ownedProcessId) || ownedProcessId <= 0) {
    throw new Error('Cannot validate CDP listener ownership without the native host PID');
  }
  const command = `$ErrorActionPreference = 'Stop'; $rootId = ${ownedProcessId}; $port = ${port}; ` +
    '$all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop); ' +
    '$owned = [System.Collections.Generic.HashSet[int]]::new(); [void]$owned.Add($rootId); ' +
    'do { $changed = $false; foreach ($candidate in $all) { ' +
    'if ($owned.Contains([int]$candidate.ParentProcessId) -and $owned.Add([int]$candidate.ProcessId)) { $changed = $true } ' +
    '} } while ($changed); ' +
    '$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | ForEach-Object { ' +
    '$ownerId = [int]$_.OwningProcess; $owner = $all | Where-Object { [int]$_.ProcessId -eq $ownerId } | Select-Object -First 1; ' +
    '[pscustomobject]@{ LocalAddress = [string]$_.LocalAddress; OwningProcess = $ownerId; ' +
    'OwnedByHost = $owned.Contains($ownerId); ProcessName = [string]$owner.Name; CommandLine = [string]$owner.CommandLine } ' +
    '}); ConvertTo-Json -InputObject $listeners -Depth 3 -Compress';
  const result = await new Promise((accept, reject) => execFile(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe',
    ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
    (error, stdout, output) => error ? reject(Error(`${error}: ${output}`)) : accept(stdout.trim())));
  if (!result) return [];
  const listeners = JSON.parse(result);
  return Array.isArray(listeners) ? listeners : [listeners];
}

function assertCdpListenersAreOwnedLoopback(listeners, port) {
  if (listeners.length === 0) throw new Error(`CDP port ${port} has no observable listening socket`);
  const nonLoopback = listeners.filter(listener => !['127.0.0.1', '::1'].includes(listener.LocalAddress));
  if (nonLoopback.length > 0) {
    throw new Error(`CDP port ${port} is bound outside loopback: ${JSON.stringify(nonLoopback)}`);
  }
  if (!listeners.some(listener => listener.LocalAddress === '127.0.0.1')) {
    throw new Error(`CDP port ${port} has no IPv4 loopback listener`);
  }
  const foreign = listeners.filter(listener => listener.OwnedByHost !== true);
  if (foreign.length > 0) {
    throw new Error(`CDP port ${port} is owned by a process outside the tested app tree: ${JSON.stringify(foreign)}`);
  }
  const missingFlags = listeners.filter(listener =>
    !new RegExp(`--remote-debugging-port=${port}(?:\\s|$)`).test(listener.CommandLine ?? '') ||
    !/--remote-debugging-address=127\.0\.0\.1(?:\s|$)/.test(listener.CommandLine ?? ''));
  if (missingFlags.length > 0) {
    throw new Error(`CDP listener process lacks the required loopback startup arguments: ${JSON.stringify(missingFlags)}`);
  }
}
