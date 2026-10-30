// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) && !/^0{40}$/.test(value);
const full = (reason) => ({ full_ci: true, reason });

export function classifyChanges({ eventName, event, forceFull = false, cwd = process.cwd() }) {
	if (forceFull || !['push', 'pull_request'].includes(eventName)) return full('explicit-full-verification');
	let before, after, comparison;
	if (eventName === 'push') {
		if (!event.ref?.startsWith('refs/heads/')) return full('non-branch-push');
		before = event.before;
		after = event.after;
		comparison = 'two-dot';
	} else if (event.action === 'synchronize') {
		before = event.before;
		after = event.pull_request?.head?.sha;
		comparison = 'two-dot';
		if (event.after && event.after !== after) return full('inconsistent-pr-head');
	} else if (['opened', 'reopened'].includes(event.action)) {
		before = event.pull_request?.base?.sha;
		after = event.pull_request?.head?.sha;
		comparison = 'merge-base';
	} else return full('unknown-pr-action');
	if (!commit(before) || !commit(after)) return full('missing-comparison-commit');
	try {
		const range = comparison === 'merge-base' ? `${before}...${after}` : `${before}..${after}`;
		// Renames expose both paths, so renaming source code to *.md cannot hide its deletion.
		const bytes = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const paths = bytes.toString('utf8').split('\0').filter(Boolean);
		if (!paths.length) return full('empty-comparison');
		return { full_ci: !paths.every((path) => /\.md$/i.test(path)), reason: 'changed-paths', file_count: paths.length };
	} catch {
		return full('comparison-unavailable');
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const result = classifyChanges({
		eventName: process.env.GITHUB_EVENT_NAME,
		event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
		forceFull: process.env.FORCE_FULL_CI === 'true'
	});
	await appendFile(process.env.GITHUB_OUTPUT, `full_ci=${result.full_ci}\n`);
	console.log(JSON.stringify(result));
}
