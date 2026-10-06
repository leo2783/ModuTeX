// What the Ctrl+K palette can run.
//
// Every entry delegates to a workspace action that already exists and is already reachable from a
// menu or a shortcut. The palette is a faster way in, not a second implementation - so a command
// that stops working here is a command that stopped working everywhere, which is the point.
//
// Rebuilt on each open (not memoized): labels depend on live state - "Show terminal" vs "Hide
// terminal", which view mode is already active - and an open palette is not a hot path.
import {
	AlignLeft,
	Columns2,
	Eye,
	FilePlus2,
	FileText,
	FolderOpen,
	GitCompare,
	Keyboard,
	PanelLeft,
	Play,
	RefreshCw,
	Save,
	Search,
	Settings,
	Square,
	Terminal,
	TerminalSquare
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { get } from 'svelte/store';
import { fileTree, workspaceRoot } from '$lib/workspace/workspaceStore';
import { relativeTo, type TreeEntry } from '$lib/workspace/fileSystem';
import { settings, updateSettings, type AppSettings } from '$lib/settings';
import { combo } from '$lib/editor/comp/shortcutText';
import type { PaletteActions } from '$lib/workspace/commandPalette.svelte';
import { m } from '$lib/paraglide/messages';

export interface PaletteItem {
	id: string;
	label: string;
	group: string;
	/** matched against but never shown, so "build" can find Compile */
	keywords?: string;
	/** right-aligned: a shortcut, or a path for a file entry */
	hint?: string;
	icon?: Component;
	run(): void;
}

/** files are capped so a big project cannot push every command off the list */
export const MAX_FILE_RESULTS = 40;

/** the action commands, in the order they appear when nothing has been typed */
export function buildCommands(a: PaletteActions): PaletteItem[] {
	const items: PaletteItem[] = [];
	const push = (item: PaletteItem | null) => {
		if (item) items.push(item);
	};
	const g = {
		file: m.palette_group_file(),
		compile: m.palette_group_compile(),
		view: m.palette_group_view(),
		editor: m.palette_group_editor()
	};

	// ---- compile first: it is the reason most people reach for a palette in a LaTeX editor ----
	if (a.compileAvailable()) {
		push(
			a.isCompiling()
				? {
						id: 'compile.stop',
						label: m.palette_stop_compile(),
						group: g.compile,
						keywords: 'cancel abort kill build',
						hint: combo('Enter', { alt: true }),
						icon: Square,
						run: () => a.stopCompile()
					}
				: {
						id: 'compile.run',
						label: m.menubar_terminal_compile(),
						group: g.compile,
						keywords: 'build make pdf latex run',
						hint: combo('Enter', { alt: true }),
						icon: Play,
						run: () => a.runCompile()
					}
		);
		push({
			id: 'compile.configure',
			label: m.menubar_configure_compile_command(),
			group: g.compile,
			keywords: 'command latexmk engine settings',
			icon: Settings,
			run: () => a.openCompileModal()
		});
	}
	if (a.terminalAvailable()) {
		push({
			id: 'terminal.toggle',
			label: a.terminalVisible() ? m.palette_hide_terminal() : m.menubar_show_terminal(),
			group: g.compile,
			keywords: 'shell console panel dock',
			icon: Terminal,
			run: () => a.toggleTerminal()
		});
		push({
			id: 'terminal.new',
			label: m.menubar_new_terminal(),
			group: g.compile,
			keywords: 'shell console',
			icon: TerminalSquare,
			run: () => a.newTerminal()
		});
	}

	// ---- view ----
	const mode = a.getViewMode();
	if (a.hasFile()) {
		if (mode !== 'visual')
			push({
				id: 'view.visual',
				label: m.palette_show_visual(),
				group: g.view,
				keywords: 'wysiwyg rendered preview mode',
				icon: Eye,
				run: () => a.setViewMode('visual')
			});
		if (mode !== 'source')
			push({
				id: 'view.source',
				label: m.palette_show_source(),
				group: g.view,
				keywords: 'latex code raw mode',
				icon: Columns2,
				run: () => a.setViewMode('source')
			});
		if (mode !== 'diff' && a.canGit())
			push({
				id: 'view.diff',
				label: m.palette_show_diff(),
				group: g.view,
				keywords: 'git changes compare commit',
				icon: GitCompare,
				run: () => a.setViewMode('diff')
			});
	}
	push({
		id: 'view.sidebar',
		label: a.sidebarOpen() ? m.palette_hide_sidebar() : m.palette_show_sidebar(),
		group: g.view,
		keywords: 'explorer files panel',
		icon: PanelLeft,
		run: () => a.toggleSidebar()
	});
	if (a.canSearch())
		push({
			id: 'view.findInFiles',
			label: m.wsview_find_in_files(),
			group: g.view,
			keywords: 'grep search project',
			hint: combo('F', { shift: true }),
			icon: Search,
			run: () => a.openGlobalSearch()
		});

	// ---- editor ----
	if (a.hasFile() && a.canFormat())
		push({
			id: 'editor.format',
			label: m.menubar_format_document(),
			group: g.editor,
			keywords: 'latexindent reindent tidy beautify',
			icon: AlignLeft,
			run: () => a.openFormatModal()
		});
	// keybindings are switched from here rather than only in Preferences: a vim user who lands in a
	// fresh install wants one keystroke to fix it, not a dialog
	const current = get(settings).editorKeymap ?? 'default';
	const keymapLabel: Record<AppSettings['editorKeymap'], string> = {
		default: m.prefs_keybindings_default(),
		vim: 'Vim',
		emacs: 'Emacs'
	};
	for (const km of ['default', 'vim', 'emacs'] as const) {
		if (km === current) continue;
		push({
			id: `editor.keymap.${km}`,
			label: m.palette_use_keymap({ name: keymapLabel[km] }),
			group: g.editor,
			keywords: 'keybindings modal editing keymap',
			icon: Keyboard,
			run: () => updateSettings({ editorKeymap: km })
		});
	}

	// ---- file ----
	if (a.hasFile())
		push({
			id: 'file.save',
			label: m.menubar_save(),
			group: g.file,
			keywords: 'write disk',
			hint: combo('S'),
			icon: Save,
			run: () => a.save()
		});
	if (a.canManageTree()) {
		// the compile target decides the document rows, exactly as in the File > New menus:
		// .typ for a Typst project, .tex otherwise; .bib and markdown serve both
		if (a.isTypstProject()) {
			push({
				id: 'file.newTyp',
				label: m.menubar_new_typ(),
				group: g.file,
				keywords: 'create add document typst',
				icon: FilePlus2,
				run: () => a.newFile('typ')
			});
			push({
				id: 'typst.preview',
				label: m.typst_preview_open(),
				group: g.file,
				keywords: 'typst live preview watch tinymist',
				icon: Play,
				run: () => a.openTypstPreview()
			});
		} else {
			push({
				id: 'file.newTex',
				label: m.menubar_new_tex(),
				group: g.file,
				keywords: 'create add document',
				icon: FilePlus2,
				run: () => a.newFile('tex')
			});
		}
		push({
			id: 'file.newBib',
			label: m.menubar_new_bib(),
			group: g.file,
			keywords: 'create add bibliography references',
			icon: FilePlus2,
			run: () => a.newFile('bib')
		});
		push({
			id: 'file.newMd',
			label: m.menubar_new_md(),
			group: g.file,
			keywords: 'create add document markdown notes',
			icon: FilePlus2,
			run: () => a.newFile('md')
		});
	}
	push({
		id: 'file.openFolder',
		label: m.menubar_open_new_folder(),
		group: g.file,
		keywords: 'project workspace directory',
		icon: FolderOpen,
		run: () => a.openFolder()
	});
	push({
		id: 'file.refreshTree',
		label: m.wsview_refresh_tree_title(),
		group: g.file,
		keywords: 'reload rescan',
		icon: RefreshCw,
		run: () => a.refreshTree()
	});
	push({
		id: 'file.preferences',
		label: m.menubar_preferences(),
		group: g.file,
		keywords: 'settings options config',
		icon: Settings,
		run: () => a.openPreferences()
	});
	return items;
}

/** every file in the open tree, flattened, as "go to file" entries */
export function buildFileItems(a: PaletteActions): PaletteItem[] {
	const root = get(workspaceRoot);
	const tree = get(fileTree);
	if (!root || !tree.length) return [];
	const out: PaletteItem[] = [];
	const group = m.palette_group_go();
	const walk = (entries: TreeEntry[]) => {
		for (const e of entries) {
			if (e.type === 'dir') {
				if (e.children) walk(e.children);
				continue;
			}
			const rel = relativeTo(root, e.path);
			out.push({
				id: `go:${e.path}`,
				// the name is what you read; the folder is the hint, so a long path cannot swamp the row
				label: e.name,
				group,
				// matching runs against the label plus the keywords, so typing part of a folder works
				keywords: rel,
				hint: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
				icon: FileText,
				run: () => a.openFile(e.path)
			});
		}
	};
	walk(tree);
	return out;
}
