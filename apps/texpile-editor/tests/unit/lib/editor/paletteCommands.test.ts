// A guest joins over the CRDT and owns none of the host's folder: no tree writes, no latexindent,
// no grep, no git. The palette used to offer all four anyway - it gated on whether a file was open
// and on compile, but never on the provider's capabilities - so a guest could find "New LaTeX
// document" and run it into a provider that cannot create files.
import { describe, it, expect } from 'vitest';
import { buildCommands } from '$lib/editor/comp/palette/paletteCommands';
import type { PaletteActions } from '$lib/workspace/commandPalette.svelte';

/** every host-only capability off is exactly what a guest's provider reports */
function actions(caps: boolean): PaletteActions {
	return {
		save: () => {},
		runCompile: () => {},
		stopCompile: () => {},
		isCompiling: () => false,
		compileAvailable: () => caps,
		setViewMode: () => {},
		getViewMode: () => 'visual',
		hasFile: () => true,
		canManageTree: () => caps,
		canSearch: () => caps,
		canFormat: () => caps,
		canGit: () => caps,
		openFile: () => {},
		toggleSidebar: () => {},
		sidebarOpen: () => true,
		toggleTerminal: () => {},
		terminalVisible: () => false,
		terminalAvailable: () => caps,
		newTerminal: () => {},
		openCompileModal: () => {},
		openFormatModal: () => {},
		openGlobalSearch: () => {},
		openPreferences: () => {},
		newFile: () => {},
		openFolder: () => {},
		refreshTree: () => {},
		openTypstPreview: () => {},
		isTypstProject: () => false
	};
}

const HOST_ONLY = ['file.newTex', 'file.newBib', 'view.findInFiles', 'editor.format', 'view.diff'];

describe('palette commands', () => {
	it('offers the host-only commands to a host', () => {
		const ids = buildCommands(actions(true)).map((c) => c.id);
		expect(HOST_ONLY.filter((id) => !ids.includes(id))).toEqual([]);
	});

	it('offers none of them to a guest', () => {
		const ids = buildCommands(actions(false)).map((c) => c.id);
		expect(HOST_ONLY.filter((id) => ids.includes(id))).toEqual([]);
	});

	// what is left has to still be worth opening: a guest can move around, switch view, save
	it('still gives a guest something to run', () => {
		const ids = buildCommands(actions(false)).map((c) => c.id);
		expect(ids).toContain('file.save');
		expect(ids).toContain('view.sidebar');
		expect(ids).toContain('file.preferences');
	});
});
