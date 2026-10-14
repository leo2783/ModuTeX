import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const upstreamChecks = [
	['editor typecheck', ['run', 'check', '--workspace=modutex-editor']],
	['Electron typecheck', ['exec', '--no', '--', 'tsc', '-p', 'electron', '--noEmit']]
];

export const modutexChecks = [
	['install policy', ['run', 'verify:install-policy']],
	['vendor policy', ['run', 'verify:vendor']],
	...upstreamChecks,
	['Electron security tests', ['run', 'test:electron']],
	['editor lint', ['run', 'lint', '--workspace=modutex-editor']],
	['editor unit tests', ['run', 'testonce', '--workspace=modutex-editor']],
	['Typst parser tests', ['run', 'test', '--workspace=texpile-typst-syntax-wasm']]
];

export function resolveNpmCli(env = process.env) {
	const npmCli = env.npm_execpath;
	if (typeof npmCli !== 'string' || npmCli.length === 0) {
		throw new Error('npm_execpath is required and must identify the active npm CLI file');
	}
	if (!isAbsolute(npmCli)) throw new Error('npm_execpath must be an absolute path');
	try {
		if (!statSync(npmCli).isFile()) throw new Error('not a regular file');
	} catch {
		throw new Error('npm_execpath must point to an existing regular file');
	}
	return npmCli;
}

export function runChecks(checks, { npmCli, cwd = process.cwd(), env = process.env, stdio = 'inherit' } = {}) {
	for (const [label, args] of checks) {
		if (stdio === 'inherit') console.log(`\n[verify] ${label}`);
		let result;
		try {
			result = spawnSync(process.execPath, [npmCli, ...args], {
				cwd,
				env,
				shell: false,
				stdio
			});
		} catch {
			return 1;
		}
		if (result.error) return 1;
		const status = Number.isInteger(result.status) ? result.status : 1;
		if (status !== 0) return status;
	}
	return 0;
}

const mode = process.argv[2];
const checks = mode === 'upstream' ? upstreamChecks : mode === 'modutex' ? modutexChecks : null;
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
	if (!checks) {
		console.error('Usage: node scripts/run-verification.mjs <upstream|modutex>');
		process.exitCode = 2;
	} else {
		try {
			process.exitCode = runChecks(checks, { npmCli: resolveNpmCli() });
			if (process.exitCode === 0) console.log(`\n${mode} verification passed.`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
