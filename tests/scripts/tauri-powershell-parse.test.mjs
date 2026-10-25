// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

async function collectWorkflowPaths(root) {
  const pending = [
    resolve(root, '.github/workflows/tauri-ci.yml'),
    resolve(root, '.github/workflows/tauri-release.yml')
  ];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const workflow = load(await readFile(current, 'utf8'));
    for (const job of Object.values(workflow.jobs ?? {})) {
      if (typeof job.uses === 'string' && job.uses.startsWith('./.github/workflows/')) {
        pending.push(resolve(root, job.uses.slice(2)));
      }
    }
  }
  return [...seen];
}

test('Windows CI/CD blocks and distribution scripts parse with the actual PowerShell parser', async () => {
  const root = resolve(process.env.MODUTEX_TEST_DISTRIBUTION_ROOT ?? '.');
  const inputs = [];
  for (const workflowPath of await collectWorkflowPaths(root)) {
    const workflow = load(await readFile(workflowPath, 'utf8'));
    const name = workflowPath.slice(resolve(root, '.github/workflows').length + 1);
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      for (const step of definition.steps ?? []) {
        const shell = step.shell ?? definition.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
        if (typeof step.run === 'string' && /^(?:pwsh|powershell)(?:\s|$)/.test(shell ?? '')) {
          // GitHub resolves expressions before invoking PowerShell.
          const source = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, '1');
          inputs.push({ label: `${name}/${job}/${step.name}`, source });
        }
      }
    }
  }
  for (const name of ['verify-authenticode-signature.ps1', 'verify-installer-payload.ps1']) {
    inputs.push({ label: name, source: await readFile(join(root, 'scripts/distribution', name), 'utf8') });
  }
  for (const name of ['ci-bounded-process.ps1', 'owned-process-diagnostics.ps1', 'owned-native-popups.ps1', 'select-owned-folder.ps1', 'cancel-owned-dialog.ps1']) {
    inputs.push({ label: name, source: await readFile(join(root, 'tests/scripts/helpers', name), 'utf8') });
  }
  assert(inputs.length > 10);
  const fixture = await mkdtemp(join(tmpdir(), 'modutex-pwsh-parse-'));
  try {
    const input = join(fixture, 'sources.json'); await writeFile(input, JSON.stringify(inputs));
    const command = `
$ErrorActionPreference='Stop'
$issues=@()
foreach($item in (Get-Content -LiteralPath $env:MODUTEX_PARSER_INPUT -Raw | ConvertFrom-Json)) {
 $tokens=$null;$errors=$null
 [void][System.Management.Automation.Language.Parser]::ParseInput($item.source,[ref]$tokens,[ref]$errors)
 foreach($taskParseIssue in $errors){$issues+=@{label=$item.label;line=$taskParseIssue.Extent.StartLineNumber;message=$taskParseIssue.Message}}
}
ConvertTo-Json -InputObject @($issues) -Compress -Depth 4
if($issues.Count){exit 1}
`;
    const result = await new Promise(accept => execFile(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-Command', command],
      { windowsHide: true, timeout: 15000, env: { ...process.env, MODUTEX_PARSER_INPUT: input } },
      (error, stdout, stderr) => accept({ code: error?.code ?? 0, output: stdout + stderr })));
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(result.output.trim()), [], result.output);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
