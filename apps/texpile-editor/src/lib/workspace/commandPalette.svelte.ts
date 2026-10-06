// The Ctrl+K palette's open flag and the workspace callbacks it drives.
//
// A module singleton rather than props. The palette needs a slice of almost everything the
// workspace can do - compile, save, switch view, open a file, raise Preferences - and threading
// that through WorkspaceChrome -> WorkspaceMain -> a dialog would add a prop to four files for
// every command anyone ever adds. WorkspaceView registers the callbacks once; the palette and its
// command list import them directly.
//
// One window, one renderer, one palette, so a module-scoped value is exactly the right lifetime.

/** what the palette is allowed to do. Everything here already exists as a workspace action; the
 *  palette is a second way to reach it, never a second implementation. */
export interface PaletteActions {
	save(): void;
	runCompile(): void;
	stopCompile(): void;
	isCompiling(): boolean;
	compileAvailable(): boolean;
	setViewMode(mode: 'visual' | 'source' | 'diff'): void;
	getViewMode(): 'visual' | 'source' | 'diff';
	/** true when a file is open; most commands are meaningless without one */
	hasFile(): boolean;
	/** Provider capabilities. Unsupported commands are omitted rather than shown disabled. */
	canManageTree(): boolean;
	canSearch(): boolean;
	canFormat(): boolean;
	canGit(): boolean;
	openFile(abs: string): void;
	toggleSidebar(): void;
	sidebarOpen(): boolean;
	toggleTerminal(): void;
	terminalVisible(): boolean;
	terminalAvailable(): boolean;
	newTerminal(): void;
	openCompileModal(): void;
	openFormatModal(): void;
	openGlobalSearch(): void;
	openPreferences(): void;
	newFile(ext?: string): void;
	openFolder(): void;
	refreshTree(): void;
	/** open tinymist's incremental viewer for the current .typ, in its own window */
	openTypstPreview(): void;
	/** the compile target is Typst: New-file commands offer .typ instead of .tex */
	isTypstProject(): boolean;
}

class CommandPaletteState {
	open = $state(false);
	/**
	 * null until WorkspaceView mounts; the palette refuses to open without it.
	 *
	 * $state.raw, and it has to be state at all: the title bar derives its command-center button from
	 * whether this is set, and TitleBar mounts BEFORE WorkspaceView's onMount registers them - so as a
	 * plain field it read null once and the button could never appear. Raw rather than $state because
	 * this is a bag of closures swapped wholesale; deep-proxying it buys nothing.
	 */
	actions = $state.raw<PaletteActions | null>(null);

	show(): void {
		if (this.actions) this.open = true;
	}
	hide(): void {
		this.open = false;
	}
	toggle(): void {
		if (this.open) this.hide();
		else this.show();
	}
}

export const commandPalette = new CommandPaletteState();

/** WorkspaceView calls this on mount and clears it on destroy, so a palette opened from a stale
 *  keystroke after the workspace closed cannot call into a torn-down component. */
export function setPaletteActions(actions: PaletteActions | null): void {
	commandPalette.actions = actions;
	if (!actions) commandPalette.open = false;
}
