// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const gitPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
const bash = process.platform === 'win32' ? resolve(gitPath, '../../../bin/bash.exe') : 'bash';
const workflow = load(await readFile(join(root, '.github/workflows/tauri-markdown.yml'), 'utf8'));
const command = workflow.jobs['markdown-format'].steps.find((step) => /prettier --check/.test(step.run ?? '')).run;
const run = (script, cwd) =>
	execFileSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
		cwd,
		encoding: 'utf8',
		windowsHide: true,
		timeout: 60000,
		maxBuffer: 2 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe']
	});

test('the exact CI Bash Markdown command succeeds with real installed Prettier', () => {
	assert.match(run(command, root), /All matched files use Prettier code style/);
});

test('CI enumerates only maintained tracked Markdown before invoking Prettier', async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), 'modutex-markdown-list-'));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const included = [
		'README.md',
		'README.zh-TW.md',
		'notes.MD',
		'docs/繁中 with spaces.md',
		'apps/frontend/README.md',
		'docs/distribution/SIGNPATH_ELIGIBILITY.md'
	];
	const excluded = [
		'source.rs',
		'docs/archive/old.md',
		'docs/history/old.md',
		'docs/historical/old.md',
		'docs/legacy/old.md',
		'docs/agents/old.md',
		'docs/AGENTS.md',
		'docs/team/AGENTS.md',
		'docs/team/agent-rules/rule.md',
		'docs/vendor/VENDOR.md',
		'vendor/third-party/README.md',
		'apps/frontend/THIRD_PARTY_NOTICES.md',
		'apps/frontend/LICENSE.md',
		'vendor/notices/TECTONIC-NOTICE.md'
	];
	for (const file of [...included, ...excluded]) {
		await mkdir(dirname(join(cwd, file)), { recursive: true });
		await writeFile(join(cwd, file), '# Fixture\n');
	}
	execFileSync('git', ['init', '--quiet'], { cwd, windowsHide: true });
	execFileSync('git', ['add', '.'], { cwd, windowsHide: true });
	await writeFile(join(cwd, 'private-untracked.md'), 'not tracked');
	// Execute the workflow's actual enumeration, without reimplementing its exclusions in the test.
	const enumerate = command.slice(0, command.indexOf('npm exec'));
	const paths = run(enumerate + '\nprintf \'%s\\0\' "${markdown_files[@]}"\n', cwd)
		.split('\0')
		.filter(Boolean);
	assert.deepEqual(paths.sort(), included.sort());
});
