// SPDX-License-Identifier: Apache-2.0
// Surface failing node:test cases from TAP reports as GitHub annotations and a job summary,
// so failures are readable without opening the full raw log.
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FAILURES = 50;
const escapeData = (value) => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (value) => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

export function parseTapFailures(text) {
	const lines = text.split(/\r?\n/);
	const failures = [];
	const names = [];
	for (let index = 0; index < lines.length; index++) {
		const match = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # .*)?$/.exec(lines[index]);
		const subtest = /^(\s*)# Subtest: (.*)$/.exec(lines[index]);
		if (subtest) {
			const depth = subtest[1].length / 4;
			names.length = depth;
			names[depth] = subtest[2];
			continue;
		}
		if (!match || match[2] !== 'not ok') continue;
		const indent = match[1].length;
		const detail = { name: match[3], path: [...names.slice(0, indent / 4), match[3]], error: '', location: '' };
		for (let next = index + 1; next < lines.length; next++) {
			const line = lines[next];
			if (/^\s*\.\.\.\s*$/.test(line)) break;
			const field = /^\s*(error|location|failureType):\s*(.*)$/.exec(line);
			if (!field) continue;
			let value = field[2].replace(/^['"]|['"]$/g, '');
			if (value === '|-' || value === '>-' || value === '|' || value === '>') {
				const block = [];
				for (let cont = next + 1; cont < lines.length && /^\s{6,}\S/.test(lines[cont]) && block.length < 6; cont++) block.push(lines[cont].trim());
				value = block.join(' ');
			}
			if (field[1] === 'error' && !detail.error) detail.error = value;
			if (field[1] === 'location' && !detail.location) detail.location = value;
		}
		// Parents of failing subtests also report "not ok"; keep the most specific leaf only.
		const parentOfPrevious = failures.length && failures.at(-1).path.length > detail.path.length &&
			failures.at(-1).path.slice(0, detail.path.length).join('\u0000') === detail.path.join('\u0000');
		if (!parentOfPrevious) failures.push(detail);
	}
	return failures;
}

export async function reportFailures(directory, summaryFile = process.env.GITHUB_STEP_SUMMARY) {
	let files = [];
	try { files = (await readdir(directory)).filter((name) => name.endsWith('.tap')).sort(); } catch { /* no reports */ }
	const rows = [];
	for (const file of files) {
		for (const failure of parseTapFailures(await readFile(join(directory, file), 'utf8'))) rows.push({ file, ...failure });
	}
	for (const row of rows.slice(0, MAX_FAILURES)) {
		const location = /^(.*?):(\d+):\d+$/.exec(row.location.replace(/^file:\/\/\/?/, ''));
		const properties = [`title=${escapeProperty(row.path.join(' > ').slice(0, 200))}`];
		if (location) {
			const workspace = (process.env.GITHUB_WORKSPACE ?? '').replaceAll('\\', '/');
			const file = location[1].replaceAll('\\', '/');
			properties.push(`file=${escapeProperty(workspace && file.startsWith(workspace) ? file.slice(workspace.length + 1) : file)}`, `line=${location[2]}`);
		}
		console.log(`::error ${properties.join(',')}::${escapeData((row.error || 'Test failed').slice(0, 1000))}`);
	}
	const body = [
		`### Failing tests (${rows.length})`,
		'',
		rows.length ? '| Report | Test | Error |' : files.length ? 'No failing test entries were found in the TAP reports; see the raw step log.' : 'No TAP reports were produced; the failure happened before tests started.',
		...(rows.length ? ['| --- | --- | --- |'] : []),
		...rows.slice(0, MAX_FAILURES).map((row) => `| ${row.file} | ${row.path.join(' > ').replaceAll('|', '\\|')} | ${(row.error || '').replaceAll('|', '\\|').slice(0, 300)} |`),
		''
	].join('\n');
	console.log(body);
	if (summaryFile) await appendFile(summaryFile, body + '\n');
	return rows;
}

if (import.meta.main) {
	const directory = process.argv[2];
	if (!directory) throw new Error('usage: ci-test-report.mjs <tap-report-directory>');
	await reportFailures(directory);
}
