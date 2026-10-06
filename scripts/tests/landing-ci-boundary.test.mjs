import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const workflowDirectory = join(root, '.github/workflows');
const readonlyPermissionValues = new Set(['read', 'none']);
const forbiddenProject = /texpile-desktop/i;
const forbiddenCloudflareWriteSecret = /(?:CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|cloudflare.{0,40}(?:token|account).{0,20}write)/i;
const forbiddenPublishingTool =
	/\b(?:npx|npm\s+exec)\s+[^\r\n;&|]*(?:release-it|semantic-release)(?:@[\w.-]+)?\b|\bnode\s+[^\r\n;&|]*(?:^|[\\/\s])(?:release|update-yml)\.[cm]?js(?:\s|$)/i;
const forbiddenDeployCommand =
	/(?:\bgh\s+release\s+(?:create|upload)\b|\bnpm\s+publish\b|\belectron-builder\b[^\r\n]*--publish(?:\s+|=)(?:always|onTag|onTagOrDraft)\b|\bwrangler\b[^\r\n]*(?:\bdeploy\b|\br2\s+object\s+put\b)|\b(?:createRelease|publishRelease|uploadReleaseAsset)\s*\(|(?:^|[\r\n;&|])\s*(?:deploy|deployment|publish|release)(?:\s|$)|\bnpm\s+run\s+(?:deploy|publish|release)\b)/i;
const forbiddenDeployAction = /(?:deploy|publish|release|gh-pages|wrangler|cloudflare)/i;
const forbiddenDeployName = /\b(?:deploy|deployment|publish|release|rollout)\b/i;

function parseWorkflow(filename) {
	const source = readFileSync(filename, 'utf8');
	const workflow = yaml.load(source, { filename });
	assert.ok(workflow && typeof workflow === 'object' && !Array.isArray(workflow), `${filename} must contain a YAML mapping`);
	assert.ok(workflow.jobs && typeof workflow.jobs === 'object' && !Array.isArray(workflow.jobs), `${filename} must declare jobs`);
	return { source, workflow };
}

function assertReadonlyPermissions(permissions, owner) {
	assert.ok(permissions && typeof permissions === 'object' && !Array.isArray(permissions), `${owner} must declare scoped permissions`);
	for (const [scope, access] of Object.entries(permissions)) {
		assert.ok(readonlyPermissionValues.has(access), `${owner} grants ${scope}: ${String(access)}; only read or none is allowed`);
	}
}

function assertLocalReusableWorkflow(job, owner) {
	if (job.uses === undefined) return;

	assert.match(
		job.uses,
		/^\.\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,
		`${owner} must call a local workflow file so its steps and permissions remain auditable`
	);

	const relativeWorkflowPath = job.uses.slice('./.github/workflows/'.length);
	const localWorkflowPath = join(workflowDirectory, relativeWorkflowPath);
	assert.ok(existsSync(localWorkflowPath), `${owner} references a missing local reusable workflow`);
	assert.ok(lstatSync(localWorkflowPath).isFile(), `${owner} reusable workflow must be a regular local file`);
	const { workflow } = parseWorkflow(localWorkflowPath);
	const triggers = workflow.on ?? workflow['on'];
	assert.ok(
		triggers && typeof triggers === 'object' && Object.hasOwn(triggers, 'workflow_call'),
		`${owner} local reusable workflow must declare the workflow_call trigger`
	);
}

function scalarValues(value, values = []) {
	if (typeof value === 'string') {
		values.push(value);
	} else if (Array.isArray(value)) {
		for (const child of value) scalarValues(child, values);
	} else if (value && typeof value === 'object') {
		for (const [key, child] of Object.entries(value)) {
			values.push(key);
			scalarValues(child, values);
		}
	}
	return values;
}

test('Cloudflare landing deployment workflow is removed rather than disabled', () => {
	assert.equal(
		existsSync(join(workflowDirectory, 'landing.yml')),
		false,
		'landing.yml must not be retained as a disabled or no-op deployment workflow'
	);
});

test('all remaining workflows parse and have read-only GitHub token permissions', () => {
	const filenames = readdirSync(workflowDirectory)
		.filter((name) => /\.ya?ml$/i.test(name))
		.sort()
		.map((name) => join(workflowDirectory, name));
	assert.ok(filenames.length > 0, 'at least one GitHub Actions workflow must remain');

	for (const filename of filenames) {
		const { workflow } = parseWorkflow(filename);
		assertReadonlyPermissions(workflow.permissions, filename);
		for (const [jobId, job] of Object.entries(workflow.jobs)) {
			assertLocalReusableWorkflow(job, `${filename}:${jobId}`);
			if (job.permissions !== undefined) assertReadonlyPermissions(job.permissions, `${filename}:${jobId}`);
		}
	}
});

test('external reusable workflows are rejected while local workflow paths stay inspectable', () => {
	const externalWorkflowFixture = yaml.load(`
jobs:
  deploy:
    uses: attacker/repo/.github/workflows/deploy.yml@main
`);
	assert.throws(
		() => assertLocalReusableWorkflow(externalWorkflowFixture.jobs.deploy, 'fixture:deploy'),
		/must call a local workflow file/
	);

	const localWorkflowFixture = yaml.load(`
jobs:
  verify:
    uses: ./.github/workflows/test.yml
`);
	assert.doesNotThrow(() => assertLocalReusableWorkflow(localWorkflowFixture.jobs.verify, 'fixture:verify'));
});

test('workflow jobs and parsed shell/action steps contain no deployment surface', () => {
	const filenames = readdirSync(workflowDirectory)
		.filter((name) => /\.ya?ml$/i.test(name))
		.sort()
		.map((name) => join(workflowDirectory, name));

	for (const filename of filenames) {
		const { source, workflow } = parseWorkflow(filename);
		const values = scalarValues(workflow);
		assert.ok(!values.some((value) => forbiddenProject.test(value)), `${filename} references the removed Pages project`);
		assert.ok(!values.some((value) => forbiddenCloudflareWriteSecret.test(value)), `${filename} references a Cloudflare write credential`);
		assert.doesNotMatch(source, forbiddenProject, `${filename} contains the removed Pages project, including comments`);
		assert.doesNotMatch(source, forbiddenCloudflareWriteSecret, `${filename} contains a Cloudflare write credential reference`);

		for (const [jobId, job] of Object.entries(workflow.jobs)) {
			assert.doesNotMatch(`${jobId} ${job.name ?? ''}`, forbiddenDeployName, `${filename} has a deployment job`);
			assert.equal(job.environment, undefined, `${filename}:${jobId} must not target a deployment environment`);
			for (const [index, step] of (job.steps ?? []).entries()) {
				const label = `${filename}:${jobId}:step ${index + 1}`;
				assert.doesNotMatch(step.name ?? '', forbiddenDeployName, `${label} has a deployment step`);
				if (typeof step.uses === 'string') {
					assert.doesNotMatch(step.uses, forbiddenDeployAction, `${label} invokes a deploy/publish/release action`);
				}
				if (typeof step.run === 'string') {
					assert.doesNotMatch(step.run, forbiddenDeployCommand, `${label} runs a deployment command`);
					assert.doesNotMatch(step.run, forbiddenPublishingTool, `${label} invokes a publication helper`);
				}
			}
		}
	}
});

test('shared CI parses the landing build as an executable step', () => {
	const filename = join(workflowDirectory, 'test.yml');
	const { workflow } = parseWorkflow(filename);
	const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
	assert.ok(
		steps.some((step) => step.run?.trim() === 'npm run build --workspace=modutex-landing'),
		'test.yml must build modutex-landing in CI'
	);
});

test('publication command boundary rejects real release surfaces without rejecting local checksum paths', () => {
	for (const command of [
		'gh release create v0.1.0',
		'gh release upload v0.1.0 release/installer.exe',
		'npm publish',
		'electron-builder --publish always',
		'electron-builder --publish=onTag',
		'wrangler deploy',
		'wrangler r2 object put bucket/installer.exe',
		'createRelease(version)',
		'publishRelease(version)',
		'uploadReleaseAsset(asset)',
		'npm run release',
		'release v0.1.0'
	]) {
		assert.match(command, forbiddenDeployCommand, `publication must remain blocked: ${command}`);
	}
	for (const command of [
		"$installerPath = 'release\\ModuTeX-Setup-0.1.0.exe'",
		'Get-FileHash -LiteralPath $installerPath -Algorithm SHA256',
		'Copy-Item -LiteralPath release\\ModuTeX-Setup-0.1.0.exe -Destination artifact',
		'npm run dist -- --win --x64'
	]) {
		assert.doesNotMatch(command, forbiddenDeployCommand, `local artifact operation is not publication: ${command}`);
		assert.doesNotMatch(command, forbiddenPublishingTool, `local artifact operation is not a publication helper: ${command}`);
	}
	for (const command of [
		'npx release-it',
		'npx --yes semantic-release@25.0.0',
		'npm exec -- release-it',
		'node scripts/release.mjs',
		'node scripts/update-yml.mjs',
		'node scripts/release.cjs'
	]) {
		assert.match(command, forbiddenPublishingTool, `publication tooling must remain blocked: ${command}`);
	}
});
