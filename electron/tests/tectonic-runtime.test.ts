import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareTectonicRuntime, type TectonicRuntimeContext } from '../src/tectonic-runtime';
import { TECTONIC_VERSION, TECTONIC_EXECUTABLE_SIZE, TECTONIC_EXECUTABLE_SHA256 } from '../src/tectonic-integrity';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<TectonicRuntimeContext> {
	// Hosted Windows TEMP can contain an 8.3 alias; trusted runtime paths are canonical.
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'modutex-runtime-')));
	temporary.push(root);
	await mkdir(path.join(root, 'vendor/tectonic/windows-x64'), { recursive: true });
	await copyFile(
		path.join(repository, 'vendor/tectonic/windows-x64/tectonic.exe'),
		path.join(root, 'vendor/tectonic/windows-x64/tectonic.exe')
	);
	await writeFile(path.join(root, 'vendor/tectonic/VERSION'), '0.17.0\n');
	await mkdir(path.join(root, 'userData'));
	return { isPackaged: true, resourcesPath: root, appPath: path.join(root, 'untrusted-app'), userData: path.join(root, 'userData') };
}

describe('platform-neutral managed Tectonic contracts', () => {
	it('contract: exactly matches the existing vendor module exports', async () => {
		const vendor = await import('../../scripts/vendor/tectonic-vendor.mjs');
		expect(TECTONIC_VERSION).toBe(vendor.TECTONIC_VERSION);
		expect(TECTONIC_EXECUTABLE_SIZE).toBe(vendor.TECTONIC_EXECUTABLE_SIZE);
		expect(TECTONIC_EXECUTABLE_SHA256).toBe(vendor.TECTONIC_EXECUTABLE_SHA256);
	});
	it('contract: architecture rejection is reached on every test host', async () => {
		// Negative-only platform override: never permits a fake successful Windows executable.
		vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
		let archReads = 0;
		vi.spyOn(process, 'arch', 'get').mockImplementation(() => {
			archReads++;
			return 'arm64';
		});
		const sentinel = vi.spyOn(childProcess, 'execFile').mockImplementation(() => {
			throw new Error('unexpected spawn');
		});
		expect(await prepareTectonicRuntime({ isPackaged: true, resourcesPath: '', appPath: '', userData: '' })).toEqual({
			ok: false,
			error: 'managed-engine-unavailable'
		});
		expect(archReads).toBeGreaterThan(0);
		expect(sentinel).not.toHaveBeenCalled();
	});
	it('rejects unsupported platform without filesystem access or execution', async () => {
		if (process.platform === 'win32') vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const sentinel = vi.spyOn(childProcess, 'execFile').mockImplementation(() => {
			throw new Error('unexpected spawn');
		});
		expect(await prepareTectonicRuntime({ isPackaged: true, resourcesPath: '', appPath: '', userData: '' })).toEqual({
			ok: false,
			error: 'managed-engine-unavailable'
		});
		expect(sentinel).not.toHaveBeenCalled();
	});
});

// Inapplicable on Linux, not optional on the required Windows-2025 PR CI leg.
// The predicate uses the genuine host before any negative-only process property spies.
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('Windows x64 managed Tectonic prerequisite', () => {
	it('contract: rejects missing VERSION without starting a process', async () => {
		const context = await fixture();
		await rm(path.join(context.resourcesPath, 'vendor/tectonic/VERSION'));
		const sentinel = vi.spyOn(childProcess, 'execFile').mockImplementation(() => {
			throw new Error('unexpected spawn');
		});
		expect(await prepareTectonicRuntime(context)).toEqual({ ok: false, error: 'managed-engine-unavailable' });
		expect(sentinel).not.toHaveBeenCalled();
	});

	it('contract: genuine version call uses fixed argv and bounded shell-free controlled options', async () => {
		const context = await fixture();
		vi.stubEnv('TECTONIC_CACHE_DIR', 'C:\\untrusted-cache');
		vi.stubEnv('tEcToNiC_cAcHe_DiR', 'C:\\second-untrusted-cache');
		vi.stubEnv('HTTPS_PROXY', 'https://untrusted-proxy.invalid');
		const genuine = childProcess.execFile;
		const observed: unknown[][] = [];
		vi.spyOn(childProcess, 'execFile').mockImplementation(((file, args, options, callback) => {
			observed.push([file, args, options]);
			return genuine(file, args, options, callback);
		}) as typeof childProcess.execFile);
		const result = await prepareTectonicRuntime(context);
		expect(result.ok).toBe(true);
		expect(observed).toHaveLength(1);
		const [file, args, options] = observed[0]!;
		expect(file).toBe(path.join(context.resourcesPath, 'vendor/tectonic/windows-x64/tectonic.exe'));
		expect(args).toEqual(['--version']);
		expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 8000, maxBuffer: 4096, encoding: 'utf8' });
		expect(options).not.toHaveProperty('cwd'); // no renderer/workspace cwd reaches the version probe
		const env = (options as { env: NodeJS.ProcessEnv }).env;
		expect(Object.keys(env).filter((key) => key.toLowerCase() === 'tectonic_cache_dir')).toEqual(['TECTONIC_CACHE_DIR']);
		expect(env.TECTONIC_CACHE_DIR).toBe(path.join(context.userData, 'tectonic-cache'));
		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(Object.keys(env).every((key) => ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'TECTONIC_CACHE_DIR'].includes(key))).toBe(true);
	}, 30000);

	it.each(['exit', 'stderr', 'wrong-output', 'timeout', 'max-buffer'])(
		'contract: fails closed on version callback %s fault after genuine execution',
		async (fault) => {
			const context = await fixture();
			const genuine = childProcess.execFile;
			let genuineCompleted = false;
			vi.spyOn(childProcess, 'execFile').mockImplementation(((file, args, options, callback) =>
				genuine(file, args, options, (error, stdout, stderr) => {
					genuineCompleted = !error && String(stdout).trim() === 'Tectonic 0.17.0' && !String(stderr).trim();
					if (!genuineCompleted) {
						callback(error ?? new Error('genuine version failed'), stdout, stderr);
						return;
					}
					// Negative fault injection only: never manufacture a successful version result.
					if (fault === 'stderr') callback(null, stdout, 'unexpected diagnostic');
					else if (fault === 'wrong-output') callback(null, 'Tectonic 0.17.1\n', stderr);
					else
						callback(
							Object.assign(new Error('injected negative process fault'), {
								code: fault === 'exit' ? 1 : fault === 'timeout' ? 'ETIMEDOUT' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
								killed: fault === 'timeout'
							}),
							stdout,
							stderr
						);
				})) as typeof childProcess.execFile);
			expect(await prepareTectonicRuntime(context)).toEqual({ ok: false, error: 'managed-engine-unavailable' });
			expect(genuineCompleted).toBe(true);
		},
		30000
	);

	it('uses real trusted packaged bytes and --version with one controlled cache environment', async () => {
		const context = await fixture();
		vi.stubEnv('TeCtOnIc_CaChE_DiR', 'C:\\untrusted-cache');
		vi.stubEnv('NODE_OPTIONS', '--untrusted');
		vi.stubEnv('PATH', 'C:\\untrusted-tools');
		const result = await prepareTectonicRuntime(context);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('trusted runtime failed');
		expect(result.version).toBe('0.17.0');
		expect(result.executable).toBe(path.join(context.resourcesPath, 'vendor/tectonic/windows-x64/tectonic.exe'));
		expect(result.cache).toBe(path.join(context.userData, 'tectonic-cache'));
		expect(Object.keys(result.env).filter((key) => key.toLowerCase() === 'tectonic_cache_dir')).toEqual(['TECTONIC_CACHE_DIR']);
		expect(result.env.NODE_OPTIONS).toBeUndefined();
		expect(result.env.PATH).not.toContain('untrusted-tools');
	}, 30000);

	it('uses dev appPath only, revalidating the true retained executable each time', async () => {
		const context = await fixture();
		context.isPackaged = false;
		context.appPath = context.resourcesPath;
		context.resourcesPath = path.join(context.appPath, 'untrusted-resources');
		expect((await prepareTectonicRuntime(context)).ok).toBe(true);
		await writeFile(path.join(context.appPath, 'vendor/tectonic/VERSION'), '0.17.1\n');
		const sentinel = vi.spyOn(childProcess, 'execFile').mockImplementation(() => {
			throw new Error('unexpected spawn');
		});
		expect(await prepareTectonicRuntime(context)).toEqual({ ok: false, error: 'managed-engine-unavailable' });
		expect(sentinel).not.toHaveBeenCalled();
	}, 30000);

	it.each(['missing', 'hash', 'version', 'directory', 'cache-junction', 'executable-junction', 'vendor-junction'])(
		'rejects %s before any process starts',
		async (kind) => {
			const context = await fixture();
			const executable = path.join(context.resourcesPath, 'vendor/tectonic/windows-x64/tectonic.exe');
			if (kind === 'missing' || kind === 'directory') {
				await rm(executable);
				if (kind === 'directory') await mkdir(executable);
			} else if (kind === 'hash') {
				const bytes = await readFile(executable);
				bytes[bytes.length - 1] ^= 1;
				await writeFile(executable, bytes);
			} else if (kind === 'version') {
				await writeFile(path.join(context.resourcesPath, 'vendor/tectonic/VERSION'), '0.17.1\n');
			} else {
				const external = await realpath(await mkdtemp(path.join(tmpdir(), 'modutex-runtime-link-')));
				temporary.push(external);
				const target =
					kind === 'cache-junction'
						? path.join(context.userData, 'tectonic-cache')
						: kind === 'vendor-junction'
							? path.join(context.resourcesPath, 'vendor')
							: path.dirname(executable);
				await rm(target, { recursive: true, force: true });
				await symlink(external, target, 'junction');
			}
			const sentinel = vi.spyOn(childProcess, 'execFile').mockImplementation(() => {
				throw new Error('unexpected spawn');
			});
			expect(await prepareTectonicRuntime(context)).toEqual({ ok: false, error: 'managed-engine-unavailable' });
			expect(sentinel).not.toHaveBeenCalled();
		},
		30000
	);

	it.each(['VERSION', 'executable', 'cache'])(
		'detects %s replacement after a genuine successful version probe',
		async (kind) => {
			const context = await fixture();
			const genuine = childProcess.execFile;
			const replace = async () => {
				if (kind === 'VERSION') await writeFile(path.join(context.resourcesPath, 'vendor/tectonic/VERSION'), '0.17.1\n');
				else if (kind === 'executable') {
					const filename = path.join(context.resourcesPath, 'vendor/tectonic/windows-x64/tectonic.exe');
					const bytes = await readFile(filename);
					bytes[bytes.length - 1] ^= 1;
					await writeFile(filename, bytes);
				} else {
					const external = await realpath(await mkdtemp(path.join(tmpdir(), 'modutex-runtime-race-')));
					temporary.push(external);
					const cache = path.join(context.userData, 'tectonic-cache');
					await rm(cache, { recursive: true });
					await symlink(external, cache, 'junction');
				}
			};
			// The real executable runs. Mutate the filesystem before delivering its real callback.
			vi.spyOn(childProcess, 'execFile').mockImplementation(((file, args, options, callback) =>
				genuine(file, args, options, (error, stdout, stderr) => {
					void replace().then(
						() => callback(error, stdout, stderr),
						(failure) => callback(failure, stdout, stderr)
					);
				})) as typeof childProcess.execFile);
			expect(await prepareTectonicRuntime(context)).toEqual({ ok: false, error: 'managed-engine-unavailable' });
		},
		30000
	);
});
