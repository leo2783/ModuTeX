// Keeps .texpile/config.json and the local per-workspace state in step.
//
// The file is the source of truth for the project's build settings, and every local change writes
// straight back to it - so there is no divergence to reconcile, and adopting the file on open is
// always the right thing. The one exception is the compile command, which Texpile executes: see
// projectConfig.ts for why that needs accepting once per project before it is used.
import {
	savedCompileFormat,
	savedFormatCommand,
	savedLatexEngine,
	setLatexEngine,
	savedFormatOutputs,
	savedMainFile,
	savedMainFileRel,
	setCompileFormat,
	setFormatCommand,
	setFormatOutputs,
	setMainFile,
	effectiveCompileFormat,
	isCommandTrusted,
	trustCommand
} from '$lib/workspace/workspaceStore';
import { joinPath } from '$lib/workspace/fileSystem';
import { hasProjectConfig, readProjectConfig, writeProjectConfig, type ProjectConfig } from '$lib/workspace/projectConfig';

export interface PendingCommand {
	root: string;
	format: 'latex' | 'typst';
	command: string;
}

export class ProjectConfigSync {
	/** a command the project asks for that this machine has not accepted; drives the bar */
	pending = $state<PendingCommand | null>(null);

	/**
	 * Read the project's config and apply it.
	 *
	 * Everything inert lands immediately - main file, format, output paths - because none of it can
	 * do anything but point the compiler at the right files. The command is held back unless it has
	 * already been accepted here.
	 */
	async adopt(root: string | null): Promise<void> {
		this.pending = null;
		if (!root) return;
		// No file yet: this folder was configured before .texpile/config.json existed, so its local
		// settings ARE the project's and get written out once. Keyed on the file being absent rather
		// than unreadable - a config from a newer Texpile must not be overwritten by an older one.
		if (!(await hasProjectConfig(root))) {
			await this.seed(root);
			return;
		}
		const cfg = await readProjectConfig(root);
		if (!cfg) return;
		// back to absolute: setMainFile takes a real path and re-relativises it against the root
		if (cfg.main !== undefined) setMainFile(root, cfg.main ? joinPath(root, cfg.main) : null);
		// including 'auto': the project saying "derive it from the main file" has to be able to
		// override a format this machine happens to have pinned, or the two never converge
		if (cfg.compile) setCompileFormat(root, cfg.compile);
		if (cfg.latex?.engine === 'tectonic' || cfg.latex?.engine === 'system') setLatexEngine(root, cfg.latex.engine);
		else if (cfg.latex?.command) setLatexEngine(root, 'system');

		for (const format of ['latex', 'typst'] as const) {
			const fc = cfg[format];
			// Output overrides are applied even when ABSENT, which clears them. The file is a full
			// snapshot of the project's build settings, so "no override here" has to mean something -
			// otherwise setting a path propagated to everyone and clearing it never did, and the two
			// machines drifted apart with no way back.
			setFormatOutputs(root, format, fc?.outputs ?? {});
			// The command is deliberately NOT symmetric: absent leaves the local one alone. It is the
			// one setting that needs consent to apply, and something that needs asking before it runs
			// should not be removable behind your back either.
			if (!fc?.command) continue;
			if (isCommandTrusted(root, format, fc.command)) setFormatCommand(root, format, fc.command);
			// only ask about the format this project actually builds with. Prompting for the other
			// lane's command would be a question about something the user is not doing.
			else if (format === effectiveCompileFormat(root, savedMainFile(root))) this.pending = { root, format, command: fc.command };
		}
	}

	/**
	 * Re-read the file after someone else wrote it - a `git pull`, a second window, an agent.
	 *
	 * Safe to run at any moment precisely because there is nothing local to lose: every change made
	 * here writes straight back to the file, so the file is never behind us. What it does NOT do is
	 * seed - deleting .texpile/config.json should leave it deleted, not have it reappear a breath
	 * later from the state it was holding.
	 */
	async refresh(root: string | null): Promise<void> {
		if (!root || !(await hasProjectConfig(root))) return;
		await this.adopt(root);
	}

	/**
	 * Write local settings out for a folder that predates the config file.
	 *
	 * Only when there is something worth writing: opening a plain folder to read a paper should not
	 * leave a .texpile/ behind. The getters read through workspaceStore's own normalisation, so a
	 * workspace still holding 0.16.1's flat compileCommand is migrated to per-format lanes first and
	 * this sees the result - the two migrations chain rather than competing.
	 */
	private async seed(root: string): Promise<void> {
		const hasAny =
			!!savedLatexEngine(root) ||
			!!savedMainFile(root) ||
			savedCompileFormat(root) !== 'auto' ||
			(['latex', 'typst'] as const).some(
				(f) => savedFormatCommand(root, f) || savedFormatOutputs(root, f).pdf || savedFormatOutputs(root, f).log
			);
		if (hasAny) await this.save(root);
	}

	/** the user pressed Use it: remember the command for this project and apply it */
	accept(): void {
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		trustCommand(p.root, p.format, p.command);
		setFormatCommand(p.root, p.format, p.command);
	}

	/**
	 * Write the local state back out.
	 *
	 * A command the user set here is trusted by definition - they typed it - so it is recorded as
	 * accepted at the same time. Otherwise reopening the folder would ask them to approve their own
	 * command.
	 */
	async save(root: string | null): Promise<void> {
		if (!root) return;
		// Saving settles the question the bar was asking: what goes to the file below is this
		// machine's own state, so the divergence that raised it is gone - whether the user typed a
		// new command, kept theirs, or pressed Use it first. Clearing here rather than in the dialog
		// means every writer (the dialog, MCP, the main-file setter) settles it the same way.
		this.pending = null;
		// What is already in the file, to carry forward anything this machine never took in. A
		// command for the lane the project does not build with is never adopted (adopt only offers
		// the effective lane's, and only trusted ones reach local state), so rebuilding the file from
		// local state alone DELETED it: one Save in a .tex project and the Typst command a
		// collaborator committed was gone. We are only authoritative about what we accepted.
		const prev = await readProjectConfig(root);
		const format = savedCompileFormat(root);
		const cfg: ProjectConfig = { ...prev, v: 1 };
		// the stored relative value, not savedMainFile() put back through a relativiser - see
		// savedMainFileRel. An absolute path here means nothing on anyone else's machine.
		const main = savedMainFileRel(root);
		if (main) cfg.main = main.replace(/\\/g, '/');
		// 'auto' is written too. It is a CHOICE - follow the main file's extension - and leaving it
		// out made the file ambiguous between "auto" and "this project never said", so a reader
		// could not tell whether the pinned command beside it was meant to be used.
		cfg.compile = format;
		for (const lane of ['latex', 'typst'] as const) {
			const local = savedFormatCommand(root, lane) ?? undefined;
			// Untouched by us: keep the file's. Trust is the test rather than "is local empty" - a
			// command the user accepted or typed and then CLEARED is one we know about, and clearing
			// has to be able to remove it. One we never trusted, we never read, so we cannot claim it
			// is gone.
			const kept = prev?.[lane]?.command;
			const command = local || (kept && !isCommandTrusted(root, lane, kept) ? kept : undefined);
			const outputs = savedFormatOutputs(root, lane);
			const hasOutputs = !!(outputs.pdf || outputs.log);
			const engine = lane === 'latex' ? savedLatexEngine(root) : null;
			if (!command && !hasOutputs && !engine) {
				delete cfg[lane];
				continue;
			}
			cfg[lane] = { ...prev?.[lane], ...(engine ? { engine } : {}) };
			if (command) cfg[lane]!.command = command;
			else delete cfg[lane]!.command;
			if (hasOutputs) cfg[lane]!.outputs = outputs;
			else delete cfg[lane]!.outputs;
			// only what came from THIS machine is accepted by having been written; a carried-forward
			// command is still the project's, and still has to be approved before it runs
			if (local) trustCommand(root, lane, local);
		}
		await writeProjectConfig(root, cfg);
	}
}
