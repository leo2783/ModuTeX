import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), prepare: vi.fn(), renameGate: vi.fn(), cleanupGate: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		rename: async (source: string, destination: string) => {
			await boundary.renameGate(source, destination);
			return actual.rename(source, destination);
		},
		rm: async (target: string, options: Parameters<typeof actual.rm>[1]) => {
			await boundary.cleanupGate(target);
			return actual.rm(target, options);
		}
	};
});
vi.mock('node:child_process', () => ({ spawn: boundary.spawn, execFile: boundary.execFile }));
vi.mock('../src/tectonic-runtime', () => ({ prepareTectonicRuntime: boundary.prepare }));
import { createManagedCompileService, sanitizeCompileLog, validateManagedCompileRequest } from '../src/managed-compile';

// These are deterministic OS-boundary tests, NOT real Tectonic/PDF/network evidence.
let root: string;
let current = vi.fn();
let authorize = vi.fn();
let children: EventEmitter[];
const request = { engine: 'tectonic', mainFile: 'main.tex' };
const pdf = '%PDF-1.7\nfixture bytes\n%%EOF\n';
beforeEach(async () => {
	vi.clearAllMocks();
	boundary.renameGate.mockReset();
	boundary.cleanupGate.mockReset();
	root = await realpath(await mkdtemp(path.join(tmpdir(), 'modutex-compile-test-')));
	await writeFile(path.join(root, 'main.tex'), 'test source');
	await mkdir(path.join(root, 'cache/formats'), { recursive: true });
	await writeFile(path.join(root, 'cache/formats', `${'a'.repeat(64)}-latex-33.fmt`), 'cached format');
	children = [];
	current = vi.fn();
	authorize = vi.fn(() => ({ root, assertCurrent: current }));
	boundary.prepare.mockResolvedValue({ ok: true, executable: 'fixed-engine.exe', cache: path.join(root, 'cache'), env: { FIXED: 'yes' } });
	boundary.execFile.mockImplementation((_exe, _args, _options, callback) => {
		for (const child of children) child.emit('close', 1);
		callback(null, '', '');
	});
	// Fake children have no OS process group. Model its close event without ever
	// sending a real signal to the fixture PID (including on Linux CI).
	vi.spyOn(process, 'kill').mockImplementation(() => {
		for (const child of children) child.emit('close', 1);
		return true;
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await rm(root, { recursive: true, force: true });
});
const service = () =>
	createManagedCompileService({ runtime: { isPackaged: true, resourcesPath: root, appPath: root, userData: root }, authorize });

function engine(code = 0, output = '', held = false, diskLog?: string) {
	boundary.spawn.mockImplementation((_exe, args: string[]) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			pid: 1234,
			exitCode: null,
			signalCode: null,
			kill: vi.fn()
		});
		children.push(child);
		if (!held)
			void (async () => {
				await Promise.resolve(); // real child events arrive after spawn returns
				const stage = args[args.indexOf('--outdir') + 1];
				if (diskLog !== undefined) await writeFile(path.join(stage, 'main.log'), diskLog);
				if (!code) {
					await writeFile(path.join(stage, 'main.pdf'), pdf);
					await writeFile(path.join(stage, 'main.synctex.gz'), 'synctex');
				}
				child.stdout.write(output);
				child.emit('close', code);
			})();
		return child;
	});
}

describe('managed compile boundary', () => {
	it('holds a transferred root while a real backup rollback rename is pending', async () => {
		engine();
		await mkdir(path.join(root, 'output'));
		await writeFile(path.join(root, 'output/main.log'), 'PREVIOUS LOG');
		let stale = false;
		current.mockImplementation(() => {
			if (stale) throw new Error('STALE_WORKSPACE');
		});
		let release!: () => void;
		let rollbackEntered = false;
		boundary.renameGate.mockImplementation(async (source: string) => {
			if (source.endsWith(`${path.sep}main.log`)) stale = true;
			if (!path.basename(source).startsWith('backup-')) return;
			rollbackEntered = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const compile = service();
		const pending = compile.run({}, 1, request);
		try {
			await vi.waitFor(() => expect(rollbackEntered).toBe(true));
			authorize.mockReturnValue({ root, assertCurrent: vi.fn() });
			expect(await compile.run({}, 2, request)).toMatchObject({ ok: false, error: 'BUSY' });
		} finally {
			release?.();
		}
		expect(await pending).toMatchObject({ ok: false, error: 'STALE_WORKSPACE' });
		expect(await readFile(path.join(root, 'output/main.log'), 'utf8')).toBe('PREVIOUS LOG');
		boundary.renameGate.mockReset();
		expect(await compile.run({}, 2, request)).toMatchObject({ ok: true });
	});
	it.each(['rename', 'cleanup'])('holds the canonical root across owners until pending %s drains', async (phase) => {
		// Real temp files and real publication/rollback; only the selected filesystem
		// await is held. Host authorization is a contract fixture, not an IPC exploit proof.
		engine();
		let release!: () => void;
		let entered = false;
		const gate = phase === 'rename' ? boundary.renameGate : boundary.cleanupGate;
		gate.mockImplementation(async (target: string) => {
			const matches = phase === 'rename' ? target.endsWith(`${path.sep}main.log`) : path.basename(target).startsWith('.modutex-compile-');
			if (entered || !matches) return;
			entered = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const compile = service();
		const pending = compile.run({}, 1, request);
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			compile.cancelOwner(1);
			// Windows case aliases must share the reservation even after root transfer.
			authorize.mockReturnValue({ root: process.platform === 'win32' ? root.toUpperCase() : root, assertCurrent: vi.fn() });
			expect(await compile.run({}, 2, request)).toMatchObject({ ok: false, error: 'BUSY' });
			const otherRoot = path.join(root, 'independent');
			await mkdir(otherRoot);
			await writeFile(path.join(otherRoot, 'main.tex'), 'independent');
			authorize.mockReturnValue({ root: otherRoot, assertCurrent: vi.fn() });
			expect(await compile.run({}, 3, request)).toMatchObject({ ok: true });
		} finally {
			release?.();
		}
		const result = await pending;
		expect(result).toMatchObject(phase === 'rename' ? { ok: false, error: 'CANCELLED' } : { ok: true });
		authorize.mockReturnValue({ root, assertCurrent: vi.fn() });
		expect(await compile.run({}, 2, request)).toMatchObject({ ok: true });
	});
	it('terminates an active engine on workspace transfer without retry or publication', async () => {
		engine(0, '', true);
		await mkdir(path.join(root, 'output'));
		await writeFile(path.join(root, 'output/main.pdf'), 'OLD');
		const compile = service();
		const pending = compile.run({}, 1, request);
		await vi.waitFor(() => expect(boundary.spawn).toHaveBeenCalledOnce());
		current.mockImplementation(() => {
			throw new Error('STALE_WORKSPACE');
		});
		compile.cancelOwner(1);
		expect(await pending).toMatchObject({ ok: false, error: 'CANCELLED' });
		expect(await readFile(path.join(root, 'output/main.pdf'), 'utf8')).toBe('OLD');
		expect(boundary.spawn).toHaveBeenCalledTimes(1);
	});
	it.each(['../main.tex', 'a/../main.tex', 'C:/main.tex', '//server/main.tex', 'a:main.tex', 'main.tex ', 'main.typ', 'a//main.tex'])(
		'rejects path %s before preparing an engine',
		async (mainFile) => {
			expect(await service().run({}, 1, { ...request, mainFile })).toMatchObject({ ok: false, error: 'INVALID_PATH' });
			expect(boundary.prepare).not.toHaveBeenCalled();
		}
	);
	it.each(['root', 'output', 'executable', 'cache', 'env', 'allowNetwork', 'flags'])('rejects renderer override %s', (key) => {
		expect(() => validateManagedCompileRequest({ ...request, [key]: 'unsafe' })).toThrow('INVALID_REQUEST');
	});
	it('rejects untrusted owners before filesystem or spawn', async () => {
		authorize.mockImplementation(() => {
			throw new Error('UNTRUSTED_SENDER');
		});
		expect(await service().run({}, 1, request)).toMatchObject({ ok: false, error: 'UNTRUSTED_SENDER' });
		expect(boundary.spawn).not.toHaveBeenCalled();
	});
	it('publishes successful artifacts from a single fixed no-shell automatic-download invocation', async () => {
		engine();
		expect(await service().run({}, 1, request)).toMatchObject({ ok: true, pdfPath: path.join(root, 'output/main.pdf') });
		expect(await readFile(path.join(root, 'output/main.pdf'), 'utf8')).toBe(pdf);
		const [exe, args, options] = boundary.spawn.mock.calls[0];
		expect(exe).toBe('fixed-engine.exe');
		const stage = args[args.indexOf('--outdir') + 1];
		expect(args).toEqual([
			'-X',
			'compile',
			'--untrusted',
			'--keep-logs',
			'--synctex',
			'--bundle',
			'https://relay.fullyjustified.net/default_bundle_v33.tar',
			'--outdir',
			stage,
			'--',
			path.join(root, 'main.tex')
		]);
		expect(path.dirname(stage)).toBe(path.join(root, 'output'));
		expect(options).toMatchObject({ shell: false, cwd: root, env: { FIXED: 'yes' } });
		expect(boundary.spawn).toHaveBeenCalledOnce();
	});
	it('keeps a prior PDF on compilation failure and never silently falls back', async () => {
		await mkdir(path.join(root, 'output'));
		await writeFile(path.join(root, 'output/main.pdf'), 'OLD');
		engine(1, 'TeX syntax error');
		expect(await service().run({}, 1, request)).toMatchObject({ ok: false, error: 'COMPILE_FAILED' });
		expect(await readFile(path.join(root, 'output/main.pdf'), 'utf8')).toBe('OLD');
		expect(boundary.spawn).toHaveBeenCalledTimes(1);
	});
	it.each([
		'resource not cached',
		'error: failed to open input file "tectonic-format-latex.tex"',
		'error: failed to open input file "loadhyph-ru.tex"',
		"error: ! LaTeX Error: File `tikz.sty' not found.",
		'error: failed to open input file "chapter.tex"',
		'error: main.tex:3: Undefined control sequence'
	])('returns a native failure once without retrying or duplicating stdout: %s', async (diagnostic) => {
		engine(1, diagnostic);
		expect(await service().run({}, 1, request)).toEqual({ ok: false, error: 'COMPILE_FAILED', stdout: diagnostic });
		expect(boundary.spawn).toHaveBeenCalledOnce();
		expect(boundary.spawn.mock.calls[0][1]).not.toContain('--only-cached');
	});
	it('retains a distinct on-disk TeX log alongside process diagnostics', async () => {
		engine(1, 'process diagnostic', false, 'TeX diagnostic');
		expect(await service().run({}, 1, request)).toMatchObject({ stdout: 'process diagnostic\nTeX diagnostic' });
	});
	it('does not duplicate an on-disk log identical to process diagnostics', async () => {
		engine(1, 'same diagnostic', false, 'same diagnostic');
		expect(await service().run({}, 1, request)).toMatchObject({ stdout: 'same diagnostic' });
	});
	it('publishes stdout as the log when no disk log exists', async () => {
		engine(0, 'compiled');
		expect(await service().run({}, 1, request)).toMatchObject({ ok: true, stdout: 'compiled' });
		expect(await readFile(path.join(root, 'output/main.log'), 'utf8')).toBe('compiled');
	});
	it('fences stale workspace before starting a process', async () => {
		current.mockImplementation(() => {
			throw new Error('STALE_WORKSPACE');
		});
		expect(await service().run({}, 1, request)).toMatchObject({ ok: false, error: 'STALE_WORKSPACE' });
		expect(boundary.spawn).not.toHaveBeenCalled();
	});
	it('rejects a linked parent of the requested main file', async () => {
		await mkdir(path.join(root, 'real'));
		await writeFile(path.join(root, 'real/main.tex'), 'source');
		await symlink(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		expect(await service().run({}, 1, { ...request, mainFile: 'linked/main.tex' })).toMatchObject({ ok: false, error: 'INVALID_PATH' });
		expect(boundary.spawn).not.toHaveBeenCalled();
	});
	it('rejects an invalid PDF without replacing an existing PDF', async () => {
		engine();
		await mkdir(path.join(root, 'output'));
		await writeFile(path.join(root, 'output/main.pdf'), 'OLD');
		const spawn = boundary.spawn.getMockImplementation()!;
		boundary.spawn.mockImplementation((...args) => {
			const child = spawn(...args);
			const emit = child.emit.bind(child);
			child.emit = (event: string, ...values: unknown[]) => {
				if (event === 'close')
					void writeFile(path.join(args[1][args[1].indexOf('--outdir') + 1], 'main.pdf'), 'not a pdf').then(() => emit(event, ...values));
				else emit(event, ...values);
				return true;
			};
			return child;
		});
		expect(await service().run({}, 1, request)).toMatchObject({ ok: false, error: 'INVALID_PDF' });
		expect(await readFile(path.join(root, 'output/main.pdf'), 'utf8')).toBe('OLD');
	});
	it.each(['win32', 'linux'] as const)(
		'enforces the production 120 second timeout and terminates the %s process tree',
		async (platform) => {
			vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
			engine(0, '', true);
			let timeout!: () => void;
			const original = globalThis.setTimeout;
			vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, milliseconds: number, ...args: unknown[]) => {
				if (milliseconds === 120000) timeout = callback;
				return original(callback, milliseconds, ...args);
			}) as typeof setTimeout);
			const pending = service().run({}, 1, request);
			await vi.waitFor(() => expect(boundary.spawn).toHaveBeenCalledOnce());
			timeout();
			expect(await pending).toMatchObject({ ok: false, error: 'TIMEOUT' });
			if (platform === 'win32') {
				expect(boundary.execFile).toHaveBeenCalledOnce();
				expect(process.kill).not.toHaveBeenCalled();
			} else {
				expect(process.kill).toHaveBeenCalledExactlyOnceWith(-1234, 'SIGKILL');
				expect(boundary.execFile).not.toHaveBeenCalled();
			}
		}
	);
	it('bounds first-format setup to five minutes and preserves diagnostics on timeout', async () => {
		await rm(path.join(root, 'cache/formats'), { recursive: true });
		engine(0, '', true);
		let deadline!: () => void;
		let budget = 0;
		const original = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, milliseconds: number, ...args: unknown[]) => {
			if (milliseconds > 120000 && milliseconds <= 300000) {
				deadline = callback;
				budget = milliseconds;
			}
			return original(callback, milliseconds, ...args);
		}) as typeof setTimeout);
		const pending = service().run({}, 1, request);
		await vi.waitFor(() => expect(boundary.spawn).toHaveBeenCalledOnce());
		(children[0] as EventEmitter & { stderr: PassThrough }).stderr.write('note: downloading resource\n');
		expect(budget).toBeGreaterThan(120000);
		expect(budget).toBeLessThanOrEqual(300000);
		deadline();
		expect(await pending).toEqual({ ok: false, error: 'TIMEOUT', stdout: 'note: downloading resource\n' });
		expect(boundary.spawn).toHaveBeenCalledOnce();
	});
	it('rejects a linked format cache before starting the engine', async () => {
		await rm(path.join(root, 'cache/formats'), { recursive: true });
		await mkdir(path.join(root, 'real-formats'));
		await symlink(path.join(root, 'real-formats'), path.join(root, 'cache/formats'), process.platform === 'win32' ? 'junction' : 'dir');
		expect(await service().run({}, 1, request)).toMatchObject({ ok: false, error: 'INVALID_PATH' });
		expect(boundary.spawn).not.toHaveBeenCalled();
	});
	it.each(['win32', 'linux'] as const)('refuses overlapping requests and stops only the authenticated sender on %s', async (platform) => {
		vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
		engine(0, '', true);
		const compile = service();
		const pending = compile.run({}, 1, request);
		await vi.waitFor(() => expect(boundary.spawn).toHaveBeenCalledTimes(1));
		expect(await compile.run({}, 1, request)).toMatchObject({ ok: false, error: 'BUSY' });
		compile.cancel({}, 2);
		expect(boundary.execFile).not.toHaveBeenCalled();
		expect(process.kill).not.toHaveBeenCalled();
		compile.cancel({}, 1);
		expect(await pending).toMatchObject({ ok: false, error: 'CANCELLED' });
		if (platform === 'win32') {
			expect(boundary.execFile.mock.calls[0][1]).toEqual(['/PID', '1234', '/T', '/F']);
			expect(process.kill).not.toHaveBeenCalled();
		} else {
			expect(process.kill).toHaveBeenCalledExactlyOnceWith(-1234, 'SIGKILL');
			expect(boundary.execFile).not.toHaveBeenCalled();
		}
	});
	it('bounds and strips terminal control sequences from logs', () => {
		expect(sanitizeCompileLog('\x1b[31mred\x00\x07\n')).toBe('red\n');
		expect(sanitizeCompileLog('x'.repeat(300000))).toHaveLength(256 * 1024);
	});
});
