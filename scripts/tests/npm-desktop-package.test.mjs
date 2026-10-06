import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import * as asar from '@electron/asar';
import { Script } from 'node:vm';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseStageArguments, stageNpmDesktopPackage } from '../stage-npm-desktop.mjs';
import {
	createNpmDesktopLauncher,
	createNpmDesktopPackageMetadata,
	createNpmDesktopReadme,
	createNpmDesktopSourceOffer,
	NPM_DESKTOP_STRIPPED_ENV_PATTERN,
	parseVerifyArguments,
	validateNpmPackageName,
	validateNpmPackageVersion,
	validateSourceCommit,
	verifyPackagedAppAsar,
	verifyNpmDesktopPackage,
	verifyNpmDesktopPayload,
	verifyNpmDesktopTarball
} from '../verify-npm-desktop.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);
const PACKAGE_NAME = '@modutex/desktop-launcher';
const VERSION = '0.1.0';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const temporaryDirectories = new Set();

async function makeTemporaryDirectory() {
	// GitHub's Windows runner places os.tmpdir() behind a reparse point. Fixtures live in the
	// canonical checkout so the verifier can keep rejecting aliases in real release payloads.
	const directory = await mkdtemp(path.join(REPOSITORY_ROOT, '.modutex-npm-desktop-test-'));
	temporaryDirectories.add(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
});

function errorHasCode(code) {
	return (error) => error instanceof Error && error.code === code;
}

function stageArgs(payloadDirectory, outputDirectory) {
	return [
		'--package-name',
		PACKAGE_NAME,
		'--version',
		VERSION,
		'--source-commit',
		SOURCE_COMMIT,
		'--payload-dir',
		payloadDirectory,
		'--output-dir',
		outputDirectory
	];
}

test('package metadata requires explicit valid name, version, and full source commit', () => {
	assert.equal(validateNpmPackageName(PACKAGE_NAME), PACKAGE_NAME);
	assert.equal(validateNpmPackageVersion(VERSION), VERSION);
	assert.equal(validateSourceCommit(SOURCE_COMMIT), SOURCE_COMMIT);
	assert.throws(() => validateNpmPackageName('ModuTeX'), errorHasCode('INVALID_PACKAGE_NAME'));
	assert.throws(() => validateNpmPackageName('@modutex/../desktop'), errorHasCode('INVALID_PACKAGE_NAME'));
	assert.throws(() => validateNpmPackageVersion('latest'), errorHasCode('INVALID_PACKAGE_VERSION'));
	assert.throws(() => validateSourceCommit('a'.repeat(12)), errorHasCode('INVALID_SOURCE_COMMIT'));

	const metadata = createNpmDesktopPackageMetadata(PACKAGE_NAME, VERSION, SOURCE_COMMIT);
	assert.deepEqual(metadata.os, ['win32']);
	assert.deepEqual(metadata.cpu, ['x64']);
	assert.equal('private' in metadata, false);
	assert.match(createNpmDesktopReadme(PACKAGE_NAME, VERSION), /npx --yes --package \.\\modutex-desktop-launcher-0\.1\.0\.tgz -- modutex/);
	assert.match(createNpmDesktopReadme(PACKAGE_NAME, VERSION), /not evidence of an npm registry publication/);
});

test('stage and verify CLIs reject missing, duplicate, and unknown arguments', () => {
	const temporaryDirectory = path.join(REPOSITORY_ROOT, '.npm-desktop-unused-fixture');
	assert.throws(() => parseStageArguments([]), errorHasCode('INVALID_ARGUMENTS'));
	assert.throws(
		() => parseStageArguments([...stageArgs(temporaryDirectory, temporaryDirectory), '--force', 'yes']),
		errorHasCode('INVALID_ARGUMENTS')
	);
	assert.throws(
		() => parseStageArguments([...stageArgs(temporaryDirectory, temporaryDirectory), '--version', '0.2.0']),
		errorHasCode('INVALID_ARGUMENTS')
	);
	assert.throws(() => parseVerifyArguments([]), errorHasCode('INVALID_ARGUMENTS'));
	assert.throws(
		() => parseVerifyArguments(['--package-dir', temporaryDirectory, '--package-name', PACKAGE_NAME]),
		errorHasCode('INVALID_ARGUMENTS')
	);
	assert.deepEqual(parseVerifyArguments(['--tarball', 'fixture.tgz', '--sha256', 'b'.repeat(64)]), {
		tarball: 'fixture.tgz',
		sha256: 'b'.repeat(64)
	});
});

test('generated launcher resolves beside itself, passes arguments without a shell, and filters launcher override/auth environment', () => {
	const launcher = createNpmDesktopLauncher();
	const strippedEnvironmentKey = new RegExp(NPM_DESKTOP_STRIPPED_ENV_PATTERN, 'i');
	assert.doesNotThrow(() => new Script(launcher, { filename: 'modutex.cjs' }));
	assert.match(launcher, /path\.resolve\(__dirname, '\.\.', 'app', 'win-unpacked'\)/);
	assert.match(launcher, /spawn\(executable, process\.argv\.slice\(2\)/);
	assert.match(launcher, /shell: false/);
	assert.equal(strippedEnvironmentKey.test('ELECTRON_START_URL'), true);
	assert.equal(strippedEnvironmentKey.test('npm_config_userconfig'), true);
	assert.equal(strippedEnvironmentKey.test('TEXPILE_USER_DATA'), false);
	assert.match(launcher, /electron_start_url/i);
	assert.match(launcher, /detached: true/);
	assert.match(launcher, /windowsHide: false/);
	assert.doesNotMatch(launcher, /shell:\s*true/);
});

test('source offer records a revision without claiming binary provenance', () => {
	const sourceOffer = createNpmDesktopSourceOffer(SOURCE_COMMIT);
	assert.match(sourceOffer, new RegExp(`github\\.com/leo2783/latex/tree/${SOURCE_COMMIT}`));
	assert.match(sourceOffer, /does not attest that the application payload was built from this revision/);
	assert.match(sourceOffer, /trusted build record binding the production build and payload hashes/);
});

test('payload verifier rejects a directory that is not named win-unpacked', async () => {
	const root = await makeTemporaryDirectory();
	await assert.rejects(verifyNpmDesktopPayload(root), errorHasCode('INVALID_PAYLOAD_ROOT'));
});

test('ASAR verifier rejects a malformed archive before inspecting packaged app metadata', async (context) => {
	const root = await makeTemporaryDirectory();
	const archive = path.join(root, 'app.asar');
	await writeFile(archive, Buffer.from('malformed ASAR boundary fixture'));
	assert.throws(() => verifyPackagedAppAsar(archive, VERSION), errorHasCode('INVALID_APP_ASAR'));
	context.diagnostic('Malformed archive boundary only; this is not a valid app.asar or production payload.');
});

test('ASAR verifier extracts nested required entries using the native platform path separator', async () => {
	const root = await makeTemporaryDirectory();
	const source = path.join(root, 'source');
	await mkdir(path.join(source, 'electron', 'dist'), { recursive: true });
	await writeFile(
		path.join(source, 'package.json'),
		JSON.stringify({
			name: 'modutex-desktop',
			version: VERSION,
			license: 'AGPL-3.0-only',
			main: 'electron/dist/main.js',
			dependencies: { 'node-pty': '1.1.0' }
		})
	);
	for (const filename of ['main.js', 'preload.js', 'drawio-relay.js'])
		await writeFile(path.join(source, 'electron', 'dist', filename), '// ASAR path boundary fixture, not an application\n');
	const archive = path.join(root, 'app.asar');
	await asar.createPackage(source, archive);
	assert.throws(() => verifyPackagedAppAsar(archive, VERSION), errorHasCode('INVALID_APP_ASAR_ENTRY'));
	await writeFile(
		path.join(source, 'electron', 'dist', 'diagram-cpu-worker.js'),
		'// ASAR worker presence boundary fixture, not a running worker\n'
	);
	const completeArchive = path.join(root, 'complete-app.asar');
	await asar.createPackage(source, completeArchive);
	assert.doesNotThrow(() => verifyPackagedAppAsar(completeArchive, VERSION));
});

test('payload verifier rejects incomplete fixtures before they can be treated as a release', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	await mkdir(payload);
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('INCOMPLETE_PRODUCTION_PAYLOAD'));
});

test('payload verifier admits only the approved unpacked node-pty path before rejecting the incomplete fixture', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	const nodePty = path.join(payload, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
	await mkdir(nodePty, { recursive: true });
	await writeFile(path.join(nodePty, 'package.json'), '{"version":"1.1.0"}\n');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('INCOMPLETE_PRODUCTION_PAYLOAD'));
});

test('payload verifier rejects unexpected unpacked dependencies and development files', async (context) => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	const unexpectedModule = path.join(payload, 'resources', 'app.asar.unpacked', 'node_modules', 'not-node-pty');
	await mkdir(unexpectedModule, { recursive: true });
	await writeFile(path.join(unexpectedModule, 'index.js'), 'module.exports = {};\n');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('UNEXPECTED_NODE_MODULE'));
	context.diagnostic('Boundary fixture only: this intentionally incomplete tree is not a production payload.');

	await rm(payload, { recursive: true, force: true });
	await mkdir(path.join(payload, 'resources', 'app-dist', 'tests'), { recursive: true });
	await writeFile(path.join(payload, 'resources', 'app-dist', 'tests', 'fixture.json'), '{}\n');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('DEVELOPMENT_FILE'));
});

test('payload verifier rejects credential-like files', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	await mkdir(path.join(payload, 'resources', 'app-dist'), { recursive: true });
	await writeFile(path.join(payload, 'resources', 'app-dist', '.npmrc'), '//registry.npmjs.org/:_authToken=do-not-ship\n');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('CREDENTIAL_FILE'));
});

test('only the two pinned Draw.io sourcemap paths survive development-file preflight', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	const webapp = path.join(payload, 'resources', 'vendor', 'drawio', 'src', 'main', 'webapp');
	await mkdir(webapp, { recursive: true });
	for (const filename of ['service-worker.js.map', 'workbox-05b6c01b.js.map']) {
		await writeFile(path.join(webapp, filename), '{}');
	}
	// This boundary fixture must still fail: the complete production payload and pinned
	// vendor hash are mandatory. Permitted path spelling alone proves no provenance.
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('INCOMPLETE_PRODUCTION_PAYLOAD'));
	await writeFile(path.join(webapp, 'unreviewed.js.map'), '{}');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('DEVELOPMENT_FILE'));
	await rm(path.join(webapp, 'unreviewed.js.map'));
	await mkdir(path.join(payload, 'resources', 'app-dist'), { recursive: true });
	await writeFile(path.join(payload, 'resources', 'app-dist', 'service-worker.js.map'), '{}');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('DEVELOPMENT_FILE'));
});

test('production builder excludes only node-pty build headers and keeps the native runtime contract', async () => {
	const config = await readFile(path.join(REPOSITORY_ROOT, 'electron-builder.yml'), 'utf8');
	assert.match(config, /'!\*\*\/node_modules\/node-addon-api\/\*\*'/);
	assert.doesNotMatch(config, /'!\*\*\/node_modules\/\*\*'/);
	assert.match(config, /'\*\*\/node_modules\/node-pty\/\*\*'/);
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	const headers = path.join(payload, 'resources', 'app.asar.unpacked', 'node_modules', 'node-addon-api');
	await mkdir(headers, { recursive: true });
	await writeFile(path.join(headers, 'index.js'), 'module.exports = "build-only";');
	await assert.rejects(verifyNpmDesktopPayload(payload), errorHasCode('UNEXPECTED_NODE_MODULE'));
});

test('staging does not create output when production-payload preflight fails', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	const output = path.join(root, 'npm-package');
	await mkdir(payload);
	await assert.rejects(
		stageNpmDesktopPackage({
			packageName: PACKAGE_NAME,
			version: VERSION,
			sourceCommit: SOURCE_COMMIT,
			payloadDirectory: payload,
			outputDirectory: output
		}),
		errorHasCode('INCOMPLETE_PRODUCTION_PAYLOAD')
	);
	await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('staging refuses an existing output path without changing its contents', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	const output = path.join(root, 'already-exists');
	await mkdir(payload);
	await mkdir(output);
	await writeFile(path.join(output, 'keep.txt'), 'untouched');
	await assert.rejects(
		stageNpmDesktopPackage({
			packageName: PACKAGE_NAME,
			version: VERSION,
			sourceCommit: SOURCE_COMMIT,
			payloadDirectory: payload,
			outputDirectory: output
		}),
		errorHasCode('OUTPUT_EXISTS')
	);
	assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'untouched');
});

test('staging rejects output paths overlapping the supplied payload', async () => {
	const root = await makeTemporaryDirectory();
	const payload = path.join(root, 'win-unpacked');
	await mkdir(payload);
	await assert.rejects(
		stageNpmDesktopPackage({
			packageName: PACKAGE_NAME,
			version: VERSION,
			sourceCommit: SOURCE_COMMIT,
			payloadDirectory: payload,
			outputDirectory: path.join(payload, 'package-output')
		}),
		errorHasCode('OUTPUT_OVERLAP')
	);
});

test('package verifier rejects unexpected files rather than accepting a fixture as a complete package', async () => {
	const root = await makeTemporaryDirectory();
	await writeFile(path.join(root, 'unexpected.txt'), 'not a package');
	await assert.rejects(
		verifyNpmDesktopPackage(root, { packageName: PACKAGE_NAME, version: VERSION, sourceCommit: SOURCE_COMMIT }),
		errorHasCode('UNEXPECTED_PACKAGE_ENTRY')
	);
});

test('tarball verifier checks a separately supplied digest only (fixture is not an npm archive)', async (context) => {
	const root = await makeTemporaryDirectory();
	const tarball = path.join(root, 'checksum-boundary-fixture.tgz');
	const bytes = Buffer.from('checksum boundary fixture; not a tarball and not a distribution');
	await writeFile(tarball, bytes);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const report = await verifyNpmDesktopTarball(tarball, sha256);
	assert.equal(report.sha256, sha256);
	assert.equal(report.bytes, bytes.length);
	await assert.rejects(verifyNpmDesktopTarball(tarball, '0'.repeat(64)), errorHasCode('TARBALL_CHECKSUM_MISMATCH'));
	context.diagnostic('This tiny file exercises digest comparison only; it is not parsed or accepted as an npm package.');
});
