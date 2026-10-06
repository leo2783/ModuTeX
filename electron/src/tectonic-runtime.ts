import childProcess from 'node:child_process';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { assertTectonicIntegrity, TECTONIC_EXECUTABLE_SIZE, TECTONIC_VERSION } from './tectonic-integrity';

/** Main-owned context only. No renderer/settings executable or cache overrides. */
export interface TectonicRuntimeContext {
	isPackaged: boolean;
	resourcesPath: string;
	appPath: string;
	userData: string;
}

export type TectonicRuntimeResult =
	| { ok: true; executable: string; cache: string; version: '0.17.0'; env: NodeJS.ProcessEnv }
	| { ok: false; error: 'managed-engine-unavailable' };

function samePath(a: string, b: string): boolean {
	return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Reject links/junctions in every component, including the main-owned root. */
async function canonicalRegular(target: string, directory: boolean): Promise<string> {
	if (!path.isAbsolute(target)) throw new Error('PATH');
	const absolute = path.resolve(target);
	let cursor = path.parse(absolute).root;
	const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean);
	for (let index = 0; index < parts.length; index++) {
		cursor = path.join(cursor, parts[index]!);
		const info = await lstat(cursor);
		if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : directory ? !info.isDirectory() : !info.isFile())) {
			throw new Error('PATH');
		}
		if (!samePath(await realpath(cursor), cursor)) throw new Error('PATH');
	}
	return absolute;
}

function identity(a: Stats, b: Stats): boolean {
	return (
		a.isFile() &&
		b.isFile() &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.birthtimeMs === b.birthtimeMs
	);
}

async function readStable(handle: FileHandle, filename: string): Promise<{ bytes: Buffer; info: Stats }> {
	const before = await handle.stat();
	const expectedSize = path.basename(filename) === 'VERSION' ? Buffer.byteLength(`${TECTONIC_VERSION}\n`) : TECTONIC_EXECUTABLE_SIZE;
	if (!before.isFile() || before.size !== expectedSize) throw new Error('SIZE');
	const bytes = Buffer.alloc(before.size);
	let offset = 0;
	while (offset < bytes.length) {
		const read = await handle.read(bytes, offset, bytes.length - offset, offset);
		if (!read.bytesRead) throw new Error('READ');
		offset += read.bytesRead;
	}
	if (!identity(before, await handle.stat()) || !identity(before, await lstat(filename))) throw new Error('CHANGED');
	return { bytes, info: before };
}

function controlledEnvironment(cache: string, executable: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	// No proxy, credential, TeX search-path, NODE_OPTIONS, or inherited cache overrides.
	for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
		const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
		if (key && process.env[key]) env[name] = process.env[key];
	}
	env.PATH = [path.dirname(executable), ...(env.SystemRoot ? [path.join(env.SystemRoot, 'System32')] : [])].join(path.delimiter);
	env.TECTONIC_CACHE_DIR = cache;
	return env;
}

async function probe(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		childProcess.execFile(
			executable,
			['--version'],
			{
				shell: false,
				windowsHide: true,
				timeout: 8000,
				maxBuffer: 4096,
				encoding: 'utf8',
				env
			},
			(error, stdout, stderr) => {
				if (error || stdout.trim() !== `Tectonic ${TECTONIC_VERSION}` || stderr.trim()) reject(new Error('VERSION'));
				else resolve();
			}
		);
	});
}

/**
 * Revalidate on every use. This is a prerequisite, NOT a compile consumer or atomic
 * executable lease: Node pathname spawn leaves a residual same-user TOCTOU window.
 */
export async function prepareTectonicRuntime(context: TectonicRuntimeContext): Promise<TectonicRuntimeResult> {
	const handles: FileHandle[] = [];
	try {
		if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('PLATFORM');
		const root = await canonicalRegular(context.isPackaged ? context.resourcesPath : context.appPath, true);
		const executable = await canonicalRegular(path.join(root, 'vendor', 'tectonic', 'windows-x64', 'tectonic.exe'), false);
		const versionFile = await canonicalRegular(path.join(root, 'vendor', 'tectonic', 'VERSION'), false);
		const userData = await canonicalRegular(context.userData, true);
		const cache = path.join(userData, 'tectonic-cache');
		try {
			await canonicalRegular(cache, true);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			await mkdir(cache); // no recursive creation through unchecked components
		}
		await canonicalRegular(cache, true);
		const executableHandle = await open(executable, 'r');
		handles.push(executableHandle);
		const versionHandle = await open(versionFile, 'r');
		handles.push(versionHandle);
		const before = await readStable(executableHandle, executable);
		const version = await readStable(versionHandle, versionFile);
		assertTectonicIntegrity(before.bytes, version.bytes);
		const env = controlledEnvironment(cache, executable);
		await canonicalRegular(executable, false);
		if (!identity(before.info, await lstat(executable))) throw new Error('CHANGED');
		await probe(executable, env);
		await canonicalRegular(executable, false);
		await canonicalRegular(versionFile, false);
		await canonicalRegular(cache, true);
		await canonicalRegular(userData, true);
		const after = await readStable(executableHandle, executable);
		const afterVersion = await readStable(versionHandle, versionFile);
		if (!identity(before.info, after.info) || !identity(version.info, afterVersion.info)) throw new Error('CHANGED');
		assertTectonicIntegrity(after.bytes, afterVersion.bytes);
		return { ok: true, executable, cache, version: TECTONIC_VERSION, env };
	} catch {
		return { ok: false, error: 'managed-engine-unavailable' };
	} finally {
		await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
	}
}
