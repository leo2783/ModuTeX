// compile / terminal / PDF-watch orchestration: resolve the command, run it in the terminal dock,
// poll the log + PDF until the run settles, publish parsed diagnostics and the fresh PDF.
// WorkspaceView wires the deps.
import { get } from 'svelte/store';
import { compileLog } from '$lib/stores/compileLogStore';
import { parseCompileDiagnosticsInWorker } from '$lib/latex-log/parseInWorker';
import { pdfStore } from '$lib/stores/pdfStore';
import { projectIntelStore } from '$lib/stores/projectIntel';
import { settings, loadSettings, DEFAULT_COMPILE_COMMAND } from '$lib/settings';
import {
	workspaceRoot,
	mainFile,
	texFiles,
	effectiveCompileFormat,
	savedFormatCommand,
	savedLatexEngine,
	savedFormatOutputs,
	savedMainFile
} from './workspaceStore';
import * as cc from './compileCommand';
import { buildTypstCommand, isTypstCommand } from './typstCommand';
import { basename, joinPath } from './fileSystem';
import { toaster } from '$lib/modals/toaster-svelte';
import { leadingProgram, shellSaidNotFound } from './toolMissing';
import { openToolchainPrefs } from '$lib/stores/dialogStore';
import { m } from '$lib/paraglide/messages';
import type { ManagedCompileRequest, ManagedCompileResult } from 'modutex-contracts';

// a root-relative, forward-slashed path (the form file references take in LaTeX)
export const relFromRoot = (p: string, root: string) =>
	p
		.slice(root.length)
		.replace(/^[\\/]+/, '')
		.replace(/\\/g, '/');

/**
 * The command this folder compiles with. The folder's EXPLICIT format switch decides the lane
 * (latex or typst; Auto reads the main file's extension), and each lane resolves independently:
 * its own saved command first, else that lane's default. No format is ever inferred from a
 * command string - the switch is stored state (workspaceStore.CompileFormat).
 */
export const resolveFormatCommand = (root: string | null, format: 'latex' | 'typst', global: string, main?: string | null) => {
	const saved = root ? savedFormatCommand(root, format) : null;
	if (saved) return saved;
	if (format === 'typst') return buildTypstCommand(main ?? null);
	// the latex lane's default is the global setting - unless a Typst line got saved there by an
	// old version, in which case the stock LaTeX command is the sane floor
	if (global && isTypstCommand(global)) return DEFAULT_COMPILE_COMMAND;
	return global || '';
};

export const resolveCompileCommand = (root: string | null, global: string, main?: string | null) => {
	return resolveFormatCommand(root, effectiveCompileFormat(root, main ?? null), global, main);
};

// a TeX engine at its default errorstop interaction parks at the interactive ? prompt on the
// first error. for known engine commands, inject -interaction=nonstopmode (plus -file-line-error
// for exact error attribution); custom scripts/makefiles are left untouched.
function withBatchFlags(cmd: string): string {
	const hit = cmd.match(/^(\s*(?:latexmk|pdflatex|xelatex|lualatex)(?:\.exe)?)(?=\s|$)/i);
	if (!hit) return cmd;
	const flags: string[] = [];
	if (!/-interaction[= ]/.test(cmd)) flags.push('-interaction=nonstopmode');
	if (!/-file-line-error\b/.test(cmd)) flags.push('-file-line-error');
	return flags.length > 0 ? cmd.replace(hit[1], `${hit[1]} ${flags.join(' ')}`) : cmd;
}

export interface CompileDeps {
	getLoadedPath(): string | null;
	/** the reactive compile command; {main} expands to the main file's path. */
	getCompileCommand(): string;
	terminalAvailable(): boolean;
	/** first-compile main-file confirmation state (null = unresolved for the current folder). */
	mainConfirmed(): boolean | null;
	/** the project names a compile command this machine has not accepted yet; nothing runs until
	 * the bar is answered. See projectConfig.ts for why the command alone needs consent. */
	commandPending(): boolean;
	getDock(): { runCommand(cmd: string, onDone?: (output: string) => void): void; interrupt(): void } | undefined;
	stat(path: string): Promise<{ exists: boolean; mtimeMs: number; size: number }>;
	readText(path: string): Promise<string>;
	create(path: string, type: 'file' | 'dir'): Promise<unknown>;
	fileUrl(path: string): string;
	/** flush the queued autosave and wait for it to land (SyncTeX needs the on-disk copy current). */
	flushSaves(): Promise<void>;
	refreshTree(): Promise<void>;
	showTerminal(): void;
	setDockView(view: 'terminal' | 'problems' | 'comments'): void;
	setPdfPaneOpen(open: boolean): void;
	openCompileModal(): void;
	openMainConfirm(then?: () => void): void;
	runDraftCompile(): Promise<void>;
	/** open the Typst live preview pane (its own attach effect does the rest). */
	openTypstPreview(): void;
	runManagedCompile?(request: ManagedCompileRequest): Promise<ManagedCompileResult>;
	cancelManagedCompile?(): Promise<void>;
}

export class CompilePipeline {
	// true from Compile until the run visibly ends (PDF landed, log settled, or timeout);
	// drives the Compile button's Stop toggle, and Stop sends Ctrl+C to the shell
	compiling = $state(false);
	// A run has been dispatched and is not yet known to have finished. Deliberately separate from
	// `compiling`, which stays false when the completion marker is off so the button does not show a
	// Stop that would linger until the pollers time out. This one is always set, because refusing an
	// overlapping compile has to work whether or not the marker is on.
	busy = $state(false);
	pdfFilename = $state('output.pdf');
	private pdfWatchTimer: ReturnType<typeof setTimeout> | null = null;
	private logWatchTimer: ReturnType<typeof setTimeout> | null = null;
	// bumped when a compile starts, ends, or the folder changes; pollers from a superseded run
	// check it and stand down (their timeout may already be in flight when the timers are cleared)
	private compileGen = 0;
	// dvipdfmx/xdvipdfmx write diagnostics to stdout, not the .log; captured per compile by the
	// terminal's sentinel tracking and cleared at the start of each run
	private compileStdout = '';
	private managedActive = false;

	constructor(private deps: CompileDeps) {}

	/** a run ended (or was stopped): clear both the button state and the overlap guard */
	private endRun() {
		this.compiling = false;
		this.busy = false;
	}

	stopCompile = () => {
		if (this.managedActive) {
			void this.deps.cancelManagedCompile?.();
			this.compileGen++;
			this.compiling = false;
			return; // keep the overlap guard until the native process has actually exited
		}
		this.deps.getDock()?.interrupt();
		this.endRun();
	};

	// the folder changed: any pollers still watching the previous folder's paths stand down
	resetForFolder = () => {
		if (this.managedActive) void this.deps.cancelManagedCompile?.();
		else this.endRun();
		this.compileGen++;
	};

	// component teardown: stop the pollers
	dispose = () => {
		this.compileGen++;
		if (this.managedActive) void this.deps.cancelManagedCompile?.();
		if (this.pdfWatchTimer) clearTimeout(this.pdfWatchTimer);
		if (this.logWatchTimer) clearTimeout(this.logWatchTimer);
	};

	// expand {main} to the project's main file (relative to the folder root), else the open file
	private resolvedCompileCommand(cmd: string): string {
		const root = get(workspaceRoot);
		const target = get(mainFile) ?? this.deps.getLoadedPath();
		const rel = root && target ? relFromRoot(target, root) : '';
		// quote a path containing spaces so the shell keeps it one argument;
		// a {main} the user already wrapped in quotes stays untouched
		const quoted = /\s/.test(rel) ? `"${rel}"` : rel;
		// function replacements so a path containing $&, $1, $` etc. is inserted literally, not as a
		// replacement-pattern reference
		return cmd.replace(/(["']){main}\1/g, (_m, q: string) => `${q}${rel}${q}`).replaceAll('{main}', () => quoted);
	}

	// show the terminal, wait for mount, then run (the shell queues the command until it has
	// spawned). onDone fires when the shell reports the line finished (Terminal.run's sentinel echo).
	private runInTerminal(cmd: string, onDone?: (output: string) => void, tries = 0) {
		const dock = this.deps.getDock();
		if (dock) {
			dock.runCommand(cmd, onDone);
			return;
		}
		if (tries < 40) setTimeout(() => this.runInTerminal(cmd, onDone, tries + 1), 25); // ~1s for the dock to mount
	}

	runCompile = async () => {
		await loadSettings();
		// One run at a time. The Compile button becomes Stop so a local user rarely gets here twice,
		// but shortcuts and automation can still reach this directly. Overlapping runs fight over
		// the same aux/output files and
		// queue up in the shell, so the second one is refused rather than deferred. Draft mode is
		// exempt by construction: it never sets `busy`, because its service supersedes an in-flight
		// run of the same root instead, which is what makes it usable as a live preview.
		if (this.busy) {
			toaster.info({ title: m.wsview_toast_compile_busy(), duration: 2500 });
			return;
		}
		// The project asks for a command this machine has not accepted. Held here rather than at the
		// button, because the button is one of seven ways in: the keybinding, the compile window
		// event, the palette, MCP, Save & run, and the first-compile confirm. Gating the entry point
		// is what makes "nothing runs until you decide" true
		// rather than merely apparent.
		//
		// Draft mode and the Typst preview are deliberately NOT gated: they drive built-in engines
		// and never execute the project's command, so stopping them would cost a live preview to
		// answer a question about a shell string they do not run.
		const root = get(workspaceRoot);
		const target = get(mainFile) ?? this.deps.getLoadedPath();
		const managed =
			effectiveCompileFormat(root, target) === 'latex' &&
			((root ? savedLatexEngine(root) : null) ?? get(settings).compileEngine) === 'tectonic' &&
			!get(settings).draftMode;
		if (!managed && this.deps.commandPending()) {
			toaster.warning({ title: m.project_command_blocked_title(), description: m.project_command_blocked_desc(), duration: 5000 });
			return;
		}
		// first compile in a folder with no explicitly chosen main file: confirm it first
		if (this.deps.mainConfirmed() !== true && get(texFiles).length > 1) {
			this.deps.openMainConfirm(() => void this.runCompile());
			return;
		}
		// Live mode IS the incremental lualatex pipeline, so it cannot serve a Typst project. The
		// setting is global and the user may arrive here with it left on from a LaTeX folder, so
		// ignore it rather than trapping them - the terminal command below is the correct build.
		if (get(settings).draftMode && !isTypstCommand(this.deps.getCompileCommand())) {
			await this.deps.runDraftCompile();
			return;
		}
		// Preview is Typst's live path, exactly as draft mode is LaTeX's: it renders through the
		// language server, so a shell run would only produce a PDF nobody is looking at. Compile
		// therefore opens (or refreshes) the preview pane instead, and the modal says so.
		if (!managed && get(settings).typstLiveMode !== false && isTypstCommand(this.deps.getCompileCommand())) {
			this.deps.openTypstPreview();
			return;
		}
		if (managed) {
			if (!root || !target) {
				this.deps.openMainConfirm();
				return;
			}
			this.busy = true;
			this.compiling = true;
			this.managedActive = true;
			const generation = ++this.compileGen;
			try {
				await this.deps.flushSaves();
				if (generation !== this.compileGen) return;
				const result = (await this.deps.runManagedCompile?.({ engine: 'tectonic', mainFile: relFromRoot(target, root) })) ?? {
					ok: false as const,
					error: 'ENGINE_UNAVAILABLE' as const,
					stdout: ''
				};
				if (generation !== this.compileGen || get(workspaceRoot) !== root) return;
				const diagnostics = await parseCompileDiagnosticsInWorker(result.stdout, null, result.stdout);
				if (generation !== this.compileGen) return;
				compileLog.set({ ...diagnostics, logPath: result.logPath ?? '', updatedAt: Date.now() });
				if (result.ok === true) {
					const pdf = await this.deps.stat(result.pdfPath);
					if (generation !== this.compileGen || get(workspaceRoot) !== root) return;
					this.showCompiledPdf(result.pdfPath, pdf.mtimeMs);
				} else if (result.error !== 'CANCELLED') {
					this.deps.setDockView('problems');
					toaster.error({
						title: m.managed_compile_failed(),
						description: `${result.error}\n${result.stdout.slice(-2000)}`,
						duration: 7000
					});
				}
			} catch (error) {
				if (generation === this.compileGen)
					toaster.error({ title: m.managed_compile_failed(), description: String(error), duration: 7000 });
			} finally {
				this.managedActive = false;
				this.endRun();
				void this.deps.refreshTree();
			}
			return;
		}
		if (!this.deps.terminalAvailable()) return;
		const cmd = this.deps.getCompileCommand().trim();
		// no command yet: ask in the modal first
		if (!cmd) {
			this.deps.openCompileModal();
			return;
		}
		// {main} with no main file: a truly empty folder has nothing to compile; otherwise the user
		// cleared the main file, so let them pick one (then compile). Dismissing leaves it unset.
		if (cmd.includes('{main}') && !get(mainFile)) {
			if (get(texFiles).length === 0) {
				toaster.error({ title: m.wsview_toast_nothing_to_compile_title(), description: m.wsview_toast_nothing_to_compile_desc() });
			} else {
				this.deps.openMainConfirm(() => {
					if (get(mainFile)) void this.runCompile();
				});
			}
			return;
		}
		// Claim the slot BEFORE the first await, not down with `compiling`.
		//
		// The overlap guard above used to read this flag four
		// awaits before anything set it - flushSaves, two stats and the mkdir all ran while it was
		// still false. Two compiles starting inside that window both passed, and two latexmk runs
		// then shared one directory's .aux / .pdf / .synctex. A double-click did it; no malice or
		// external coordination required.
		//
		// Every early return above is synchronous, and the draft path returns before here and never
		// sets busy by design, so claiming it at this point needs no unwinding.
		this.busy = true;
		// write the buffer to disk BEFORE compiling so SyncTeX indexes exactly what the editor
		// holds; otherwise reverse search maps PDF clicks into a stale, differently formatted .tex
		await this.deps.flushSaves();
		const pdfPath = this.expectedPdfPath();
		const before = pdfPath ? (await this.deps.stat(pdfPath)).mtimeMs : 0; // baseline BEFORE compiling
		const logPath = this.expectedLogPath();
		const logBefore = logPath ? (await this.deps.stat(logPath)).mtimeMs : 0;
		await this.ensureOutputDir();
		this.deps.refreshTree(); // the output/ folder may have just been created
		this.deps.showTerminal();
		// marker off = no end signal from the shell; leave the button as Compile instead of a
		// Stop that would linger until the log/PDF pollers time out
		const track = get(settings).compileSentinel;
		this.compiling = track;
		this.busy = true; // set even without the marker: the overlap guard must not depend on it
		const gen = ++this.compileGen;
		this.compileStdout = '';
		this.runInTerminal(
			withBatchFlags(this.resolvedCompileCommand(cmd)),
			track
				? (output) => {
						this.compileStdout = output ?? ''; // dvipdfmx/xdvipdfmx diagnostics only exist here
						this.finalizeCompile(gen, pdfPath, before, logPath, logBefore);
					}
				: undefined
		);
		// with the completion marker on, finalizeCompile loads the finished PDF once the command
		// exits. Don't ALSO poll-load here: LaTeX rewrites the PDF across passes (and truncates it
		// mid-write), so an early poll would load a partial/pass-1 PDF, then finalize reloads the
		// final one -- a double reload that flashes. Without the marker there's no exit signal, so
		// watchPdf is the fallback, and it now waits for the file to stop changing before loading.
		if (!track && pdfPath) this.watchPdf(gen, pdfPath, before);
		if (logPath) this.watchLog(gen, logPath, logBefore, track);
		// reload the explorer as the build writes its output (also covers builds that produce no PDF)
		[2000, 6000].forEach((d) => setTimeout(this.deps.refreshTree, d));
	};

	// the output dir named in the command (-output-directory= / -outdir=), else the folder root.
	// takes an explicit command so callers that run before compileCommand hydrates can pass the settings value.
	// compile-command parsing/generation lives in compileCommand.ts; these thin wrappers supply the
	// reactive root / main-file / per-folder overrides the pure functions take as arguments
	expectedPdfPath = (cmd = this.deps.getCompileCommand()): string | null => {
		const root = get(workspaceRoot);
		const main = get(mainFile) ?? this.deps.getLoadedPath();
		return cc.expectedPdfPath(cmd, root, main, root ? savedFormatOutputs(root, effectiveCompileFormat(root, main)).pdf : undefined);
	};

	// A zero-byte log means "the engine never really ran" for TeX, so it is ignored — but for Typst
	// it means the opposite: stderr was empty, i.e. the document compiled clean. Without this the
	// Problems panel would keep showing the previous failing run's errors after a good compile.
	private logMayBeEmpty = (cmd = this.deps.getCompileCommand()): boolean => isTypstCommand(cmd);

	expectedLogPath = (cmd = this.deps.getCompileCommand()): string | null => {
		const root = get(workspaceRoot);
		const main = get(mainFile) ?? this.deps.getLoadedPath();
		return cc.expectedLogPath(cmd, root, main, root ? savedFormatOutputs(root, effectiveCompileFormat(root, main)) : undefined);
	};

	// read the .log plus the sibling .blg (it reflects the LAST bib run, which stays valid
	// even on compiles where latexmk skips bibtex) and publish the parsed problems
	// stdout defaults to the last run's, which is right for the compile that produced it. The live
	// preview's own compile has none, and inheriting a stale one would attribute a previous run's
	// stdout-only errors to this log -- so that caller passes null explicitly.
	publishLogDiagnostics = async (logPath: string, mtimeMs: number, quiet = false, stdout: string | null = this.compileStdout || null) => {
		const blgPath = logPath.replace(/\.log$/i, '.blg');
		const blgText = (await this.deps.stat(blgPath)).exists ? await this.deps.readText(blgPath) : null;
		const parsed = await parseCompileDiagnosticsInWorker(await this.deps.readText(logPath), blgText, stdout);
		// bib warnings name a key ("empty journal in Smith2020"); projectIntel knows every
		// entry's exact line, so point the row at it (LW resolves these via its citation cache)
		const bibEntries = get(projectIntelStore).bibEntries;
		for (const e of parsed.entries) {
			if (e.source !== 'bib' || e.line !== undefined) continue;
			const key = e.message.match(/\bin ['"]?([\w:.-]+)['"]?$/) ?? e.message.match(/\bentry '([^']+)'/);
			const hit = key ? bibEntries.find((b) => b.key === key[1]) : undefined;
			if (hit) {
				e.file = hit.file;
				e.line = hit.line;
			}
		}
		compileLog.set({ ...parsed, logPath, updatedAt: mtimeMs });
		// a failed build produces no fresh PDF, so nothing else tells the user: surface the
		// Problems list. Clean/warning-only results never steal the dock; quiet baseline refreshes
		// also leave the user's dock state unchanged.
		if (!quiet && parsed.errors.length > 0) {
			this.deps.setDockView('problems');
			this.deps.showTerminal();
		}
	};

	// poll the .log and parse once it settles: the engine rewrites the log during each pass, so
	// "newer than baseline AND unchanged across two polls" re-parses after each pass and also
	// catches failed builds, where no PDF ever appears but the log does.
	//
	// Settling is a HEURISTIC, and it must not end a sentinel-tracked run: any engine pause longer
	// than the two polls (biber grinding between passes, MiKTeX installing a package on the fly)
	// makes the log look settled mid-run, and dropping `busy` there hands an MCP poller pass-1
	// diagnostics as final while latexmk is still going. When `tracked`, publishing stays (live
	// Problems updates per pass) but the end belongs to finalizeCompile's shell-exit signal alone.
	private watchLog(
		gen: number,
		logPath: string,
		before: number,
		tracked = false,
		elapsed = 0,
		prev: { mtimeMs: number; size: number } | null = null,
		lastParsed = 0
	) {
		if (this.logWatchTimer) clearTimeout(this.logWatchTimer);
		this.logWatchTimer = setTimeout(async () => {
			if (gen !== this.compileGen) return; // superseded: a newer compile, finalize, or folder switch
			const s = await this.deps.stat(logPath);
			const changedSinceCompile = s.exists && (s.size > 0 || this.logMayBeEmpty()) && s.mtimeMs > before;
			const stable = prev !== null && s.mtimeMs === prev.mtimeMs && s.size === prev.size;
			if (changedSinceCompile && stable && s.mtimeMs !== lastParsed) {
				try {
					await this.publishLogDiagnostics(logPath, s.mtimeMs);
					// a settled log is only "the run ended" when nothing better is coming; tracked runs
					// end on the shell's exit signal, and this settle may just be a between-pass pause
					if (!tracked) this.endRun();
					lastParsed = s.mtimeMs;
				} catch {
					/* transient read race with the engine; next poll retries */
				}
			}
			if (elapsed < 180000) {
				this.watchLog(gen, logPath, before, tracked, elapsed + 1200, { mtimeMs: s.mtimeMs, size: s.size }, lastParsed);
			} else {
				this.logWatchTimer = null;
				this.endRun();
			}
		}, 1200);
	}

	// the shell reported the command finished (sentinel echo). the pollers only notice runs that
	// WRITE something; a run that dies without touching the log or PDF would leave Stop showing
	// until their timeout. give trailing writes a beat, check both artifacts once, stand pollers down.
	private finalizeCompile(gen: number, pdfPath: string | null, pdfBefore: number, logPath: string | null, logBefore: number) {
		setTimeout(async () => {
			if (gen !== this.compileGen) return; // a newer compile or a folder switch took over
			this.compileGen++; // this run is over; its pollers stand down
			if (this.pdfWatchTimer) {
				clearTimeout(this.pdfWatchTimer);
				this.pdfWatchTimer = null;
			}
			if (this.logWatchTimer) {
				clearTimeout(this.logWatchTimer);
				this.logWatchTimer = null;
			}
			try {
				if (logPath) {
					const s = await this.deps.stat(logPath);
					if (s.exists && (s.size > 0 || this.logMayBeEmpty()) && s.mtimeMs > logBefore)
						await this.publishLogDiagnostics(logPath, s.mtimeMs);
				}
				if (pdfPath) {
					const s = await this.deps.stat(pdfPath);
					if (s.exists && s.size > 0 && s.mtimeMs > pdfBefore) this.showCompiledPdf(pdfPath, s.mtimeMs);
				}
			} catch {
				/* fs hiccup: the run still ended, the button must still reset */
			}
			this.reportMissingTool();
			this.endRun();
			this.deps.refreshTree();
		}, 400);
	}

	/**
	 * The command named a program the shell could not find: say so, and offer the panel that lists
	 * what IS installed.
	 *
	 * Worth its own toast because this failure produces no diagnostics to show. No log is written,
	 * no PDF appears, and the Problems panel stays empty - the only evidence is one line of shell
	 * text in a terminal the reader may not have open, phrased by the shell rather than by us
	 * ("'latexmk' is not recognized as an internal or external command"), which says nothing about
	 * what to do next.
	 *
	 * Only on the marker-tracked path, because that is the only one that captures output at all
	 * (see runCompile). With the completion marker off, this failure stays as silent as it was.
	 */
	private reportMissingTool(): void {
		const program = leadingProgram(this.deps.getCompileCommand());
		if (!program || !shellSaidNotFound(this.compileStdout, program)) return;
		toaster.error({
			title: m.compile_tool_missing_title(),
			description: m.compile_tool_missing({ tool: program }),
			duration: 8000,
			action: { label: m.compile_tool_missing_action(), onClick: openToolchainPrefs }
		});
	}

	private async ensureOutputDir() {
		const root = get(workspaceRoot);
		const dir = cc.compileOutDir(this.deps.getCompileCommand());
		if (root && dir !== '.') {
			try {
				await this.deps.create(joinPath(root, dir), 'dir'); // mkdir -p, idempotent
			} catch {
				/* already exists */
			}
		}
	}

	// load a freshly compiled PDF into the pane; no-op if this exact build is already
	// shown so the poller and finalizeCompile can't reload it twice
	private showCompiledPdf(pdfPath: string, mtimeMs: number) {
		const url = this.deps.fileUrl(pdfPath) + '&t=' + Math.round(mtimeMs); // cache-bust so it reloads
		if (get(pdfStore) === url) return;
		this.pdfFilename = basename(pdfPath);
		pdfStore.set(url);
		this.deps.setPdfPaneOpen(true);
		this.deps.refreshTree(); // the compiled output landed; reload the file explorer
	}

	// poll the expected PDF after a compile (no-completion-marker fallback); load it once it has
	// stopped changing, so a mid-write partial or an intermediate latexmk pass isn't shown. `stableAt`
	// is the mtime seen on the previous poll; a match means the file settled.
	private watchPdf(gen: number, pdfPath: string, before: number, elapsed = 0, stableAt = 0) {
		if (this.pdfWatchTimer) clearTimeout(this.pdfWatchTimer);
		this.pdfWatchTimer = setTimeout(
			async () => {
				if (gen !== this.compileGen) return; // superseded: a newer compile, finalize, or folder switch
				const s = await this.deps.stat(pdfPath);
				if (s.exists && s.size > 0 && s.mtimeMs > before) {
					if (s.mtimeMs === stableAt) {
						this.showCompiledPdf(pdfPath, s.mtimeMs); // unchanged since the last poll: it's done
						this.pdfWatchTimer = null;
						this.endRun();
					} else {
						this.watchPdf(gen, pdfPath, before, elapsed + 600, s.mtimeMs); // still changing: re-check soon
					}
				} else if (elapsed < 180000) {
					this.watchPdf(gen, pdfPath, before, elapsed + 1200); // keep polling up to 3 min
				} else {
					this.pdfWatchTimer = null;
					this.endRun();
				}
			},
			stableAt ? 600 : 1200 // poll faster once the file has started changing, to catch it settling
		);
	}

	// on load and main-file change, show the already-compiled PDF sitting on disk; clears the
	// preview when the expected PDF is absent so a stale one doesn't linger. runs only at
	// init/folder-open/main-change, never mid-compile, so it can't race watchPdf.
	loadExistingPdf = async () => {
		// read the persisted command directly: on first mount this can run before the
		// reactive compileCommand is hydrated, and a stale '' would point at the wrong folder
		const s0 = await loadSettings();
		// the persisted main file, so an Auto folder resolves its real format even before the
		// reactive mainFile store hydrates
		const bootRoot = get(workspaceRoot);
		const pdfPath = this.expectedPdfPath(resolveCompileCommand(bootRoot, s0.compileCommand, bootRoot ? savedMainFile(bootRoot) : null));
		if (!pdfPath) {
			pdfStore.set(null);
			return;
		}
		const s = await this.deps.stat(pdfPath);
		if (s.exists && s.size > 0) {
			this.pdfFilename = basename(pdfPath);
			pdfStore.set(this.deps.fileUrl(pdfPath) + '&t=' + Math.round(s.mtimeMs)); // mtime cache-busts a stale load
			this.deps.setPdfPaneOpen(true); // a compiled PDF is ready; open the preview so a reload shows it
		} else {
			pdfStore.set(null);
		}
	};
}
