import { execFileSync } from 'node:child_process';
import { cp, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	createNpmDesktopInventory,
	createNpmDesktopLauncher,
	createNpmDesktopPackageMetadata,
	createNpmDesktopReadme,
	createNpmDesktopSourceOffer,
	NPM_DESKTOP_INVENTORY,
	NPM_DESKTOP_INVENTORY_SHA,
	validateNpmPackageName,
	validateNpmPackageVersion,
	validateSourceCommit,
	verifyNpmDesktopPackage,
	verifyNpmDesktopPayload
} from './verify-npm-desktop.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class NpmDesktopStageError extends Error {
	constructor(code, message = code) {
		super(message);
		this.name = 'NpmDesktopStageError';
		this.code = code;
	}
}

function fail(code, message = code) {
	throw new NpmDesktopStageError(code, message);
}

function pathKey(value) {
	const normalized = path.resolve(value).replaceAll('\\', '/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertPlainDirectory(directory, code) {
	const absolute = path.resolve(directory);
	const info = await lstat(absolute).catch(() => null);
	if (!info?.isDirectory() || info.isSymbolicLink())
		fail(code, 'A required directory must exist and must not be a symlink or reparse point.');
	const canonical = await realpath(absolute).catch(() => null);
	if (!canonical || pathKey(canonical) !== pathKey(absolute))
		fail(code, 'A required directory path must not contain an alias or reparse point.');
	return canonical;
}

function requiredValue(values, flag) {
	const value = values.get(flag);
	if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
	return value;
}

export function parseStageArguments(args) {
	const allowed = new Set(['--package-name', '--version', '--source-commit', '--payload-dir', '--output-dir']);
	const values = new Map();
	if (!Array.isArray(args) || args.length % 2 !== 0) fail('INVALID_ARGUMENTS');
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!allowed.has(flag) || typeof value !== 'string' || !value || value.startsWith('--') || values.has(flag)) {
			fail('INVALID_ARGUMENTS');
		}
		values.set(flag, value);
	}
	if (values.size !== allowed.size || [...allowed].some((flag) => !values.has(flag))) fail('INVALID_ARGUMENTS');
	return {
		packageName: validateNpmPackageName(requiredValue(values, '--package-name')),
		version: validateNpmPackageVersion(requiredValue(values, '--version')),
		sourceCommit: validateSourceCommit(requiredValue(values, '--source-commit')),
		payloadDirectory: path.resolve(requiredValue(values, '--payload-dir')),
		outputDirectory: path.resolve(requiredValue(values, '--output-dir'))
	};
}

async function assertOutputTarget(payloadDirectory, outputDirectory) {
	const payloadRoot = path.resolve(payloadDirectory);
	const outputRoot = path.resolve(outputDirectory);
	if (path.basename(outputRoot) === '' || outputRoot === path.parse(outputRoot).root) {
		fail('INVALID_OUTPUT_DIRECTORY', 'Choose a new output directory below an existing parent.');
	}
	const parent = await assertPlainDirectory(path.dirname(outputRoot), 'INVALID_OUTPUT_PARENT');
	const normalizedOutput = path.join(parent, path.basename(outputRoot));
	const existing = await lstat(normalizedOutput).catch(() => null);
	if (existing) fail('OUTPUT_EXISTS', 'The output directory already exists; staging never overwrites an existing path.');
	if (isWithin(payloadRoot, normalizedOutput) || isWithin(normalizedOutput, payloadRoot)) {
		fail('OUTPUT_OVERLAP', 'The output directory must not overlap the supplied win-unpacked payload.');
	}
	return { parent, output: normalizedOutput };
}

async function removeTemporaryDirectory(directory, parent) {
	const info = await lstat(directory).catch(() => null);
	if (!info?.isDirectory() || info.isSymbolicLink()) return;
	const canonical = await realpath(directory).catch(() => null);
	if (!canonical || !isWithin(parent, canonical) || pathKey(canonical) !== pathKey(directory)) return;
	await rm(directory, { recursive: true, force: true }).catch(() => {});
}

function assertSourceRevision(sourceCommit) {
	let currentCommit;
	let status;
	try {
		currentCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true
		}).trim();
		status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true
		}).trim();
	} catch {
		fail('SOURCE_REVISION_UNVERIFIABLE', 'Run staging from a Git checkout with an accessible HEAD.');
	}
	if (currentCommit.toLowerCase() !== sourceCommit)
		fail('SOURCE_COMMIT_MISMATCH', 'The supplied source commit must equal this checkout HEAD.');
	if (status) fail('DIRTY_SOURCE_TREE', 'Staging requires a clean source checkout so the source offer identifies the built code.');
}

export async function stageNpmDesktopPackage(options) {
	const packageName = validateNpmPackageName(options?.packageName);
	const version = validateNpmPackageVersion(options?.version);
	const sourceCommit = validateSourceCommit(options?.sourceCommit);
	if (typeof options?.payloadDirectory !== 'string' || typeof options?.outputDirectory !== 'string') {
		fail('INVALID_ARGUMENTS', 'Payload and output directories are required.');
	}
	const payloadDirectory = path.resolve(options.payloadDirectory);
	const outputDirectory = path.resolve(options.outputDirectory);
	if (path.basename(payloadDirectory).toLowerCase() !== 'win-unpacked') {
		fail('INVALID_PAYLOAD_ROOT', 'Supply the actual electron-builder win-unpacked directory.');
	}
	const { parent, output } = await assertOutputTarget(payloadDirectory, outputDirectory);
	const sourceRealPath = await realpath(payloadDirectory).catch(() => null);
	if (!sourceRealPath) fail('INVALID_PAYLOAD_ROOT', 'The supplied win-unpacked directory does not exist.');
	if (isWithin(sourceRealPath, output) || isWithin(output, sourceRealPath)) {
		fail('OUTPUT_OVERLAP', 'The output directory must not overlap the supplied win-unpacked payload.');
	}

	// Validate the caller-provided production artifact before creating any output.
	await verifyNpmDesktopPayload(payloadDirectory, { expectedVersion: version });
	assertSourceRevision(sourceCommit);

	const expected = { packageName, version, sourceCommit };
	const temporaryRoot = await mkdtemp(path.join(parent, '.modutex-npm-desktop-stage-'));
	let published = false;
	try {
		const appRoot = path.join(temporaryRoot, 'app');
		await mkdir(appRoot);
		const stagedPayload = path.join(appRoot, 'win-unpacked');
		await cp(payloadDirectory, stagedPayload, {
			recursive: true,
			errorOnExist: true,
			force: false,
			verbatimSymlinks: true,
			preserveTimestamps: true
		});
		await verifyNpmDesktopPayload(stagedPayload, { expectedVersion: version });

		await copyFile(path.join(REPO_ROOT, 'LICENSE'), path.join(temporaryRoot, 'LICENSE'));
		await writeFile(path.join(temporaryRoot, 'README.md'), createNpmDesktopReadme(packageName, version), 'utf8');
		await writeFile(path.join(temporaryRoot, 'SOURCE-OFFER.md'), createNpmDesktopSourceOffer(sourceCommit), 'utf8');
		await writeFile(
			path.join(temporaryRoot, 'package.json'),
			`${JSON.stringify(createNpmDesktopPackageMetadata(packageName, version, sourceCommit), null, 2)}\n`,
			'utf8'
		);
		const binDirectory = path.join(temporaryRoot, 'bin');
		await mkdir(binDirectory);
		await writeFile(path.join(binDirectory, 'modutex.cjs'), createNpmDesktopLauncher(), { encoding: 'utf8', mode: 0o755 });

		const inventory = await createNpmDesktopInventory(temporaryRoot, expected);
		await writeFile(path.join(temporaryRoot, NPM_DESKTOP_INVENTORY), inventory.bytes);
		await writeFile(path.join(temporaryRoot, NPM_DESKTOP_INVENTORY_SHA), inventory.checksum, 'utf8');
		const verification = await verifyNpmDesktopPackage(temporaryRoot, expected);

		// Recheck just before the final rename. Existing destinations are never overwritten.
		if (
			await lstat(output).then(
				() => true,
				() => false
			)
		) {
			fail('OUTPUT_EXISTS', 'The output directory appeared during staging; the existing path was left untouched.');
		}
		await rename(temporaryRoot, output);
		published = true;
		return { ...verification, outputDirectory: output };
	} finally {
		if (!published) await removeTemporaryDirectory(temporaryRoot, parent);
	}
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	try {
		const options = parseStageArguments(process.argv.slice(2));
		const report = await stageNpmDesktopPackage(options);
		console.log(
			`Staged ${report.name}@${report.version} from ${report.sourceCommit}: ${report.fileCount} files at ${report.outputDirectory}.`
		);
		console.log(`Inventory sha256 ${report.inventorySha256}; this is an integrity record, not a signature.`);
	} catch (error) {
		console.error(`npm desktop staging failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
