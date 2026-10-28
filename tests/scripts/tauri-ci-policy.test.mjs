import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { dump, load } from 'js-yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const ACTIONS = new Set([
	'./.github/actions/setup-document-core-wasm',
	'actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd',
	'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
	'actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f'
]);
const MANIFESTS = ['apps/desktop-tauri/Cargo.toml', 'crates/document-core/Cargo.toml'];
const GATES = {
	markdown: /prettier\s+--check/,
	types: /npm run frontend:check/,
	frontend: /npm run frontend:test/,
	assets: /npm run frontend:build:tauri/,
	browser: /apps\/frontend\/tests\/e2e\/draft-panel-browser\.e2e\.mjs/,
	contracts: /npm run test --workspace=@modutex\/frontend-contracts/,
	document: /node --test crates\/document-core\/tests\/wasm\.test\.mjs/,
	format: /cargo fmt\b/,
	clippy: /cargo clippy\b/,
	rust: /cargo test\b/,
	build: /cargo build --manifest-path apps\/desktop-tauri\/Cargo\.toml/,
	e2e: /tests\/scripts\/tauri-g2-workbench-e2e\.mjs/
};
const stepsOf = (job) => job.steps ?? [];
const commands = (job) =>
	stepsOf(job)
		.map((step) => step.run ?? '')
		.join('\n');
const needsOf = (job) => (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []));

async function workflowNode(filePath, repositoryRoot, active = []) {
	const absolutePath = resolve(filePath);
	if (active.includes(absolutePath)) {
		throw new Error(`Reusable workflow cycle detected: ${[...active, absolutePath].join(' -> ')}`);
	}

	let source;
	try {
		source = await readFile(absolutePath, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') throw new Error(`Missing reusable workflow: ${absolutePath}`);
		throw error;
	}

	const workflow = load(source, { filename: absolutePath });
	assert(workflow?.jobs && typeof workflow.jobs === 'object', `Workflow jobs required in ${absolutePath}`);
	const node = { path: absolutePath, repositoryRoot, workflow, children: {} };
	const nextActive = [...active, absolutePath];
	const workflowsDirectory = resolve(repositoryRoot, '.github/workflows');

	for (const [jobId, job] of Object.entries(workflow.jobs)) {
		if (job.uses === undefined) continue;
		assert(
			typeof job.uses === 'string' && job.uses.startsWith('./.github/workflows/'),
			`Unreviewed reusable workflow reference in ${absolutePath}/${jobId}`
		);
		assert.match(job.uses, /^\.\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/);
		const targetPath = resolve(repositoryRoot, job.uses.slice(2));
		assert(
			targetPath.startsWith(workflowsDirectory + sep),
			`Reusable workflow escaped .github/workflows: ${job.uses}`
		);
		node.children[jobId] = await workflowNode(targetPath, repositoryRoot, nextActive);
	}
	return node;
}

function workflowNodes(root) {
	const result = [];
	function visit(node) {
		result.push(node);
		for (const child of Object.values(node.children)) visit(child);
	}
	visit(root);
	return result;
}

function expandedJobs(root) {
	const result = [];
	function visit(node, prefix = '', rootCallId = null) {
		for (const [jobId, job] of Object.entries(node.workflow.jobs)) {
			const qualifiedId = prefix ? `${prefix}/${jobId}` : jobId;
			const child = node.children[jobId];
			if (child) {
				visit(child, qualifiedId, rootCallId ?? jobId);
			} else {
				result.push({ qualifiedId, jobId, rootCallId, node, job });
			}
		}
	}
	visit(root);
	return result;
}

function expandedJob(root, qualifiedId) {
	const match = expandedJobs(root).find((entry) => entry.qualifiedId === qualifiedId);
	assert(match, `Expanded job ${qualifiedId} was not found`);
	return match;
}

function rootAncestors(rootWorkflow, jobId) {
	const result = new Set();
	function visit(currentId) {
		for (const dependency of needsOf(rootWorkflow.jobs[currentId])) {
			if (result.has(dependency)) continue;
			result.add(dependency);
			visit(dependency);
		}
	}
	visit(jobId);
	return result;
}

async function workflow() {
	const mainPath = resolve(ROOT, process.env.MODUTEX_TEST_CI_WORKFLOW ?? '.github/workflows/tauri-ci.yml');
	return workflowNode(mainPath, ROOT);
}

function gateJobs(wf) {
	return Object.fromEntries(
		Object.entries(GATES).map(([name, pattern]) => {
			const matches = expandedJobs(wf).filter(({ job }) =>
				pattern.test(commands(job) + JSON.stringify(job.strategy ?? {}))
			);
			assert.equal(matches.length, 1, `required gate ${name} must run in exactly one expanded job`);
			return [name, matches[0].qualifiedId];
		})
	);
}

function validateDependencyGraph(node) {
	const jobs = node.workflow.jobs;
	const complete = new Set();
	const active = new Set();
	function visit(jobId) {
		assert(jobs[jobId], `unknown dependency ${jobId} in ${node.path}`);
		assert(!active.has(jobId), `CI dependency cycle at ${node.path}/${jobId}`);
		if (complete.has(jobId)) return;
		active.add(jobId);
		for (const dependency of needsOf(jobs[jobId])) {
			assert(jobs[dependency], `unknown dependency ${dependency} in ${node.path}/${jobId}`);
			visit(dependency);
		}
		active.delete(jobId);
		complete.add(jobId);
	}
	for (const jobId of Object.keys(jobs)) visit(jobId);
}

function validatePackageAndLifecycle(wf, gates) {
	const packageJob = expandedJobs(wf).find(entry => entry.jobId === 'package-validation');
	assert(packageJob, 'package-validation job is required');
	const packageCommands = commands(packageJob.job);
	assert.equal((packageCommands.match(/tauri bundle --target x86_64-pc-windows-msvc/g) ?? []).length, 2);
	assert.match(packageCommands, /--config tauri\.offline\.conf\.json/);
	assert.match(packageCommands, /EXPECTED_EXE_SHA/);
	assert.match(packageCommands, /verify-installer-payload\.ps1/);
	assert.match(packageCommands, /payload-receipt-online\.json/);
	assert.match(packageCommands, /payload-receipt-offline\.json/);
	assert.match(packageCommands, /cargo metadata --locked --offline/);
	assert.match(packageCommands, /TECTONIC-LICENSE\.txt/);

	const packageUploads = stepsOf(packageJob.job).filter((step) =>
		step.uses?.startsWith('actions/upload-artifact@')
	);
	const onlineUpload = packageUploads.find((step) => step.name === 'Upload validated online installer');
	const offlineUpload = packageUploads.find((step) => step.name === 'Upload validated offline installer');
	assert(onlineUpload, 'validated online installer artifact upload is required');
	assert(offlineUpload, 'validated offline installer artifact upload is required');
	assert.match(onlineUpload.with?.name ?? '', /Online-Installer/);
	assert.match(onlineUpload.with?.path ?? '', /setup-online\.exe/);
	assert.match(offlineUpload.with?.name ?? '', /Offline-Installer/);
	assert.match(offlineUpload.with?.path ?? '', /setup-offline\.exe/);

	const rootWorkflow = wf.workflow;
	const packageNeeds = rootAncestors(rootWorkflow, 'package-validation');
	for (const gateJobId of Object.values(gates)) {
		const gate = expandedJob(wf, gateJobId);
		assert(gate.rootCallId, `${gateJobId} must be inside a reusable workflow`);
		assert(packageNeeds.has(gate.rootCallId), `package validation must wait for ${gate.rootCallId}`);
	}

	const desktopCall = rootWorkflow.jobs['desktop-build'];
	assert.deepEqual(needsOf(desktopCall), ['source-identity', 'frontend']);
	const nativeCall = rootWorkflow.jobs['native-e2e'];
	assert(needsOf(nativeCall).includes('desktop-build'), 'native E2E must wait for the exact desktop build');
	const distributionCall = rootWorkflow.jobs['distribution-policy'];
	assert(needsOf(distributionCall).includes('desktop-build'), 'distribution policy must inspect the accepted executable');

	const desktopWorkflow = wf.children['desktop-build'];
	const packageWorkflow = wf.children['package-validation'];
	assert(desktopWorkflow, 'desktop-build reusable workflow is required');
	assert(packageWorkflow, 'package-validation reusable workflow is required');
	for (const [name, description] of Object.entries({
		built_exe_sha256: 'Built release executable SHA256',
		built_exe_artifact_id: 'Workflow artifact ID for the release executable',
		built_exe_artifact_name: 'Workflow artifact name for the release executable',
		built_exe_artifact_run_id: 'Workflow run ID containing the release executable artifact',
		built_exe_artifact_digest: 'SHA256 digest of the uploaded executable artifact',
		built_exe_workflow_sha: 'Workflow run source SHA containing the executable artifact',
		built_exe_source_commit: 'Verified source commit used to build the executable',
		built_exe_package_version: 'Verified package version for the executable'
	})) {
		assert.equal(
			desktopWorkflow.workflow.on.workflow_call.outputs?.[name]?.value,
			`$\{\{ jobs.desktop-build.outputs.${name} \}\}`,
			`desktop-build output ${name} must be forwarded`
		);
		assert.equal(typeof description, 'string');
		assert.equal(rootWorkflow.on.workflow_call.outputs?.[name]?.value, `$\{\{ jobs.desktop-build.outputs.${name} \}\}`);
	}
	for (const name of ['online_installer_sha256', 'offline_installer_sha256']) {
		assert.equal(
			packageWorkflow.workflow.on.workflow_call.outputs?.[name]?.value,
			`$\{\{ jobs.package-validation.outputs.${name} \}\}`,
			`package-validation output ${name} must be forwarded`
		);
		assert.equal(
			rootWorkflow.on.workflow_call.outputs?.[name]?.value,
			`$\{\{ jobs.package-validation.outputs.${name} \}\}`
		);
	}

	const desktopJob = expandedJob(wf, gates.build).job;
	assert.match(commands(desktopJob), /EXPECTED_SOURCE_COMMIT/);
	assert.match(commands(desktopJob), /EXPECTED_PACKAGE_VERSION/);
	assert.match(commands(desktopJob), /workflow_sha=\$env:WORKFLOW_SHA/);
	assert.match(commands(desktopJob), /source_commit=\$commit/);
	assert.match(commands(desktopJob), /ModuTeX-Release-Executable/);
	assert(
		stepsOf(desktopJob).some((step) =>
			step.uses?.startsWith('actions/upload-artifact@') &&
			/\.exe\s*$/.test(step.with?.path ?? '')
		),
		'publish the exact release executable artifact'
	);

	const nativeJob = expandedJob(wf, gates.e2e).job;
	const nativeCommands = commands(nativeJob);
	assert.match(nativeCommands, /download-workflow-artifact\.ps1 -RunId \$env:GITHUB_RUN_ID/);
	assert.match(nativeCommands, /download-workflow-artifact\.ps1 -RunId \$env:EXE_ARTIFACT_RUN_ID/);
	assert.match(nativeCommands, /CURRENT_RUN_ID/);
	assert.match(nativeCommands, /Get-FileHash/);
	assert.doesNotMatch(nativeCommands, /cargo build|frontend:build/);

	const lifecycle = expandedJobs(wf).find(({ jobId }) => jobId === 'installer-lifecycle');
	assert(lifecycle, 'installer lifecycle reusable job is required');
	const lanes = lifecycle.job.strategy?.matrix?.include;
	assert(Array.isArray(lanes), 'installer lifecycle matrix is required');
	assert.deepEqual(
		lanes.map(({ lane, artifact_name }) => [lane, artifact_name]).sort((a, b) => a[0].localeCompare(b[0])),
		[
			['offline', 'ModuTeX-Tauri-Windows-x64-Offline-Installer'],
			['online', 'ModuTeX-Tauri-Windows-x64-Online-Installer']
		]
	);
	assert.equal(lifecycle.job.strategy['fail-fast'], false);
	const lifecycleCommands = commands(lifecycle.job);
	assert.match(lifecycleCommands, /download-workflow-artifact\.ps1 -RunId \$env:GITHUB_RUN_ID/);
	assert.match(lifecycleCommands, /INSTALLER_SHA256/);
	assert.match(lifecycleCommands, /ExpectedInstallerSha256/);
	assert.match(lifecycleCommands, /ExpectedExecutableSha256/);
	assert.match(lifecycleCommands, /PRIOR_INSTALLER_URL/);
	assert.match(lifecycleCommands, /verify-installer-lifecycle\.ps1/);
	assert(
		stepsOf(lifecycle.job).some((step) =>
			step.uses?.startsWith('actions/upload-artifact@') &&
			step.name === 'Upload installer lifecycle receipt'
		),
		'lifecycle receipt upload is required'
	);

	const lifecycleCall = rootWorkflow.jobs['installer-lifecycle'];
	assert(needsOf(lifecycleCall).includes('package-validation'));
	assert.equal(
		lifecycleCall.with?.online_installer_sha256,
		'${{ needs.package-validation.outputs.online_installer_sha256 }}'
	);
	assert.equal(
		lifecycleCall.with?.offline_installer_sha256,
		'${{ needs.package-validation.outputs.offline_installer_sha256 }}'
	);
}

export function validateTauriCiContract(wf) {
	assert(wf?.workflow?.jobs, 'expanded workflow jobs required');
	const rootWorkflow = wf.workflow;
	const nodes = workflowNodes(wf);
	for (const node of nodes) {
		assert(node.workflow?.jobs, `workflow jobs required in ${node.path}`);
		if (node !== wf) {
			assert(Object.hasOwn(node.workflow.on ?? {}, 'workflow_call'), `${node.path} must be reusable`);
		}
		for (const scope of Object.values(node.workflow.permissions ?? {})) {
			assert.equal(scope, 'read', 'read-only workflow permissions required');
		}
		validateDependencyGraph(node);

		for (const [id, job] of Object.entries(node.workflow.jobs)) {
			assert.equal(job.if, undefined, `${id} cannot skip a required job`);
			assert.equal(job['continue-on-error'], undefined, `${id} cannot swallow errors`);
			for (const value of Object.values(job.permissions ?? {})) {
				assert.equal(value, 'read', 'read-only job permissions required');
			}
			if (node.children[id]) {
				assert.equal(
					job.uses,
					`./.github/workflows/${node.children[id].path.slice(resolve(ROOT, '.github/workflows').length + 1).replaceAll('\\', '/')}`,
					`${id} reusable workflow path changed`
				);
				assert.equal(job.steps, undefined, `${id} cannot wrap a reusable workflow in duplicate setup steps`);
				continue;
			}
			assert(['windows-2025', 'ubuntu-24.04'].includes(job['runs-on']), `${id} requires hosted runner`);
			for (const step of stepsOf(job)) {
				assert.equal(step['continue-on-error'], undefined, 'step cannot swallow errors');
				assert.doesNotMatch(JSON.stringify(step), /\$\{\{\s*secrets\./, 'CI cannot consume signing secrets');
				if (step.uses) assert(ACTIONS.has(step.uses), `unreviewed action ${step.uses}`);
				if (step.uses?.startsWith('actions/checkout@')) {
					assert.equal(step.with?.['persist-credentials'], false, 'checkout cannot retain credentials');
					assert.doesNotMatch(step.with?.ref ?? '', /github\.ref|\|\|/, 'checkout must use validated source SHA');
					if (node === wf && id === 'source-identity') {
						assert.equal(step.with?.ref, '${{ needs.validate-source-ref.outputs.checkout_ref }}');
					} else {
						assert.equal(step.with?.ref, '${{ inputs.checkout_ref }}', 'reusable jobs must use source admission identity');
					}
				}
				if (step.uses?.startsWith('actions/upload-artifact@')) {
					assert.doesNotMatch(
						step.with?.path ?? '',
						/(?:^|\n)\s*(?:\*\*|node_modules|apps\/desktop-tauri\/target)\/?\s*(?:$|\n)/,
						'do not upload entire build caches'
					);
				}
			}
		}
	}

	assert.equal(Object.hasOwn(rootWorkflow.on, 'pull_request_target'), false, 'pull_request_target forbidden');
	assert(Object.hasOwn(rootWorkflow.on, 'pull_request'), 'pull request validation required');
	assert.equal(rootWorkflow.concurrency?.['cancel-in-progress'], true, 'obsolete CI runs must be cancelled');

	const gates = gateJobs(wf);
	assert.equal(new Set(Object.values(gates)).size, Object.keys(gates).length, 'language gates must have independent jobs');
	for (const [gate, id] of Object.entries(gates)) {
		for (const step of stepsOf(expandedJob(wf, id).job).filter((step) => GATES[gate].test(step.run ?? ''))) {
			assert.equal(step.if, undefined, `${gate} gate cannot be conditional`);
			assert.doesNotMatch(step.run, /\|\|\s*(?:true|exit 0)/, 'gate cannot mask failure');
		}
	}
	for (const gate of ['format', 'clippy', 'rust']) {
		const job = expandedJob(wf, gates[gate]).job;
		const coverage = JSON.stringify(job.strategy?.matrix ?? {}) + commands(job);
		for (const manifest of MANIFESTS) assert(coverage.includes(manifest), `${gate} must cover ${manifest}`);
		if (gate !== 'format') {
			const cmd = stepsOf(job).find((step) => GATES[gate].test(step.run ?? '')).run;
			assert.match(cmd, /--locked/, 'Rust verification must use lockfile');
			assert.match(cmd, /--release/, 'Rust verification must share release profile');
		}
	}
	for (const gate of ['markdown', 'format'])
		assert.doesNotMatch(commands(expandedJob(wf, gates[gate]).job), /cargo (?:build|test)|frontend:build/, 'format jobs cannot build app');

	assert(rootWorkflow.jobs['package-validation'], 'final package validation reusable call required');
	const ancestors = rootAncestors(rootWorkflow, 'package-validation');
	for (const id of Object.values(gates)) {
		const gate = expandedJob(wf, id);
		assert(gate.rootCallId && ancestors.has(gate.rootCallId), `package validation must wait for ${id}`);
	}
	assert(needsOf(rootWorkflow.jobs['native-e2e']).includes('desktop-build'), 'native E2E must wait for the exact build');

	const build = expandedJob(wf, gates.build).job;
	const e2eJob = expandedJob(wf, gates.e2e).job;
	assert.equal(build['runs-on'], 'windows-2025');
	assert.equal(e2eJob['runs-on'], 'windows-2025');
	const buildCommand = stepsOf(build).find((step) => GATES.build.test(step.run ?? '')).run;
	assert.match(buildCommand, /--locked/);
	assert.match(buildCommand, /--release/);
	assert.match(buildCommand, /--target x86_64-pc-windows-msvc/);
	if (buildCommand.trim().includes('\n')) {
		assert.match(buildCommand, /\$LASTEXITCODE/, 'multi-command native build failure must be checked');
	} else {
		assert.doesNotMatch(buildCommand, /[;|&]/, 'single native build command must preserve the GitHub shell exit status');
	}
	assert(
		stepsOf(build).some((step) => step.uses?.startsWith('actions/upload-artifact@') && /\.exe\s*$/.test(step.with?.path ?? '')),
		'publish exact executable artifact'
	);

	const e2eCommand = commands(e2eJob);
	assert.equal(e2eJob.strategy?.['fail-fast'], false, 'each native lane must finish independently');
	const lanes = e2eJob.strategy?.matrix?.include;
	assert(Array.isArray(lanes), 'native E2E matrix required');
	const requiredScripts = ['tauri-g2-workbench-e2e.mjs', 'tauri-g4-files-e2e.mjs', 'tauri-g4-terminal-e2e.mjs', 'tauri-compile-config-e2e.mjs', 'tauri-native-close-e2e.mjs', 'tauri-multiwindow-e2e.mjs', 'tauri-os-open-e2e.mjs'].map(name => `tests/scripts/${name}`);
	assert.deepEqual(lanes.map(lane => lane.script).sort(), requiredScripts.sort(), 'each native flow must run exactly once');
	assert.equal(new Set(lanes.map(lane => lane.lane)).size, lanes.length, 'native evidence lanes must be unique');
	const laneStep = stepsOf(e2eJob).find(step => step.run?.includes('node ${{ matrix.script }}'));
	assert(laneStep && laneStep.if === undefined, 'selected native E2E lane cannot be skipped');
	assert.match(laneStep.run, /\$LASTEXITCODE/, 'native E2E failures must stop the lane');
	assert.match(JSON.stringify(laneStep.env), /MODUTEX_TEST_PERIODIC_WATCH/, 'compile lane must verify periodic watch');
	assert.doesNotMatch(JSON.stringify(e2eJob), /MODUTEX_TEST_SOURCE_FORMAT/, 'OS-open CI must not depend on a user-installed formatter');
	assert.match(e2eCommand, /download-workflow-artifact\.ps1/, 'native E2E must consume build artifact');
	assert.match(e2eCommand, /Get-FileHash/, 'native E2E must verify executable bytes');
	assert.match(JSON.stringify(e2eJob), /built_exe_sha256/, 'native E2E must bind expected build SHA');
	assert.doesNotMatch(e2eCommand, /cargo build|frontend:build/, 'native E2E cannot rebuild the accepted app');
	const browserJob = expandedJob(wf, gates.browser).job;
	assert.equal(browserJob['runs-on'], 'ubuntu-24.04');
	assert.match(commands(browserJob), /npm run frontend:build/, 'browser E2E requires the browser frontend build');
	assert.match(commands(browserJob), /pdf-synctex-browser\.e2e\.mjs/, 'browser E2E must verify PDF and SyncTeX');
	assert.match(commands(browserJob), /app-settings-draft-entry-browser\.e2e\.mjs/, 'browser E2E must verify the App Draft entry');
	assert.doesNotMatch(commands(browserJob), /cargo (?:build|test)/, 'browser E2E cannot rebuild the native executable');
	validatePackageAndLifecycle(wf, gates);
}

test('automatic CI covers every branch and skips only docs-only changes', async () => {
	const { on: triggers } = (await workflow()).workflow;
	for (const event of ['push', 'pull_request']) {
		const filters = triggers[event];
		assert.equal(filters.branches, undefined, `${event} must not restrict CI to named development branches`);
		assert.equal(filters['branches-ignore'], undefined, `${event} must include documentation branches with code changes`);
		assert.equal(filters.paths, undefined, `${event} must not allowlist source paths`);
		assert.deepEqual(filters['paths-ignore'], ['docs/**'], `${event} skips only changes confined to docs/`);
	}
});

test('expanded CI reusable-workflow graph preserves required checks and exact build-to-E2E provenance', async () => {
	validateTauriCiContract(await workflow());
});

test('artifact identity distinguishes PR head from the checked-out merge commit', async () => {
	const wf = await workflow();
	const build = wf.children['desktop-build'].workflow.jobs['desktop-build'];
	const identity = stepsOf(build).find((step) => step.id === 'exe_identity');
	const fixture = await mkdtemp(join(tmpdir(), 'modutex-ci-identity-'));
	const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', windowsHide: true }).trim();
	try {
		const binary = 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/modutex-desktop-tauri.exe';
		await mkdir(join(fixture, binary, '..'), { recursive: true });
		await writeFile(join(fixture, binary), 'identity fixture bytes');
		await writeFile(join(fixture, 'source.txt'), 'checked-out source');
		git('init', '--quiet');
		git('add', 'source.txt');
		git('-c', 'user.name=ModuTeX CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
		const sourceCommit = git('rev-parse', 'HEAD');
		const prHead = '79794591024726df881cb89bea5b2159b35b9ba9';
		for (const event of ['push', 'pull_request', 'workflow_dispatch', 'workflow_call']) {
			const expectedWorkflowHead = event === 'push' ? sourceCommit : prHead;
			const context = {
				'github.sha': event === 'pull_request' ? sourceCommit : expectedWorkflowHead,
				'github.event.pull_request.head.sha': event === 'pull_request' ? prHead : '',
				'inputs.checkout_ref': sourceCommit,
				'inputs.package_version': '0.3.0',
				'github.run_id': '40277037566'
			};
			const environment = {};
			for (const [name, expression] of Object.entries(identity.env)) {
				assert(expression.startsWith('${{') && expression.endsWith('}}'));
				const terms = expression.slice(3, -2).trim().split('||').map((term) => term.trim());
				for (const term of terms) assert(Object.hasOwn(context, term), `Unsupported fixture context: ${term}`);
				environment[name] = terms.map((term) => context[term]).find(Boolean) ?? '';
			}
			const outputPath = join(fixture, `${event}.out`);
			execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', identity.run], {
				cwd: fixture, windowsHide: true, timeout: 15000,
				env: { ...process.env, ...environment, GITHUB_OUTPUT: outputPath }
			});
			const output = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split(/\r?\n/).map((line) => {
				const separator = line.indexOf('=');
				return [line.slice(0, separator), line.slice(separator + 1)];
			}));
			assert.equal(output.workflow_sha, expectedWorkflowHead, `${event}: match artifact REST workflow_run.head_sha`);
			assert.equal(output.source_commit, sourceCommit, `${event}: retain the actual checked-out source identity`);
			assert.match(output.sha256, /^[0-9a-f]{64}$/);
			assert.equal(output.package_version, '0.3.0');
			if (event === 'pull_request') assert.notEqual(output.workflow_sha, output.source_commit);
		}
	} finally {
		assert(fixture.startsWith(resolve(tmpdir()) + sep));
		await rm(fixture, { recursive: true, force: true });
	}
});

test('every CI Node job matches the package runtime and verifies bundled npm', async () => {
	const wf = await workflow();
	const nodes = workflowNodes(wf);
	nodes.push(await workflowNode(resolve(ROOT, '.github/workflows/tauri-release.yml'), ROOT));
	const manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
	let runtimeJobCount = 0;

	for (const node of nodes) {
		for (const [jobId, job] of Object.entries(node.workflow.jobs)) {
			const steps = stepsOf(job);
			for (const [index, step] of steps.entries()) {
				if (!step.uses?.startsWith('actions/setup-node@')) continue;
				runtimeJobCount += 1;
				assert.equal(
					step.with?.['node-version'],
					manifest.engines.node,
					`${node.path}/${jobId} must use package.json engines.node`
				);
				const verification = steps
					.slice(index + 1)
					.find((candidate) => candidate.run?.includes('node --version') && candidate.run?.includes('npm --version'));
				assert(verification, `${node.path}/${jobId} must verify Node and npm versions`);
				assert(
					verification.run.includes(`v${manifest.engines.node}`),
					`${node.path}/${jobId} must verify Node.js ${manifest.engines.node}`
				);
				assert(
					verification.run.includes(manifest.engines.npm),
					`${node.path}/${jobId} must verify npm ${manifest.engines.npm}`
				);
			}
		}
	}
	assert(runtimeJobCount > 0, 'CI must pin at least one Node runtime');
});

test('frontend unit tests bound native bundler worker pools', async () => {
	const workflow = load(await readFile(join(ROOT, '.github/workflows/tauri-frontend.yml'), 'utf8'));
	const step = workflow.jobs['frontend-unit'].steps.find(step => step.run?.includes('npm run frontend:test'));
	assert.ok(step, 'The complete frontend unit suite must remain enabled');
	for (const name of ['RAYON_NUM_THREADS', 'ROLLDOWN_WORKER_THREADS', 'ROLLDOWN_MAX_BLOCKING_THREADS']) {
		assert.equal(step.env?.[name], '1', `${name} must bound native work independently of the Node heap`);
	}
});

test('supply-chain gates audit complete npm and Cargo lockfiles and preserve failures', async () => {
	const wf = await workflow();
	assert(rootAncestors(wf.workflow, 'package-validation').has('supply-chain'), 'package validation must wait for supply-chain audits');
	const npmJob = expandedJob(wf, 'supply-chain/supply-chain').job;
	const npmWorkflow = wf.children['supply-chain'];
	const npmSteps = stepsOf(npmJob);
	const npmrc = await readFile(resolve(ROOT, '.npmrc'), 'utf8');
	assert.equal(wf.workflow.env?.NODE_ENV, undefined, 'root workflow cannot set production-only npm auditing');
	assert.equal(npmWorkflow.workflow.env?.NODE_ENV, undefined, 'supply-chain workflow cannot set production-only npm auditing');
	assert.equal(npmJob.env?.NODE_ENV, undefined, 'supply-chain job cannot set production-only npm auditing');
	assert.doesNotMatch(npmrc, /^\s*(?:omit|production)\s*=/im, 'npm config must not omit dev dependencies from audits');
	const signature = npmSteps.find((step) => step.id === 'registry-signatures');
	const npmAudit = npmSteps.find((step) => step.id === 'high-audit');
	assert(signature, 'npm registry signature verification is required');
	assert.match(signature.run, /npm audit signatures --json/);
	assert.match(signature.run, /\$LASTEXITCODE/);
	assert.match(signature.run, /exit \$signatureExitCode/);
	assert(npmAudit, 'high-severity npm audit is required');
	assert.match(npmAudit.run, /npm audit --audit-level=high --json/);
	assert.doesNotMatch(npmAudit.run, /--omit(?:=|\s)|--production/);
	assert.match(npmAudit.run, /\$LASTEXITCODE/);
	assert.match(npmAudit.run, /exit \$auditExitCode/);
	assert.match(npmAudit.if, /always\(\)/);
	const npmReports = npmSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@') && /audit-report\.json/.test(step.with?.path ?? ''));
	assert(npmReports, 'npm registry and audit reports must be uploaded');
	assert.match(npmReports.if, /always\(\)/);

	const rustJob = expandedJob(wf, 'supply-chain/rustsec-audit').job;
	const rustSteps = stepsOf(rustJob);
	const install = rustSteps.find((step) => step.id === 'install-cargo-audit');
	assert.match(install?.run ?? '', /cargo install cargo-audit --version 0\.22\.2 --locked/);
	assert(install.run.includes("-notmatch '^cargo-audit-audit 0\\.22\\.2$'"), 'The version gate must match the actual pinned CLI output exactly');
	for (const lockfile of ['apps/desktop-tauri/Cargo.lock', 'crates/document-core/Cargo.lock']) {
		const audit = rustSteps.find((step) => step.run?.includes(`cargo audit --file ${lockfile} --json`));
		assert(audit, `RustSec audit must inspect ${lockfile}`);
		assert.match(audit.run, /\$LASTEXITCODE/);
		assert.match(audit.run, /exit \$auditExitCode/);
		assert.doesNotMatch(audit.run, /--ignore/);
	}
	const rustReports = rustSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@') && /rustsec-report\.json/.test(step.with?.path ?? ''));
	assert(rustReports, 'RustSec reports must be uploaded');
	assert.match(rustReports.if, /always\(\)/);
});

test('CI rejects unreviewed actions, signing secrets and writable pull request permissions', async () => {
	const original = await workflow();
	const first = Object.keys(original.workflow.jobs)[0];
	for (const mutate of [
		(wf) => wf.workflow.jobs[first].steps.push({ uses: 'actions/cache@v4' }),
		(wf) => wf.workflow.jobs[first].steps.push({ run: '${{ secrets.TOKEN }}' }),
		(wf) => {
			wf.workflow.permissions.contents = 'write';
		}
	]) {
		const changed = structuredClone(original);
		mutate(changed);
		assert.throws(() => validateTauriCiContract(changed));
	}
});

test('expanded CI rejects omission or conditional execution of each required gate', async () => {
	const original = await workflow();
	const jobs = gateJobs(original);
	for (const [gate, id] of Object.entries(jobs)) {
		const missing = structuredClone(original);
		const missingJob = expandedJob(missing, id).job;
		if (gate === 'e2e') {
			missingJob.strategy.matrix.include = missingJob.strategy.matrix.include.filter(
				(lane) => !lane.script.includes('tauri-g2-workbench-e2e')
			);
		} else {
			missingJob.steps = missingJob.steps.filter((step) => !GATES[gate].test(step.run ?? ''));
		}
		assert.throws(() => validateTauriCiContract(missing), /required gate/);

		const skipped = structuredClone(original);
		const skippedJob = expandedJob(skipped, id).job;
		const selectedStep = skippedJob.steps.find((step) =>
			gate === 'e2e' ? step.run?.includes('node ${{ matrix.script }}') : GATES[gate].test(step.run ?? '')
		);
		assert(selectedStep, `Expected actual ${gate} step`);
		selectedStep.if = 'false';
		assert.throws(() => validateTauriCiContract(skipped), /conditional|skipped/);
	}
});

test('CI rejects E2E that bypasses quality dependencies or rebuilds its own executable', async () => {
	const original = await workflow();
	const jobs = gateJobs(original);
	const detached = structuredClone(original);
	detached.workflow.jobs[expandedJob(detached, jobs.e2e).rootCallId].needs = [];
	assert.throws(() => validateTauriCiContract(detached), /exact desktop build|must wait/);

	const incomplete = structuredClone(original);
	incomplete.workflow.jobs['package-validation'].needs = [];
	assert.throws(() => validateTauriCiContract(incomplete), /must wait/);

	const rebuilt = structuredClone(original);
	expandedJob(rebuilt, jobs.e2e).job.steps.push({ run: 'cargo build --release' });
	assert.throws(() => validateTauriCiContract(rebuilt));
});

test('reusable workflow expansion rejects missing workflow files and workflow-reference cycles', async () => {
	const fixture = await mkdtemp(join(tmpdir(), 'modutex-ci-graph-'));
	const directory = join(fixture, '.github', 'workflows');
	try {
		await mkdir(directory, { recursive: true });
		const workflowText = (name, target) => dump({
			name,
			on: { workflow_call: {} },
			jobs: { child: { uses: target } }
		});

		const missingRoot = join(directory, 'missing-root.yml');
		await writeFile(
			missingRoot,
			workflowText('missing root', './.github/workflows/does-not-exist.yml'),
			'utf8'
		);
		await assert.rejects(
			workflowNode(missingRoot, fixture),
			/Missing reusable workflow/
		);

		const cycleA = join(directory, 'cycle-a.yml');
		const cycleB = join(directory, 'cycle-b.yml');
		await writeFile(cycleA, workflowText('cycle A', './.github/workflows/cycle-b.yml'), 'utf8');
		await writeFile(cycleB, workflowText('cycle B', './.github/workflows/cycle-a.yml'), 'utf8');
		await assert.rejects(workflowNode(cycleA, fixture), /Reusable workflow cycle detected/);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test('clean runners prepare real WASM bindings and frontend artifacts before dependent compilation', async () => {
	const wf = await workflow();
	const jobs = expandedJobs(wf);
	const actionPath = './.github/actions/setup-document-core-wasm';
	for (const id of ['frontend-types', 'frontend-unit', 'frontend-browser-e2e', 'frontend-build', 'document-core-wasm']) {
		const entry = jobs.find(item => item.jobId === id);
		assert(entry, `required job ${id}`);
		assert(stepsOf(entry.job).some(step => step.uses === actionPath), `${id} needs the pinned WASM toolchain`);
	}
	assert(needsOf(wf.workflow.jobs.rust).includes('frontend'), 'Rust app compilation must wait for actual frontend assets');
	for (const id of ['rust-clippy', 'rust-tests']) {
		const entry = jobs.find(item => item.jobId === id);
		assert(entry);
		const steps = stepsOf(entry.job);
		const download = steps.findIndex(step => /Download source-matched Tauri frontend assets/.test(step.name ?? ''));
		const compile = steps.findIndex(step => /cargo (clippy|test)\b/.test(step.run ?? ''));
		assert(download >= 0 && download < compile, `${id} must download assets before Cargo compiles the app`);
		assert.match(steps[download].run, /download-workflow-artifact\.ps1 -RunId \$env:GITHUB_RUN_ID/);
		assert.match(steps[download].env.FRONTEND_ARTIFACT_NAME, /github.run_id.*github.run_attempt/);
		assert.match(steps[download].run, /index\.html/);
	}
	const rust = jobs.find(item => item.jobId === 'rust-tests').job;
	assert.doesNotMatch(commands(rust), /--shared=no/, 'portable MiKTeX cannot also select shared mode');
	assert.match(commands(rust), /--portable=/);
	const action = load(await readFile(resolve(ROOT, '.github/actions/setup-document-core-wasm/action.yml'), 'utf8'));
	assert.equal(action.runs.using, 'composite');
	for (const step of action.runs.steps) {
		assert.equal(step.uses, undefined, 'bootstrap must not pull unreviewed nested actions');
		assert.match(step.run, /rustup toolchain install 1\.97\.1/);
		assert.match(step.run, /cargo install wasm-bindgen-cli --version 0\.2\.126 --locked/);
		assert.match(step.run, /wasm-bindgen --version/);
		assert.doesNotMatch(step.run, /secrets\./);
	}
});

test('MiKTeX prewarm uses bounded official mirrors and verifies the pinned archive before extraction', async () => {
	const workflow = load(await readFile(resolve(ROOT, '.github/workflows/tauri-rust.yml'), 'utf8'));
	const rustTests = workflow.jobs['rust-tests'];
	assert(rustTests, 'Rust test job is required');
	const step = stepsOf(rustTests).find(({ name }) => name === 'Install isolated basic MiKTeX and prewarm LuaLaTeX');
	assert(step, 'MiKTeX prewarm must remain enabled');
	const run = step.run;
	assert.match(run, /https:\/\/mirrors\.ibiblio\.org\/pub\/mirrors\/CTAN\/systems\/win32\/miktex\/tm\/packages\//,
		'package fallback must use the URL registered by miktexsetup --list-repositories');
	assert.doesNotMatch(run, /https:\/\/mirrors\.ibiblio\.org\/CTAN\/systems\/win32\/miktex\/tm\/packages\//,
		'the shorter package URL is rejected as an unregistered repository');
	const packageUrls = [...run.matchAll(/Uri = '([^']+\/tm\/packages\/)'/g)].map(([, url]) => url);
	assert.deepEqual(packageUrls, [
		'https://mirror.latigo.net/ctan/systems/win32/miktex/tm/packages/',
		'https://mirrors.ibiblio.org/pub/mirrors/CTAN/systems/win32/miktex/tm/packages/',
		'https://mirror.clarkson.edu/ctan/systems/win32/miktex/tm/packages/'
	]);
	assert.match(run, /CiProcessDeadline = \[DateTime\]::UtcNow.AddSeconds\(720\)/);
	assert.match(run, /-TimeoutSeconds 180/);
	const sourceUrls = [...run.matchAll(/Uri = '([^']+\.zip)'/g)].map(([, url]) => url);
	assert.deepEqual(sourceUrls, [
		'https://mirrors.ibiblio.org/CTAN/systems/win32/miktex/setup/windows-x64/miktexsetup-5.5.0%2B1763023-x64.zip',
		'https://ctan.net/systems/windows/miktex/setup/windows-x64/miktexsetup-5.5.0%2B1763023-x64.zip'
	]);
	assert.equal(new Set(sourceUrls).size, 2, 'each pinned source must be attempted at most once');
	assert.doesNotMatch(run, /miktex\.org\/download\/ctan/, 'download must avoid the unstable MiKTeX redirect');
	assert.match(run, /\$downloadTimeoutSec = 45/);
	assert.match(run, /Invoke-WebRequest -Uri \$archiveSource\.Uri[^\r\n]* -TimeoutSec \$downloadTimeoutSec -MaximumRedirection 3/);
	assert.equal((run.match(/Remove-Item -LiteralPath \$archivePath -Force -ErrorAction Stop/g) ?? []).length, 2,
		'each source starts clean and a failed transfer removes its partial archive');
	assert.match(run, /\$expectedArchiveSha256 = '0571e90f6d94353089b4f189fd82a532f9fe559a388c7e7f1102b14b3c1ae27d'/);
	assert.match(run, /Get-FileHash -LiteralPath \$archivePath -Algorithm SHA256/);
	assert.match(run, /if \(\$archiveSha256 -ne \$expectedArchiveSha256\)/);
	assert.match(run, /if \(-not \$archiveVerified\) \{[\s\S]*?throw/);
	assert(run.indexOf('if (-not $archiveVerified) {') < run.indexOf('Expand-Archive -LiteralPath $archivePath'),
		'only a successfully downloaded and hash-verified archive may be extracted');
	assert.match(run, /--set-config-value=\[MPM\]AutoInstall=f/);
	assert.match(run, /formats', 'build', '--engine=luahbtex'/);
	assert.match(run, /Invoke-CiBoundedProcess/);
});

test('release signing remains downstream of the same CI-tested executable identity', async () => {
	const release = load(
		await readFile(resolve(ROOT, '.github/workflows/tauri-release.yml'), 'utf8')
	);
	const gate = release.jobs['tauri-ci-gate'];
	assert.equal(gate.uses, './.github/workflows/tauri-ci.yml');
	assert.equal(gate.with?.formal_release, true);
	assert.equal(
		gate.with?.checkout_ref,
		'${{ needs.validate-release-target.outputs.checkout_ref }}'
	);
	assert(needsOf(release.jobs['release-build-and-sign']).includes('tauri-ci-gate'));
	const releaseJob = release.jobs['release-build-and-sign'];
	const releaseCommands = commands(releaseJob);
	assert.match(JSON.stringify(releaseJob), /built_exe_artifact_digest/);
	assert.match(JSON.stringify(releaseJob), /built_exe_source_commit/);
	assert.match(releaseCommands, /EXPECTED_TESTED_EXE_SHA/);
	assert.match(releaseCommands, /verify-authenticode-image\.mjs/);
	assert.match(JSON.stringify(releaseJob), /signpath\/github-action-submit-signing-request@/);
	assert.match(releaseCommands, /tauri bundle .*--no-binary-patching/);
	assert.doesNotMatch(releaseCommands, /cargo build\b/, 'release must not rebuild the accepted executable');
});
