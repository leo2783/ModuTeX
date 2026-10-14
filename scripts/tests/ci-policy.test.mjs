import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { modutexChecks } from '../run-verification.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ACTIONS = new Set([
	'actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd',
	'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
	'actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f'
]);
const workflow = async (name) => load(await readFile(resolve(ROOT, '.github/workflows', name), 'utf8'));
const VENDOR_REGRESSION_COMMAND =
	'node --test scripts/tests/verify-vendor-retained.test.mjs scripts/vendor/vendor-manifest.test.mjs scripts/vendor/vendor-artifact.test.mjs scripts/vendor/tectonic-vendor.test.mjs scripts/tests/verify-packaged-vendor.test.mjs';
const ISSUE_FORM_COMMAND = 'node --test scripts/tests/issue-template-brand.test.mjs';
const DEVALUE_BOUNDARY_COMMAND = 'node --test scripts/tests/devalue-buffer-boundary.test.mjs';

function devalueBoundaryContract(job) {
	const steps = job.steps;
	const matches = steps.filter((step) => step.run?.includes('devalue-buffer-boundary.test.mjs'));
	assert.equal(matches.length, 1, 'exactly one complete devalue boundary regression gate is required');
	const gate = matches[0];
	assert.equal(gate.run, DEVALUE_BOUNDARY_COMMAND);
	assert.equal(gate.if, undefined);
	assert.equal(gate['continue-on-error'], undefined);
	assert.equal(gate.shell, undefined, 'devalue regressions use the existing native job shell');
	const index = steps.indexOf(gate);
	for (const command of [
		'npm ci --ignore-scripts',
		'npm run verify:install-policy',
		'npm ci',
		VENDOR_REGRESSION_COMMAND,
		ISSUE_FORM_COMMAND
	]) {
		const prerequisite = steps.findIndex((step) => step.run === command);
		assert.ok(prerequisite >= 0 && prerequisite < index, `devalue tests must follow ${command}`);
	}
	for (const id of ['registry-signatures', 'high-audit']) {
		const prerequisite = steps.findIndex((step) => step.id === id);
		assert.ok(prerequisite >= 0 && prerequisite < index, `devalue tests must follow ${id}`);
	}
	for (const [i, step] of steps.entries()) {
		if (/^npm (?:run (?:check|lint|testonce|build|verify:modutex|dist)\b|exec\b)/.test(step.run ?? '')) {
			assert.ok(index < i, 'devalue regressions must precede compilation and packaging');
		}
	}
}

function issueFormContract(job) {
	const steps = job.steps;
	const matches = steps.filter((step) => step.run?.includes('issue-template-brand.test.mjs'));
	assert.equal(matches.length, 1, 'exactly one complete issue-form regression gate is required');
	const gate = matches[0];
	assert.equal(gate.run, ISSUE_FORM_COMMAND);
	assert.equal(gate.if, undefined);
	assert.equal(gate['continue-on-error'], undefined);
	assert.equal(gate.shell, undefined, 'issue-form regressions use the existing native job shell');
	const index = steps.indexOf(gate);
	for (const command of ['npm ci --ignore-scripts', 'npm run verify:install-policy', 'npm ci', VENDOR_REGRESSION_COMMAND]) {
		const prerequisite = steps.findIndex((step) => step.run === command);
		assert.ok(prerequisite >= 0 && prerequisite < index, `issue-form tests must follow ${command}`);
	}
	for (const id of ['registry-signatures', 'high-audit']) {
		const prerequisite = steps.findIndex((step) => step.id === id);
		assert.ok(prerequisite >= 0 && prerequisite < index, `issue-form tests must follow ${id}`);
	}
	for (const [i, step] of steps.entries()) {
		if (/^npm (?:run (?:check|lint|testonce|build|verify:modutex|dist)\b|exec\b)/.test(step.run ?? '')) {
			assert.ok(index < i, 'issue-form regressions must precede compilation and packaging');
		}
	}
}

function vendorRegressionContract(job) {
	const steps = job.steps;
	const matches = steps.filter((step) => step.run?.includes('verify-vendor-retained.test.mjs'));
	assert.equal(matches.length, 1, 'exactly one complete vendor regression gate is required');
	const gate = matches[0];
	assert.equal(gate.run, VENDOR_REGRESSION_COMMAND);
	assert.equal(gate.if, undefined);
	assert.equal(gate['continue-on-error'], undefined);
	assert.equal(gate.shell, undefined, 'vendor regressions use the existing native job shell');
	const index = steps.indexOf(gate);
	for (const command of ['npm ci --ignore-scripts', 'npm run verify:install-policy', 'npm ci']) {
		const prerequisite = steps.findIndex((step) => step.run === command);
		assert.ok(prerequisite >= 0 && prerequisite < index, `vendor tests must follow ${command}`);
	}
	for (const id of ['registry-signatures', 'high-audit']) {
		const prerequisite = steps.findIndex((step) => step.id === id);
		assert.ok(prerequisite >= 0 && prerequisite < index, `vendor tests must follow ${id}`);
	}
	for (const [i, step] of steps.entries()) {
		if (/^npm (?:run (?:check|lint|testonce|build|verify:modutex|dist)\b|exec\b)/.test(step.run ?? '')) {
			assert.ok(index < i, 'vendor regressions must precede compilation and packaging');
		}
	}
}

function safety(value) {
	assert.deepEqual(value.permissions, { contents: 'read' });
	assert.equal(Object.hasOwn(value.on, 'pull_request_target'), false);
	for (const job of Object.values(value.jobs)) {
		if (job.permissions !== undefined) assert.deepEqual(job.permissions, { contents: 'read' });
		assert.equal(job['continue-on-error'], undefined);
		assert.equal(job.environment, undefined);
		for (const step of job.steps) {
			assert.equal(step['continue-on-error'], undefined);
			if (step.uses) assert.ok(ACTIONS.has(step.uses), `unreviewed action ${step.uses}`);
			assert.doesNotMatch(JSON.stringify(step), /\$\{\{\s*secrets\./);
		}
	}
}

function commandsInOrder(steps, required) {
	let previous = -1;
	for (const command of required) {
		const index = steps.findIndex((step, i) => i > previous && step.run?.trim() === command);
		assert.ok(index > previous, `missing/misordered gate ${command}`);
		assert.equal(steps[index].if, undefined, `gate cannot be conditionally skipped: ${command}`);
		previous = index;
	}
}

const PR_GATES = [
	'npm ci --ignore-scripts',
	'npm run verify:install-policy',
	'npm ci',
	'npm run test:ci-policy',
	'npm run test:dependency-security',
	'npm run test:npm-desktop',
	'node --test scripts/tests/landing-ci-boundary.test.mjs',
	VENDOR_REGRESSION_COMMAND,
	ISSUE_FORM_COMMAND,
	DEVALUE_BOUNDARY_COMMAND,
	'npm run check --workspace=modutex-editor',
	'npm run lint --workspace=modutex-editor',
	'npm run testonce --workspace=modutex-editor',
	'npm run build --workspace=modutex-landing',
	'npm run test --workspace=texpile-typst-syntax-wasm',
	'npm exec --no -- tsc -p electron --noEmit',
	'npm run test:electron'
];

function nativePrContract(value) {
	safety(value);
	assert.deepEqual(value.on, { push: { branches: ['dev', 'main'] }, pull_request: null, workflow_call: null });
	assert.deepEqual(value.concurrency, {
		group: 'test-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
		'cancel-in-progress': true
	});
	assert.deepEqual(Object.keys(value.jobs).sort(), ['test', 'test-windows']);
	const names = new Set();
	for (const [id, os, shell, artifact] of [
		['test', 'ubuntu-latest', 'bash', 'ModuTeX-Linux-Supply-Chain-Reports'],
		['test-windows', 'windows-2025', 'pwsh', 'ModuTeX-Windows-Supply-Chain-Reports']
	]) {
		const job = value.jobs[id];
		assert.equal(job['runs-on'], os);
		assert.equal(job.if, undefined);
		assert.equal(job.needs, undefined);
		assert.equal(job.strategy, undefined);
		assert.deepEqual(job.defaults, shell === 'pwsh' ? { run: { shell: 'pwsh' } } : undefined);
		const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
		const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
		assert.equal(checkout.if, undefined);
		assert.equal(checkout.with['persist-credentials'], false);
		assert.equal(setup.if, undefined);
		assert.equal(String(setup.with['node-version']), '24.19.0');
		assert.equal(setup.with['package-manager-cache'], false);
		commandsInOrder(job.steps, PR_GATES);
		vendorRegressionContract(job);
		issueFormContract(job);
		devalueBoundaryContract(job);
		supplyChainContract(job.steps, shell);
		for (const step of job.steps.filter((step) => step.run)) {
			assert.ok(step.shell === undefined || step.shell === shell, `unexpected native shell in ${id}`);
		}
		const runtime = job.steps.find((step) => step.name === 'Verify runtime versions');
		assert.equal(runtime.if, undefined);
		assert.equal(runtime.shell, shell);
		assert.equal(
			runtime.run.trim(),
			shell === 'bash'
				? '[ "$(node --version)" = "v24.19.0" ]\n[ "$(npm --version)" = "11.17.0" ]'
				: "if ((node --version) -ne 'v24.19.0') { throw 'Node.js version mismatch' }\nif ((npm --version) -ne '11.17.0') { throw 'npm version mismatch' }"
		);
		const report = job.steps.find((step) => step.name === 'Upload supply-chain reports');
		assert.equal(report.with.name, artifact);
		assert.ok(!names.has(report.with.name));
		names.add(report.with.name);
	}
}

function supplyChainContract(steps, shell, prefix = '') {
	const signatures = steps.find((step) => step.id === 'registry-signatures');
	const audit = steps.find((step) => step.id === 'high-audit');
	for (const [step, command, report, exitVariable] of [
		[signatures, 'npm audit signatures --json', `${prefix}signature-report.json`, 'signatureExitCode'],
		[audit, 'npm audit --audit-level=high --json', `${prefix}audit-report.json`, 'auditExitCode']
	]) {
		assert.equal(step.shell, shell);
		assert.equal(step.if, undefined);
		assert.equal(
			step.run.trim(),
			shell === 'pwsh'
				? `${command} > ${report}\n$${exitVariable} = $LASTEXITCODE\nexit $${exitVariable}`
				: `if ${command} > ${report}; then\n  exit 0\nelse\n  exit $?\nfi`
		);
	}
	const report = steps.find((step) => step.name === 'Upload supply-chain reports');
	assert.equal(report.if, "always() && (steps.registry-signatures.outcome != 'skipped')");
	assert.equal(report.with.path.trim(), `${prefix}signature-report.json\n${prefix}audit-report.json`);
	assert.equal(report.with['if-no-files-found'], 'error');
	assert.ok(steps.indexOf(signatures) > steps.findIndex((step) => step.run === 'npm ci'));
	assert.ok(steps.indexOf(signatures) < steps.indexOf(audit));
	assert.ok(steps.indexOf(audit) < steps.indexOf(report));
	assert.ok(steps.indexOf(report) < steps.findIndex((step) => step.run === 'npm run test:ci-policy'));
}

function windowsContract(value) {
	safety(value);
	const job = value.jobs['verify-and-package'];
	assert.equal(job['runs-on'], 'windows-2025');
	const steps = job.steps;
	commandsInOrder(steps, [
		'npm ci --ignore-scripts',
		'npm run verify:install-policy',
		'npm run test:dependency-security',
		'npm ci',
		'npm run test:ci-policy',
		'npm run test:npm-desktop',
		'node --test scripts/tests/landing-ci-boundary.test.mjs',
		VENDOR_REGRESSION_COMMAND,
		ISSUE_FORM_COMMAND,
		DEVALUE_BOUNDARY_COMMAND,
		'npm run verify:modutex',
		'npm run build --workspace=modutex-landing',
		'npm run dist:dir -- --win --x64 --publish never'
	]);
	supplyChainContract(steps, 'pwsh', 'release/');
	vendorRegressionContract(job);
	issueFormContract(job);
	devalueBoundaryContract(job);
	const pack = steps.findIndex((step) => step.name === 'Stage and pack the production npm desktop package');
	const checksum = steps.findIndex((step) => step.name === 'Generate SHA-256 and verify npm tarball');
	const stage = steps.findIndex((step) => step.name === 'Stage npm tarball and verification evidence');
	const upload = steps.findIndex((step) => step.name === 'Upload the specified Windows x64 artifact');
	assert.ok(pack > steps.findIndex((step) => step.run === 'npm run dist:dir -- --win --x64 --publish never'));
	assert.ok(pack < checksum && checksum < stage && stage < upload);
	for (const index of [pack, checksum, stage, upload]) assert.equal(steps[index].if, undefined);
	for (const command of ['stage-npm-desktop.mjs', 'verify-npm-desktop.mjs --package-dir', 'npm pack', '--ignore-scripts', '--json'])
		assert.ok(steps[pack].run.includes(command), `missing npm staging gate ${command}`);
	assert.match(steps[pack].run, /git rev-parse HEAD/);
	assert.match(steps[pack].run, /Push-Location release\/npm-desktop-package/);
	assert.match(steps[pack].run, /npm pack --pack-destination \.\. --ignore-scripts --json/);
	assert.match(steps[pack].run, /finally \{\s+Pop-Location/);
	assert.match(steps[pack].run, /if \(\$LASTEXITCODE -ne 0\)/);
	assert.match(steps[checksum].run, /Get-FileHash.*-Algorithm SHA256/);
	assert.match(steps[checksum].run, /modutex-desktop-0\.1\.0\.tgz\.sha256/);
	assert.match(steps[checksum].run, /verify-npm-desktop\.mjs --tarball .*--sha256 \$recordedHash/);
	assert.match(steps[checksum].run, /tar -xzf \$tarballPath -C release\/tarball-verification/);
	assert.match(steps[checksum].run, /verify-npm-desktop\.mjs --package-dir release\/tarball-verification\/package/);
	assert.match(steps[checksum].run, /if \(\$LASTEXITCODE -ne 0\)/);
	assert.doesNotMatch(JSON.stringify(steps), /NSIS|ModuTeX-Setup|npm publish|gh release/);
	for (const path of [
		'LICENSE',
		'build\\license.txt',
		'TECTONIC-NOTICE.md',
		'TECTONIC-LICENSE.txt',
		'DRAWIO-NOTICE.md',
		'DRAWIO-LICENSE.txt',
		'audit-report.json',
		'signature-report.json',
		'SOURCE-OFFER.md',
		'npm-desktop-inventory.json',
		'npm-desktop-inventory.sha256',
		'modutex-desktop-0.1.0.tgz'
	]) {
		assert.ok(steps[stage].run.includes(path), `missing artifact evidence ${path}`);
	}
	assert.equal(steps[upload].with.name, 'ModuTeX-Windows-x64-0.1.0');
	assert.equal(steps[upload].with.path, 'release/artifact');
	assert.equal(steps[upload].with['if-no-files-found'], 'error');
}

test('both real workflows retain reviewed actions and strict failure semantics', async () => {
	for (const name of ['test.yml', 'modutex-ci.yml']) {
		const value = await workflow(name);
		safety(value);
		for (const job of Object.values(value.jobs)) {
			const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
			assert.equal(String(setup.with['node-version']), '24.19.0');
			assert.equal(setup.with['package-manager-cache'], false);
			assert.ok(job.steps.some((step) => step.run?.includes('npm --version') && step.run.includes('11.17.0')));
		}
	}
});

test('Linux and Windows branch/PR workflows retain every required real verification gate', async () => {
	nativePrContract(await workflow('test.yml'));
});

test('native PR contract rejects missing OS/gates, conditional skips, fail-open and duplicate reports', async () => {
	const original = await workflow('test.yml');
	const mutations = [
		(value) => {
			delete value.jobs['test-windows'];
		},
		(value) => {
			value.jobs['test-windows']['runs-on'] = 'ubuntu-latest';
		},
		(value) => {
			delete value.on.pull_request;
		},
		(value) => {
			value.jobs['test-windows'].if = "runner.os == 'Linux'";
		},
		(value) => {
			value.jobs['test-windows']['continue-on-error'] = true;
		},
		(value) => {
			value.jobs['test-windows'].steps.find((step) => step.name === 'Upload supply-chain reports').with.name =
				'ModuTeX-Linux-Supply-Chain-Reports';
		}
	];
	for (const id of ['test', 'test-windows']) {
		for (const command of PR_GATES) {
			mutations.push((value) => {
				value.jobs[id].steps = value.jobs[id].steps.filter((step) => step.run !== command);
			});
			mutations.push((value) => {
				value.jobs[id].steps.find((step) => step.run === command).if = "runner.os == 'Linux'";
			});
			mutations.push((value) => {
				value.jobs[id].steps.find((step) => step.run === command).run += ' || exit 0';
			});
		}
		for (const audit of ['registry-signatures', 'high-audit']) {
			mutations.push((value) => {
				value.jobs[id].steps.find((step) => step.id === audit).run += '\nexit 0';
			});
			mutations.push((value) => {
				value.jobs[id].steps.find((step) => step.id === audit).if = "runner.os == 'Linux'";
			});
		}
		mutations.push((value) => {
			value.jobs[id].steps.find((step) => step.name === 'Upload supply-chain reports').with.name = 'misleading';
		});
	}
	for (const mutate of mutations) {
		const value = structuredClone(original);
		mutate(value);
		assert.throws(() => nativePrContract(value));
	}
});

test('all three actual jobs require complete vendor regressions and reject omission, fail-open, skips and reordering', async () => {
	const branch = await workflow('test.yml');
	const packaging = await workflow('modutex-ci.yml');
	for (const job of [branch.jobs.test, branch.jobs['test-windows'], packaging.jobs['verify-and-package']]) {
		vendorRegressionContract(job);
		for (const mutate of [
			(value) => {
				value.steps = value.steps.filter((step) => step.run !== VENDOR_REGRESSION_COMMAND);
			},
			(value) => {
				value.steps.find((step) => step.run === VENDOR_REGRESSION_COMMAND).run += ' || exit 0';
			},
			(value) => {
				value.steps.find((step) => step.run === VENDOR_REGRESSION_COMMAND).run += '\nexit 0';
			},
			(value) => {
				value.steps.find((step) => step.run === VENDOR_REGRESSION_COMMAND).if = "runner.os == 'Windows'";
			},
			(value) => {
				value.steps.find((step) => step.run === VENDOR_REGRESSION_COMMAND)['continue-on-error'] = true;
			},
			(value) => {
				value.steps.find((step) => step.run === VENDOR_REGRESSION_COMMAND).shell = 'bash';
			},
			(value) => {
				value.steps.find((step) => step.run === VENDOR_REGRESSION_COMMAND).run = VENDOR_REGRESSION_COMMAND.replace(
					' scripts/tests/verify-packaged-vendor.test.mjs',
					''
				);
			},
			(value) => {
				value.steps.unshift(
					value.steps.splice(
						value.steps.findIndex((step) => step.run === VENDOR_REGRESSION_COMMAND),
						1
					)[0]
				);
			},
			(value) => {
				value.steps.push(
					value.steps.splice(
						value.steps.findIndex((step) => step.run === VENDOR_REGRESSION_COMMAND),
						1
					)[0]
				);
			},
			(value) => {
				value.steps.push({ run: VENDOR_REGRESSION_COMMAND });
			}
		]) {
			const changed = structuredClone(job);
			mutate(changed);
			assert.throws(() => vendorRegressionContract(changed));
		}
	}
});

test('all three actual jobs require issue-form regressions and reject omissions, skips, swallowed exits, duplicates and reordering', async () => {
	const branch = await workflow('test.yml');
	const packaging = await workflow('modutex-ci.yml');
	for (const job of [branch.jobs.test, branch.jobs['test-windows'], packaging.jobs['verify-and-package']]) {
		issueFormContract(job);
		for (const mutate of [
			(value) => {
				value.steps = value.steps.filter((step) => step.run !== ISSUE_FORM_COMMAND);
			},
			(value) => {
				value.steps.find((step) => step.run === ISSUE_FORM_COMMAND).if = "runner.os == 'Windows'";
			},
			(value) => {
				value.steps.find((step) => step.run === ISSUE_FORM_COMMAND)['continue-on-error'] = true;
			},
			(value) => {
				value.steps.find((step) => step.run === ISSUE_FORM_COMMAND).run += ' || exit 0';
			},
			(value) => {
				value.steps.find((step) => step.run === ISSUE_FORM_COMMAND).run += '\nexit 0';
			},
			(value) => {
				value.steps.find((step) => step.run === ISSUE_FORM_COMMAND).shell = 'bash';
			},
			(value) => {
				value.steps.push({ run: ISSUE_FORM_COMMAND });
			},
			(value) => {
				const gate = value.steps.splice(
					value.steps.findIndex((step) => step.run === ISSUE_FORM_COMMAND),
					1
				)[0];
				value.steps.splice(
					value.steps.findIndex((step) => step.run === VENDOR_REGRESSION_COMMAND),
					0,
					gate
				);
			},
			(value) => {
				value.steps.unshift(
					value.steps.splice(
						value.steps.findIndex((step) => step.run === ISSUE_FORM_COMMAND),
						1
					)[0]
				);
			},
			(value) => {
				value.steps.push(
					value.steps.splice(
						value.steps.findIndex((step) => step.run === ISSUE_FORM_COMMAND),
						1
					)[0]
				);
			}
		]) {
			const changed = structuredClone(job);
			mutate(changed);
			assert.throws(() => issueFormContract(changed));
		}
	}
});

test('all three actual jobs require devalue boundary regressions and reject omissions, skips, swallowed exits, duplicates and reordering', async () => {
	const branch = await workflow('test.yml');
	const packaging = await workflow('modutex-ci.yml');
	for (const job of [branch.jobs.test, branch.jobs['test-windows'], packaging.jobs['verify-and-package']]) {
		devalueBoundaryContract(job);
		for (const mutate of [
			(value) => {
				value.steps = value.steps.filter((step) => step.run !== DEVALUE_BOUNDARY_COMMAND);
			},
			(value) => {
				value.steps.find((step) => step.run === DEVALUE_BOUNDARY_COMMAND).if = "runner.os == 'Windows'";
			},
			(value) => {
				value.steps.find((step) => step.run === DEVALUE_BOUNDARY_COMMAND)['continue-on-error'] = true;
			},
			(value) => {
				value.steps.find((step) => step.run === DEVALUE_BOUNDARY_COMMAND).run += ' || exit 0';
			},
			(value) => {
				value.steps.find((step) => step.run === DEVALUE_BOUNDARY_COMMAND).run += '\nexit 0';
			},
			(value) => {
				value.steps.find((step) => step.run === DEVALUE_BOUNDARY_COMMAND).shell = 'bash';
			},
			(value) => {
				value.steps.push({ run: DEVALUE_BOUNDARY_COMMAND });
			},
			(value) => {
				const gate = value.steps.splice(
					value.steps.findIndex((step) => step.run === DEVALUE_BOUNDARY_COMMAND),
					1
				)[0];
				value.steps.splice(
					value.steps.findIndex((step) => step.run === ISSUE_FORM_COMMAND),
					0,
					gate
				);
			},
			(value) => {
				value.steps.unshift(
					value.steps.splice(
						value.steps.findIndex((step) => step.run === DEVALUE_BOUNDARY_COMMAND),
						1
					)[0]
				);
			},
			(value) => {
				value.steps.push(
					value.steps.splice(
						value.steps.findIndex((step) => step.run === DEVALUE_BOUNDARY_COMMAND),
						1
					)[0]
				);
			}
		]) {
			const changed = structuredClone(job);
			mutate(changed);
			assert.throws(() => devalueBoundaryContract(changed));
		}
	}
});

test('Electron security gate remains real in the aggregate, manifest and Linux workflow', async () => {
	const manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
	assert.equal(
		manifest.scripts['test:electron'],
		'npm exec --no -- vitest run --config electron/vitest.config.ts && node --test electron/tests/runtime-identity.test.mjs'
	);
	const config = await readFile(resolve(ROOT, 'electron/vitest.config.ts'), 'utf8');
	assert.match(config, /include: \['electron\/tests\/\*\*\/\*\.test\.ts'\]/);
	assert.doesNotMatch(config, /exclude|passWithNoTests|testNamePattern/);
	const gate = modutexChecks.findIndex(([, args]) => args.join(' ') === 'run test:electron');
	const typecheck = modutexChecks.findIndex(([, args]) => args.join(' ') === 'exec --no -- tsc -p electron --noEmit');
	assert.ok(gate > typecheck && typecheck >= 0);
	const required = ['npm exec --no -- tsc -p electron --noEmit', 'npm run test:electron'];
	const original = (await workflow('test.yml')).jobs.test.steps;
	commandsInOrder(original, required);
	for (const mutate of [
		(steps) => steps.filter((step) => step.run !== 'npm run test:electron'),
		(steps) => {
			steps.find((step) => step.run === 'npm run test:electron').if = 'false';
			return steps;
		},
		(steps) => steps.reverse()
	])
		assert.throws(() => commandsInOrder(mutate(structuredClone(original)), required));
});

test('Windows workflow gates before real npm desktop packaging and precise evidence artifact', async () => {
	windowsContract(await workflow('modutex-ci.yml'));
	const runner = await readFile(resolve(ROOT, 'scripts/run-verification.mjs'), 'utf8');
	for (const gate of ['verify:vendor', 'check', 'lint', 'testonce', 'texpile-typst-syntax-wasm', 'electron'])
		assert.ok(runner.includes(gate));
});

test('workflow contract rejects missing gates, swallowed failures and missing evidence', async () => {
	const original = await workflow('modutex-ci.yml');
	for (const mutate of [
		(value) => {
			value.jobs['verify-and-package']['continue-on-error'] = true;
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.id === 'high-audit')['continue-on-error'] = true;
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.id === 'high-audit').run =
				'npm audit --audit-level=critical --json > audit-report.json\nexit 0';
		},
		(value) => {
			value.jobs['verify-and-package'].steps = value.jobs['verify-and-package'].steps.filter(
				(step) => step.run !== 'npm run verify:modutex'
			);
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.name === 'Upload the specified Windows x64 artifact').with.name = 'wrong';
		},
		(value) => {
			value.jobs['verify-and-package'].steps[0].uses = 'actions/checkout@main';
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.run === 'npm run verify:modutex').if = 'false';
		},
		(value) => {
			value.jobs['verify-and-package'].permissions = { contents: 'write' };
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.id === 'registry-signatures').run =
				'npm audit signatures --json > signature-report.json\nexit 0';
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.name === 'Upload supply-chain reports').if = 'success()';
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.run?.startsWith('npm run dist:dir')).run = 'npm run dist -- --win --x64';
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.name === 'Stage and pack the production npm desktop package').if = 'false';
		},
		(value) => {
			value.jobs['verify-and-package'].steps.find((step) => step.name === 'Generate SHA-256 and verify npm tarball').run =
				'Get-FileHash release/modutex-desktop-0.1.0.tgz -Algorithm SHA256';
		},
		(value) => {
			const step = value.jobs['verify-and-package'].steps.find((step) => step.name === 'Stage npm tarball and verification evidence');
			step.run = step.run.replace('SOURCE-OFFER.md', 'README.md');
		}
	]) {
		const value = structuredClone(original);
		mutate(value);
		assert.throws(() => windowsContract(value));
	}
});

test('actual npm audit failures preserve JSON and nonzero exit through the native workflow shell', async (context) => {
	const directory = await mkdtemp(resolve(tmpdir(), 'modutex-ci-audit-negative-'));
	try {
		// A real npm project without a lockfile must fail both actual npm audit gates.
		// No fake npm executable or substituted audit response is involved.
		await writeFile(resolve(directory, 'package.json'), '{"name":"modutex-audit-negative","version":"1.0.0","private":true}\n');
		await mkdir(resolve(directory, 'release'));
		const nativeJobs =
			process.platform === 'win32'
				? [(await workflow('modutex-ci.yml')).jobs['verify-and-package'], (await workflow('test.yml')).jobs['test-windows']]
				: [(await workflow('test.yml')).jobs.test];
		for (const { steps } of nativeJobs) {
			for (const [id, report] of [
				['registry-signatures', 'signature-report.json'],
				['high-audit', 'audit-report.json']
			]) {
				const source = steps.find((step) => step.id === id).run;
				const result = spawnSync(
					process.platform === 'win32' ? 'pwsh' : 'bash',
					process.platform === 'win32'
						? ['-NoProfile', '-NonInteractive', '-Command', source]
						: ['--noprofile', '--norc', '-eo', 'pipefail', '-c', source],
					{ cwd: directory, env: { ...process.env, npm_config_local_prefix: directory }, encoding: 'utf8', timeout: 30000 }
				);
				assert.equal(result.error, undefined);
				assert.notEqual(result.status, null);
				assert.notEqual(result.status, 0, `actual ${id} failure must fail the workflow shell`);
				const reportPath = source.includes(`release/${report}`) ? `release/${report}` : report;
				const output = JSON.parse(await readFile(resolve(directory, reportPath), 'utf8'));
				assert.ok(output.error, `actual ${id} npm error must remain in the uploaded JSON`);
				context.diagnostic(
					JSON.stringify({ shell: process.platform === 'win32' ? 'pwsh' : 'bash', id, exit: result.status, error: output.error })
				);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
