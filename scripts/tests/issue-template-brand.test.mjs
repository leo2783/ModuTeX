import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const templateDirectory = join(root, '.github', 'ISSUE_TEMPLATE');
const templateNames = ['bug_report.yml', 'config.yml', 'feature_request.yml'];

function filesUnder(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
	});
}

function parseIssueTemplates() {
	return Object.fromEntries(
		templateNames.map((name) => {
			const filename = join(templateDirectory, name);
			const parsed = yaml.load(readFileSync(filename, 'utf8'), { filename });
			assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${name} must parse as a YAML mapping`);
			return [name, parsed];
		})
	);
}

function fieldSchema(issueForm) {
	assert.ok(Array.isArray(issueForm.body), `${issueForm.name} must contain a form body`);
	return issueForm.body.map((field) => ({
		type: field.type,
		id: field.id ?? null,
		required: field.validations?.required ?? false
	}));
}

test('actual issue-template YAML parses and keeps field IDs, order, types, and required behavior', () => {
	const filenames = filesUnder(templateDirectory)
		.map((filename) => relative(templateDirectory, filename))
		.sort();
	assert.deepEqual(filenames, [...templateNames].sort());

	const { 'bug_report.yml': bugReport, 'feature_request.yml': featureRequest, 'config.yml': config } = parseIssueTemplates();
	assert.equal(bugReport.name, 'Bug report');
	assert.equal(featureRequest.name, 'Feature request');
	assert.deepEqual(fieldSchema(bugReport), [
		{ type: 'markdown', id: null, required: false },
		{ type: 'textarea', id: 'description', required: true },
		{ type: 'textarea', id: 'steps', required: false },
		{ type: 'textarea', id: 'expected', required: false },
		{ type: 'textarea', id: 'actual', required: false },
		{ type: 'input', id: 'version', required: false },
		{ type: 'input', id: 'os', required: false },
		{ type: 'input', id: 'tex', required: false },
		{ type: 'input', id: 'compile-command', required: false },
		{ type: 'textarea', id: 'context', required: false }
	]);
	assert.deepEqual(fieldSchema(featureRequest), [
		{ type: 'markdown', id: null, required: false },
		{ type: 'textarea', id: 'description', required: true },
		{ type: 'textarea', id: 'alternatives', required: false },
		{ type: 'textarea', id: 'context', required: false }
	]);
	assert.deepEqual(config, {
		blank_issues_enabled: true,
		contact_links: [
			{
				name: 'Discord',
				url: 'https://discord.com/invite/7wanVzCBWf',
				about: 'Questions and general discussion'
			}
		]
	});
});

test('compile guidance stays actionable and the version label uses ModuTeX', () => {
	const { 'bug_report.yml': bugReport } = parseIssueTemplates();
	const instructions = bugReport.body[0].attributes.value;
	assert.match(instructions, /Set a main file in the file explorer/);
	assert.match(instructions, /Check your compile command/);
	assert.match(
		instructions,
		/Can you compile the document in the ModuTeX terminal\? Paste your compile command directly into the terminal and run it/
	);
	assert.match(instructions, /Open a native terminal/);
	assert.match(instructions, /attach the compile log/);
	assert.equal((instructions.match(/Can you compile the document in the ModuTeX terminal\?/g) ?? []).length, 1);
	assert.equal(bugReport.body.find((field) => field.id === 'version')?.attributes.label, 'ModuTeX version');
});

test('issue-template files contain no legacy product identity', () => {
	const filenames = filesUnder(templateDirectory);
	assert.ok(filenames.length > 0);
	for (const filename of filenames) {
		assert.doesNotMatch(readFileSync(filename, 'utf8'), /texpile/i, basename(filename));
	}
});
