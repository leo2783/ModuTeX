// The compile-command dialog's own state: the explicit format switch (latex | typst | auto),
// each format's own draft command, the per-folder output overrides, and persisting all of it.
// The switch is STORED state, never inferred from the command string; the two formats keep
// separate command/output slots, so flipping the switch never discards the other side's setup.
import { get } from 'svelte/store';
import {
	workspaceRoot,
	mainFile,
	savedCompileFormat,
	savedLatexEngine,
	setLatexEngine,
	setCompileFormat,
	effectiveCompileFormat,
	setFormatCommand,
	savedFormatOutputs,
	setFormatOutputs,
	type CompileFormat
} from '$lib/workspace/workspaceStore';
import { resolveFormatCommand } from '$lib/workspace/compilePipeline.svelte';
import { isTypstCommand } from '$lib/workspace/typstCommand';
import { settings, updateSettings, DEFAULT_COMPILE_COMMAND } from '$lib/settings';

export class CompileSettings {
	modalOpen = $state(false);
	/** the format switch as shown in the dialog; persisted per folder on save. */
	format = $state<CompileFormat>('auto');
	engine = $state<'tectonic' | 'system'>('tectonic');
	draft = $state('');
	outputsDraft = $state<{ pdf: string; log: string }>({ pdf: '', log: '' });
	advancedOpen = $state(false);

	constructor(
		private getCommand: () => string,
		private setCommand: (c: string) => void,
		private runCompile: () => void,
		/** persist the project-level part of this to .texpile/config.json */
		private saveProjectConfig: (root: string | null) => void = () => {}
	) {}

	/** the concrete lane a chip means right now: auto reads the main file's extension. */
	private lane(format: CompileFormat = this.format): 'latex' | 'typst' {
		return format === 'auto' ? effectiveCompileFormat(get(workspaceRoot), get(mainFile)) : format;
	}

	/** what the command field shows for a chip: that lane's saved command, else its default. */
	commandFor(format: CompileFormat): string {
		return resolveFormatCommand(get(workspaceRoot), this.lane(format), get(settings).compileCommand, get(mainFile));
	}

	open() {
		const root = get(workspaceRoot);
		this.format = root ? savedCompileFormat(root) : 'auto';
		this.engine = (root ? savedLatexEngine(root) : null) ?? get(settings).compileEngine;
		this.draft = this.commandFor(this.format);
		const ov = root ? savedFormatOutputs(root, this.lane()) : {};
		this.outputsDraft = { pdf: ov.pdf ?? '', log: ov.log ?? '' };
		this.advancedOpen = !!(ov.pdf || ov.log); // start expanded only if overrides exist
		this.modalOpen = true;
	}

	/** a format chip was clicked: swap the draft and the outputs to that lane's slots. */
	selectFormat(format: CompileFormat) {
		this.format = format;
		this.draft = this.commandFor(format);
		const root = get(workspaceRoot);
		const ov = root ? savedFormatOutputs(root, this.lane(format)) : {};
		this.outputsDraft = { pdf: ov.pdf ?? '', log: ov.log ?? '' };
	}

	save(thenRun: boolean) {
		const root = get(workspaceRoot);
		const lane = this.lane();
		const command = this.draft.trim();
		if (root) {
			setCompileFormat(root, this.format);
			if (lane === 'latex') setLatexEngine(root, this.engine);
			// Auto is a LANE choice and nothing more - the main file's extension picks latex or typst -
			// so saving under it does exactly what saving under that lane does. The lane's pinned
			// command is what auto runs anyway (resolveFormatCommand takes saved before any default),
			// so refusing to store one here left the field showing a live command it could not edit.
			// Clearing the box is still how you go back to the lane's default.
			if (lane !== 'latex' || this.engine === 'system') {
				setFormatCommand(root, lane, command || null);
				setFormatOutputs(root, lane, { pdf: this.outputsDraft.pdf.trim(), log: this.outputsDraft.log.trim() });
			}
		}
		// the global default is the LATEX lane's starting point for brand-new folders; typst's
		// default is generated, so it needs no global slot. Keyed on the resolved lane, so editing a
		// LaTeX command under Auto seeds it the same way editing it under LaTeX does.
		if (lane === 'latex')
			updateSettings({ compileEngine: this.engine, ...(this.engine === 'system' && command ? { compileCommand: command } : {}) });
		if (lane !== 'latex' || this.engine === 'system') this.setCommand(command);
		// the command the user just typed is theirs, so it is written out AND recorded as accepted
		this.saveProjectConfig(root);
		this.modalOpen = false;
		if (thenRun && (command || (lane === 'latex' && this.engine === 'tectonic'))) this.runCompile();
	}

	/**
	 * Apply a command and/or output overrides with no modal involved - the MCP path. The lane is
	 * taken from the command's binary here at the boundary (MCP hands a bare string), and setting
	 * a command pins that lane, mirroring what saving from the dialog does.
	 */
	applyCommand(command?: string, outputs?: { pdf?: string; log?: string }) {
		const root = get(workspaceRoot);
		if (command !== undefined) {
			const c = command.trim();
			const lane = c && isTypstCommand(c) ? 'typst' : 'latex';
			if (root) {
				if (c) {
					if (lane === 'latex') setLatexEngine(root, 'system');
					setCompileFormat(root, lane);
					setFormatCommand(root, lane, c);
				} else {
					setCompileFormat(root, 'auto');
				}
			}
			if (lane === 'latex' && c) updateSettings({ compileCommand: c, compileEngine: 'system' });
			this.setCommand(c || this.commandFor('auto'));
		}
		if (outputs && root) {
			// merge, so setting only the PDF does not silently clear a log override the user set
			const lane = effectiveCompileFormat(root, get(mainFile));
			const cur = savedFormatOutputs(root, lane);
			setFormatOutputs(root, lane, { pdf: outputs.pdf ?? cur.pdf ?? '', log: outputs.log ?? cur.log ?? '' });
		}
		// same as saving from the dialog: what was applied here is the project's, so it goes to
		// .texpile/config.json and is recorded as accepted. Without this an MCP-set command lived
		// only in localStorage, and reopening the folder would offer to replace it with the older
		// one still in the file.
		this.saveProjectConfig(root);
		// keep an open dialog showing what was just applied under it
		if (this.modalOpen) this.open();
	}

	useDefault() {
		this.format = 'latex';
		this.engine = 'tectonic';
		this.draft = DEFAULT_COMPILE_COMMAND;
		this.save(true);
	}
}
