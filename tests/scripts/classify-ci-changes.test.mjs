// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { classifyChanges } from './classify-ci-changes.mjs';

test('real Git changes select Markdown-only work without masking source changes', async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), 'modutex-ci-changes-'));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
	git('init', '--quiet');
	git('config', 'user.name', 'CI fixture');
	git('config', 'user.email', 'ci@example.invalid');
	const save = () => {
		git('add', '-A');
		git('commit', '--quiet', '-m', 'fixture');
		return git('rev-parse', 'HEAD');
	};
	await writeFile(join(cwd, 'source.rs'), 'source');
	await writeFile(join(cwd, 'README.md'), 'before');
	const base = save();
	await writeFile(join(cwd, 'source.rs'), 'changed code');
	const code = save();
	await writeFile(join(cwd, 'README.md'), 'new docs');
	await mkdir(join(cwd, 'docs'));
	await writeFile(join(cwd, 'docs', '繁中 with spaces.md'), 'docs');
	const docs = save();
	const push = (before, after, extra = {}) =>
		classifyChanges({ cwd, eventName: 'push', event: { ref: 'refs/heads/dev', before, after }, ...extra });
	assert.equal(push(code, docs).full_ci, false, 'only the current push, not earlier code changes');
	assert.equal(push(base, docs).full_ci, true, 'a multi-commit mixed push includes all changes');
	const pr = { base: { sha: base }, head: { sha: docs } };
	assert.equal(
		classifyChanges({ cwd, eventName: 'pull_request', event: { action: 'synchronize', before: code, after: docs, pull_request: pr } })
			.full_ci,
		false
	);
	for (const action of ['opened', 'reopened'])
		assert.equal(classifyChanges({ cwd, eventName: 'pull_request', event: { action, pull_request: pr } }).full_ci, true);
	assert.equal(
		classifyChanges({
			cwd,
			eventName: 'pull_request',
			event: { action: 'opened', pull_request: { base: { sha: code }, head: { sha: docs } } }
		}).full_ci,
		false
	);
	git('mv', 'source.rs', 'source.md');
	const renamedCode = save();
	assert.equal(push(docs, renamedCode).full_ci, true, 'both rename paths must count');
	git('mv', 'README.md', 'GUIDE.md');
	const renamedDocs = save();
	assert.equal(push(renamedCode, renamedDocs).full_ci, false);
	await rm(join(cwd, 'GUIDE.md'));
	const deletedDocs = save();
	assert.equal(push(renamedDocs, deletedDocs).full_ci, false);
	await writeFile(join(cwd, 'docs', 'not-markdown.png'), 'image');
	const asset = save();
	assert.equal(push(deletedDocs, asset).full_ci, true, 'non-md assets in docs still require full CI');
	git('mv', 'source.md', 'source.rs');
	const renamedToCode = save();
	assert.equal(push(asset, renamedToCode).full_ci, true, 'renaming Markdown into source code requires full CI');
	assert.equal(push(code, docs, { forceFull: true }).full_ci, true, 'release/reusable CI must never skip builds');
	for (const [before, after] of [
		[docs, docs],
		['0'.repeat(40), docs],
		['a'.repeat(40), docs],
		['--help', docs]
	])
		assert.equal(push(before, after).full_ci, true);
	assert.equal(classifyChanges({ cwd, eventName: 'push', event: { ref: 'refs/tags/v0.3.0', before: code, after: docs } }).full_ci, true);
	assert.equal(classifyChanges({ cwd, eventName: 'workflow_dispatch', event: {} }).full_ci, true);
	assert.equal(
		classifyChanges({ cwd, eventName: 'pull_request', event: { action: 'synchronize', before: code, after: base, pull_request: pr } })
			.full_ci,
		true
	);
});

test('workflow gates the full graph while Markdown remains independent and releases force full CI', async () => {
	const workflow = load(await readFile(new URL('../../.github/workflows/tauri-ci.yml', import.meta.url), 'utf8'));
	const jobs = workflow.jobs;
	assert.equal(jobs['source-identity'].if, "needs.changes.outputs.full_ci == 'true'");
	assert.deepEqual(jobs['source-identity'].needs, ['validate-source-ref', 'changes']);
	assert.deepEqual(jobs.markdown.needs, ['validate-source-ref', 'changes']);
	assert.equal(jobs.markdown.if, undefined);
	assert.equal(jobs.markdown.with.checkout_ref, '${{ needs.validate-source-ref.outputs.checkout_ref }}');
	const ancestors = (id) =>
		(Array.isArray(jobs[id].needs) ? jobs[id].needs : [jobs[id].needs]).filter(Boolean).flatMap((parent) => [parent, ...ancestors(parent)]);
	for (const id of [
		'frontend',
		'rust',
		'supply-chain',
		'desktop-build',
		'native-e2e',
		'distribution-policy',
		'package-validation',
		'installer-lifecycle'
	])
		assert(ancestors(id).includes('source-identity'), `${id} must be downstream of full-CI admission`);
	const classify = jobs.changes.steps.find((step) => step.id === 'changes');
	assert.equal(classify.run, 'node tests/scripts/classify-ci-changes.mjs');
	assert.equal(
		classify.env.FORCE_FULL_CI,
		"${{ inputs.formal_release || inputs.checkout_ref != '' || github.event_name == 'workflow_dispatch' }}"
	);
	assert.equal(jobs.changes.outputs.full_ci, '${{ steps.changes.outputs.full_ci }}');
});
