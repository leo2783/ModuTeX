import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, mkdir, mkdtemp, open, rename, copyFile, rm, writeFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { ManagedCompileRequest, ManagedCompileResult, ManagedCompileError } from 'modutex-contracts';
import { prepareTectonicRuntime, type TectonicRuntimeContext } from './tectonic-runtime';

const LOG_LIMIT = 256 * 1024;
const PDF_LIMIT = 64 * 1024 * 1024;
export const MANAGED_COMPILE_TIMEOUT_MS = 120_000;
export const MANAGED_FORMAT_SETUP_TIMEOUT_MS = 300_000;

export interface ManagedCompileOwner {
	root: string;
	assertCurrent(): void;
}
export interface ManagedCompileHost {
	runtime: TectonicRuntimeContext;
	authorize(event: unknown): ManagedCompileOwner;
}
interface Operation {
	/** Main's already-canonical claim, normalized for cross-owner exclusion. */
	root: string;
	controller: AbortController;
	child?: ChildProcess;
	timedOut: boolean;
	output: string;
}
class CompileError extends Error {
	constructor(readonly code: ManagedCompileError) {
		super(code);
	}
}

const normalizedRoot = (root: string) => {
	const absolute = path.resolve(root);
	return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

export function validateManagedCompileRequest(value: unknown): ManagedCompileRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompileError('INVALID_REQUEST');
	const object = value as Record<string, unknown>;
	if (Object.keys(object).sort().join(',') !== 'engine,mainFile' || object.engine !== 'tectonic' || typeof object.mainFile !== 'string')
		throw new CompileError('INVALID_REQUEST');
	const file = object.mainFile;
	if (
		!file ||
		file.length > 4096 ||
		path.isAbsolute(file) ||
		path.win32.isAbsolute(file) ||
		/[:\x00-\x1f]/.test(file) ||
		file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
		!/\.tex$/i.test(file)
	)
		throw new CompileError('INVALID_PATH');
	return { engine: 'tectonic', mainFile: file };
}

/** Check every component: a linked parent is as dangerous as a linked final file. */
export async function checkedCompilePath(target: string, directory: boolean): Promise<string> {
	const absolute = path.resolve(target);
	let cursor = path.parse(absolute).root;
	for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, part);
		const info = await lstat(cursor);
		if (info.isSymbolicLink() || (cursor === absolute ? (directory ? !info.isDirectory() : !info.isFile()) : !info.isDirectory()))
			throw new CompileError('INVALID_PATH');
		const actual = await realpath(cursor);
		if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !== (process.platform === 'win32' ? cursor.toLowerCase() : cursor))
			throw new CompileError('INVALID_PATH');
	}
	return absolute;
}

export function sanitizeCompileLog(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
		.slice(-LOG_LIMIT);
}

async function terminate(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode != null || child.signalCode != null) return;
	if (process.platform === 'win32') {
		await new Promise<void>((resolve) =>
			execFile(
				path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
				['/PID', String(child.pid), '/T', '/F'],
				{ shell: false, windowsHide: true, timeout: 5000 },
				() => resolve()
			)
		);
	} else {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	}
}

function runEngine(
	executable: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	op: Operation
): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		if (op.controller.signal.aborted) return reject(new CompileError(op.timedOut ? 'TIMEOUT' : 'CANCELLED'));
		const child = spawn(executable, args, {
			cwd,
			env,
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe']
		});
		op.child = child;
		const append = (chunk: Buffer) => {
			op.output = (op.output + chunk.toString('utf8')).slice(-LOG_LIMIT);
		};
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		const abort = () => {
			void terminate(child);
		};
		op.controller.signal.addEventListener('abort', abort, { once: true });
		child.once('error', () => {
			op.controller.signal.removeEventListener('abort', abort);
			reject(new CompileError('ENGINE_UNAVAILABLE'));
		});
		child.once('close', (code) => {
			op.controller.signal.removeEventListener('abort', abort);
			op.child = undefined;
			if (op.controller.signal.aborted) reject(new CompileError(op.timedOut ? 'TIMEOUT' : 'CANCELLED'));
			else resolve({ code: code ?? -1, output: sanitizeCompileLog(op.output) });
		});
		if (op.controller.signal.aborted) abort();
	});
}

async function boundedLog(filename: string): Promise<string> {
	let handle;
	try {
		await checkedCompilePath(filename, false);
		handle = await open(filename, 'r');
		const size = (await handle.stat()).size;
		const bytes = Buffer.alloc(Math.min(size, LOG_LIMIT));
		await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
		return sanitizeCompileLog(bytes.toString('utf8'));
	} catch {
		return '';
	} finally {
		await handle?.close();
	}
}

async function validatePdf(filename: string): Promise<void> {
	await checkedCompilePath(filename, false);
	const handle = await open(filename, 'r');
	try {
		const size = (await handle.stat()).size;
		if (size < 16 || size > PDF_LIMIT) throw new CompileError('INVALID_PDF');
		const head = Buffer.alloc(5),
			tail = Buffer.alloc(Math.min(size, 2048));
		await handle.read(head, 0, head.length, 0);
		await handle.read(tail, 0, tail.length, size - tail.length);
		if (head.toString('ascii') !== '%PDF-' || !tail.includes(Buffer.from('%%EOF'))) throw new CompileError('INVALID_PDF');
	} finally {
		await handle.close();
	}
}

async function checkedDirectory(parent: string, name: string): Promise<string> {
	await checkedCompilePath(parent, true);
	const target = path.join(parent, name);
	try {
		await mkdir(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	return checkedCompilePath(target, true);
}

/** Only the main-owned cache can select the bounded first-format setup budget. */
async function hasCachedLatexFormat(cache: string): Promise<boolean> {
	const directory = path.join(cache, 'formats');
	try {
		await checkedCompilePath(directory, true);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
	for (const filename of await readdir(directory)) {
		// Tectonic 0.17 uses bundle digest + format name + engine format serial 33.
		if (!/^[a-f0-9]{64}-latex-33\.fmt$/.test(filename)) continue;
		const target = await checkedCompilePath(path.join(directory, filename), false);
		if ((await lstat(target)).size > 0) return true;
	}
	return false;
}

/** One owner-bound run, no executable/cache/output/flags crossing the renderer boundary. */
export function createManagedCompileService(host: ManagedCompileHost) {
	const operations = new Map<number, Operation>();
	const cancelOwner = (senderId: number) => {
		operations.get(senderId)?.controller.abort();
	};
	const run = async (event: unknown, senderId: number, payload: unknown): Promise<ManagedCompileResult> => {
		let stage: string | undefined;
		let output = '';
		let timer: ReturnType<typeof setTimeout> | undefined;
		let operation: Operation | undefined;
		try {
			const request = validateManagedCompileRequest(payload);
			const owner = host.authorize(event);
			if (operations.has(senderId)) throw new CompileError('BUSY');
			owner.assertCurrent();
			const claimedRoot = normalizedRoot(owner.root);
			if ([...operations.values()].some((active) => active.root === claimedRoot)) throw new CompileError('BUSY');
			// Reserve before the first await: release/claim can transfer a root while
			// this owner's publication or rollback still has filesystem work pending.
			operation = { root: claimedRoot, controller: new AbortController(), timedOut: false, output: '' };
			operations.set(senderId, operation);
			const op = operation;
			const started = Date.now();
			const abortTimedOut = () => {
				op.timedOut = true;
				op.controller.abort();
			};
			timer = setTimeout(abortTimedOut, MANAGED_COMPILE_TIMEOUT_MS);
			const current = () => {
				owner.assertCurrent();
				if (op.controller.signal.aborted) throw new CompileError(op.timedOut ? 'TIMEOUT' : 'CANCELLED');
			};
			const root = await checkedCompilePath(owner.root, true);
			current();
			if (normalizedRoot(root) !== op.root) throw new CompileError('INVALID_PATH');
			const main = await checkedCompilePath(path.join(root, request.mainFile), false);
			if (!path.relative(root, main) || path.relative(root, main).startsWith('..') || path.isAbsolute(path.relative(root, main)))
				throw new CompileError('INVALID_PATH');
			current();
			const runtime = await prepareTectonicRuntime(host.runtime);
			current();
			if (!runtime.ok) throw new CompileError('ENGINE_UNAVAILABLE');
			if (!(await hasCachedLatexFormat(runtime.cache))) {
				current();
				// Cold format generation downloads hundreds of support files before TeX
				// can compile a document. Keep a separate finite five-minute setup budget;
				// warm-cache document builds retain the original two-minute deadline.
				clearTimeout(timer);
				timer = setTimeout(abortTimedOut, Math.max(0, MANAGED_FORMAT_SETUP_TIMEOUT_MS - (Date.now() - started)));
			}
			current();
			const outdir = await checkedDirectory(root, 'output');
			stage = await mkdtemp(path.join(outdir, '.modutex-compile-'));
			await checkedCompilePath(stage, true);
			const stem = path.basename(main, path.extname(main));
			// Tectonic reuses its persistent cache and fetches missing resources from this
			// fixed official bundle. No config file or renderer can choose the source.
			const bundle = 'https://relay.fullyjustified.net/default_bundle_v33.tar';
			const args = ['-X', 'compile', '--untrusted', '--keep-logs', '--synctex', '--bundle', bundle, '--outdir', stage, '--', main];
			current();
			const result = await runEngine(runtime.executable, args, root, runtime.env, op);
			output = result.output;
			current();
			const diskLog = await boundedLog(path.join(stage, `${stem}.log`));
			const log = diskLog || output;
			if (diskLog && diskLog !== output) output = sanitizeCompileLog(`${output}\n${diskLog}`);
			current();
			if (result.code !== 0) throw new CompileError('COMPILE_FAILED');
			await validatePdf(path.join(stage, `${stem}.pdf`));
			current();
			const files = [`${stem}.log`, `${stem}.synctex.gz`, `${stem}.pdf`];
			await writeFile(path.join(stage, `${stem}.log`), log, 'utf8');
			const published: { destination: string; backup?: string }[] = [];
			try {
				for (const filename of files) {
					current();
					await checkedCompilePath(outdir, true);
					const source = path.join(stage, filename),
						destination = path.join(outdir, filename);
					await checkedCompilePath(source, false);
					let backup: string | undefined;
					try {
						await checkedCompilePath(destination, false);
						backup = path.join(stage, `backup-${randomUUID()}`);
						await copyFile(destination, backup);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					}
					current();
					await rename(source, destination);
					published.push({ destination, backup });
				}
				current();
			} catch (error) {
				for (const entry of published.reverse()) {
					await checkedCompilePath(outdir, true);
					await checkedCompilePath(stage, true);
					if (entry.backup) await rename(entry.backup, entry.destination);
					else await rm(entry.destination);
				}
				throw error;
			}
			return {
				ok: true,
				engine: 'tectonic',
				pdfPath: path.join(outdir, `${stem}.pdf`),
				logPath: path.join(outdir, `${stem}.log`),
				stdout: output
			};
		} catch (error) {
			const code =
				error instanceof CompileError
					? error.code
					: error instanceof Error && error.message === 'UNTRUSTED_SENDER'
						? 'UNTRUSTED_SENDER'
						: error instanceof Error && error.message === 'STALE_WORKSPACE'
							? 'STALE_WORKSPACE'
							: 'PUBLICATION_FAILED';
			return { ok: false, error: code, stdout: sanitizeCompileLog(output || operation?.output || '') };
		} finally {
			clearTimeout(timer);
			if (operation?.child) await terminate(operation.child);
			if (stage) {
				// Re-check before recursive cleanup; never follow a replaced staging directory.
				try {
					await checkedCompilePath(stage, true);
					await rm(stage, { recursive: true, force: true });
				} catch {
					/* keep unsafe cleanup targets untouched */
				}
			}
			if (operations.get(senderId) === operation) operations.delete(senderId);
		}
	};
	return {
		run,
		cancelOwner,
		cancel(event: unknown, senderId: number) {
			host.authorize(event);
			cancelOwner(senderId);
		},
		close() {
			for (const op of operations.values()) op.controller.abort();
		}
	};
}
