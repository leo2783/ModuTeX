// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ManagedCompileResult } from 'modutex-contracts';
const h = vi.hoisted(() => ({ files: {} as Record<string, string>, notices: vi.fn() }));
vi.mock('$lib/latex-log/parseInWorker', () => ({ parseCompileDiagnosticsInWorker: async () => ({ diagnostics: [], raw: '' }) }));
vi.mock('$lib/modals/toaster-svelte', () => ({ toaster: { info: h.notices, error: h.notices, warning: h.notices } }));
vi.mock('$lib/workspace/fileSystem', () => ({
	readTextFile: async (p: string) => h.files[p],
	writeTextFile: async (p: string, text: string) => {
		h.files[p] = text;
	},
	statFile: async (p: string) => ({ exists: p in h.files }),
	joinPath: (a: string, b: string) => `${a}/${b}`,
	basename: (p: string) => p.split('/').pop()!,
	createEntry: async () => {},
	readDir: async () => []
}));
vi.mock('$lib/workspace/texpileDir', () => ({ ensureTexpileIgnore: async () => {} }));
vi.mock('$lib/settings', async () => {
	const { writable } = await import('svelte/store');
	const defaults = { compileEngine: 'tectonic', compileCommand: 'latexmk {main}', draftMode: false, typstLiveMode: false };
	const settings = writable(defaults);
	return {
		settings,
		DEFAULT_COMPILE_COMMAND: defaults.compileCommand,
		loadSettings: async () => {},
		updateSettings: (p: object) => settings.update((s) => ({ ...s, ...p }))
	};
});
import { CompilePipeline, type CompileDeps } from '$lib/workspace/compilePipeline.svelte';
import { CompileSettings } from '$lib/workspace/compileSettings.svelte';
import { ProjectConfigSync } from '$lib/workspace/projectConfigSync.svelte';
import {
	workspaceRoot,
	mainFile,
	texFiles,
	savedFormatCommand,
	savedFormatOutputs,
	savedLatexEngine,
	setFormatCommand,
	setFormatOutputs,
	setLatexEngine
} from '$lib/workspace/workspaceStore';
import { pdfStore } from '$lib/stores/pdfStore';
import { settings } from '$lib/settings';

let root: string;
let counter = 0;
beforeEach(() => {
	root = `/managed-test-${++counter}`;
	workspaceRoot.set(root);
	mainFile.set(`${root}/main.tex`);
	texFiles.set([]);
	pdfStore.set(null);
	h.files = {};
	h.notices.mockClear();
	settings.update((s) => ({ ...s, compileEngine: 'tectonic', draftMode: false, typstLiveMode: false }));
});
function pipeline(over: Partial<CompileDeps> = {}) {
	const shell = vi.fn();
	const deps: CompileDeps = {
		getLoadedPath: () => `${root}/main.tex`,
		getCompileCommand: () => 'latexmk {main}',
		terminalAvailable: () => false,
		mainConfirmed: () => true,
		commandPending: () => false,
		getDock: () => ({ runCommand: shell, interrupt: vi.fn() }),
		stat: async () => ({ exists: true, mtimeMs: 7, size: 100 }),
		readText: async () => '',
		create: async () => {},
		fileUrl: (p) => `app://file?path=${p}`,
		flushSaves: vi.fn(async () => {}),
		refreshTree: async () => {},
		showTerminal: vi.fn(),
		setDockView: vi.fn(),
		setPdfPaneOpen: vi.fn(),
		openCompileModal: vi.fn(),
		openMainConfirm: vi.fn(),
		runDraftCompile: vi.fn(async () => {}),
		openTypstPreview: vi.fn(),
		runManagedCompile: vi.fn(async (): Promise<ManagedCompileResult> => ({
			ok: true,
			engine: 'tectonic',
			pdfPath: `${root}/output/main.pdf`,
			logPath: `${root}/output/main.log`,
			stdout: ''
		})),
		cancelManagedCompile: vi.fn(async () => {}),
		...over
	};
	return { compiler: new CompilePipeline(deps), deps, shell };
}
describe('production managed compile consumer', () => {
	it('flushes saves and dispatches native compile without a terminal, then opens the published PDF', async () => {
		const { compiler, deps, shell } = pipeline();
		await compiler.runCompile();
		expect(deps.flushSaves).toHaveBeenCalledOnce();
		expect(deps.runManagedCompile).toHaveBeenCalledWith({ engine: 'tectonic', mainFile: 'main.tex' });
		expect(get(pdfStore)).toContain('/output/main.pdf');
		expect(deps.setPdfPaneOpen).toHaveBeenCalledWith(true);
		expect(shell).not.toHaveBeenCalled();
		expect(compiler.busy).toBe(false);
	});
	it('explicit managed selection preserves and ignores a pending system command', async () => {
		setFormatCommand(root, 'latex', 'custom-untrusted-command');
		setLatexEngine(root, 'tectonic');
		const { compiler, deps, shell } = pipeline({ commandPending: () => true });
		await compiler.runCompile();
		expect(deps.runManagedCompile).toHaveBeenCalledOnce();
		expect(shell).not.toHaveBeenCalled();
		expect(savedFormatCommand(root, 'latex')).toBe('custom-untrusted-command');
	});
	it('legacy custom command stays in the system trust gate', async () => {
		setFormatCommand(root, 'latex', 'custom-command');
		const { compiler, deps, shell } = pipeline({ commandPending: () => true });
		await compiler.runCompile();
		expect(deps.runManagedCompile).not.toHaveBeenCalled();
		expect(shell).not.toHaveBeenCalled();
		expect(savedLatexEngine(root)).toBe('system');
	});
	it('native failure does not launch a system fallback or replace the previous displayed PDF', async () => {
		pdfStore.set('previous');
		const { compiler, shell } = pipeline({ runManagedCompile: async () => ({ ok: false, error: 'COMPILE_FAILED', stdout: 'syntax' }) });
		await compiler.runCompile();
		expect(get(pdfStore)).toBe('previous');
		expect(shell).not.toHaveBeenCalled();
	});
	it('Stop cancels the native owner, keeps overlap protection until response, and ignores late success', async () => {
		let finish!: (value: ManagedCompileResult) => void;
		const { compiler, deps } = pipeline({
			runManagedCompile: vi.fn(
				() =>
					new Promise<ManagedCompileResult>((resolve) => {
						finish = resolve;
					})
			)
		});
		const run = compiler.runCompile();
		await vi.waitFor(() => expect(deps.runManagedCompile).toHaveBeenCalledOnce());
		compiler.stopCompile();
		expect(deps.cancelManagedCompile).toHaveBeenCalledOnce();
		expect(compiler.busy).toBe(true);
		await compiler.runCompile();
		expect(deps.runManagedCompile).toHaveBeenCalledOnce();
		finish({ ok: true, engine: 'tectonic', pdfPath: 'late.pdf', logPath: '', stdout: '' });
		await run;
		expect(get(pdfStore)).toBe(null);
		expect(compiler.busy).toBe(false);
	});
});
describe('engine persistence without command loss', () => {
	it('Cancel is draft-only; Save managed preserves custom command and output overrides', () => {
		setFormatCommand(root, 'latex', 'custom {main}');
		setFormatOutputs(root, 'latex', { pdf: 'build/custom.pdf' });
		const dialog = new CompileSettings(() => '', vi.fn(), vi.fn());
		dialog.open();
		expect(dialog.engine).toBe('system');
		dialog.engine = 'tectonic';
		dialog.modalOpen = false;
		expect(savedLatexEngine(root)).toBe('system');
		dialog.open();
		expect(dialog.engine).toBe('system');
		dialog.engine = 'tectonic';
		dialog.save(false);
		dialog.open();
		expect(dialog.engine).toBe('tectonic');
		expect(savedFormatCommand(root, 'latex')).toBe('custom {main}');
		expect(savedFormatOutputs(root, 'latex').pdf).toBe('build/custom.pdf');
	});
	it('project serialization and re-adoption retain engine, custom command, outputs and unrelated keys', async () => {
		const configPath = `${root}/.texpile/config.json`;
		h.files[configPath] = JSON.stringify({
			v: 1,
			custom: 'keep',
			latex: { command: 'project-custom', outputs: { pdf: 'out/custom.pdf' }, extra: 'keep', engine: 'tectonic' }
		});
		const sync = new ProjectConfigSync();
		await sync.adopt(root);
		await sync.save(root);
		const cfg = JSON.parse(h.files[configPath]);
		expect(cfg).toMatchObject({
			custom: 'keep',
			latex: { engine: 'tectonic', command: 'project-custom', outputs: { pdf: 'out/custom.pdf' }, extra: 'keep' }
		});
		setLatexEngine(root, 'system');
		await sync.adopt(root);
		expect(savedLatexEngine(root)).toBe('tectonic');
	});
});
