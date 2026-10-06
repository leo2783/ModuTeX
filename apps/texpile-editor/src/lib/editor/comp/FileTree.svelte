<script lang="ts">
	import {
		ChevronRight,
		ChevronDown,
		FilePlus,
		FolderPlus,
		Pencil,
		Trash2,
		Star,
		FileSymlink,
		Copy,
		ClipboardPaste,
		FolderOpen,
		Undo2,
		Redo2
	} from '@lucide/svelte';
	import { untrack } from 'svelte';
	import FileIcon from './FileIcon.svelte';
	import { samePath, type TreeEntry } from '$lib/workspace/fileSystem';
	import type { FileHistory } from '$lib/workspace/fileHistory.svelte';
	import { gitKey } from '$lib/workspace/gitStore';
	import type { GitBadge } from '$lib/workspace/git';
	import { m } from '$lib/paraglide/messages';
	import { confirmAsk } from '$lib/modals/confirm.svelte';
	import { toaster } from '$lib/modals/toaster-svelte';

	interface Props {
		tree: TreeEntry[];
		rootPath: string;
		activePath: string | null;
		/** Absolute path of the project's main entry .tex (badged in the tree), or null. */
		mainPath?: string | null;
		/** Per-file git status badges, keyed by gitKey(path). Empty when not a repo. */
		gitStatus?: Record<string, GitBadge>;
		onOpen: (entry: TreeEntry) => void;
		/** type 'include' creates a fragment (.tex or .typ per the compile target) AND inserts a
		 * reference for it at the cursor. */
		onCreate: (parentDir: string, name: string, type: 'file' | 'dir' | 'include') => void;
		/** the compile target is Typst: the New Include hint speaks #include, not \input */
		typstProject?: boolean;
		onRename: (entry: TreeEntry, newName: string) => void;
		/** several entries at once when a multi-selection is deleted/dragged. */
		onDelete: (entries: TreeEntry[]) => void;
		onMove: (entries: TreeEntry[], targetDir: string) => void;
		/** files dropped from the OS file manager or pasted from the clipboard. */
		onImport?: (items: ImportItem[], targetDir: string) => void;
		/** absolute paths dragged in from ANOTHER Texpile window; the drop copies them here. */
		onCopyIn?: (paths: string[], targetDir: string) => void;
		/** Set (or, if already main, clear) the project's main entry file. */
		onSetMain?: (entry: TreeEntry) => void;
		/** select the entry in the OS file manager. Omitted outside the desktop shell. */
		onReveal?: (entry: TreeEntry) => void;
		/** the tree's own undo/redo stack for FILE operations - never the editor's text history. */
		history?: FileHistory | null;
		/** guest session: browse + open only, no rename/delete/internal-move. */
		/** allow adding new files by drop-from-OS / paste (true even for a read-only guest). */
		allowImport?: boolean;
	}
	let {
		tree,
		rootPath,
		activePath,
		mainPath = null,
		gitStatus = {},
		onOpen,
		onCreate,
		typstProject = false,
		onRename,
		onDelete,
		onMove,
		onImport,
		onCopyIn,
		onSetMain,
		onReveal,
		history = null,
		allowImport = true
	}: Props = $props();

	interface ImportItem {
		/** destination path relative to the drop/paste target dir (forward slashes). */
		relPath: string;
		file: globalThis.File;
	}

	// samePath, not ===: activePath is the only path here that the tree did not produce itself, so
	// it is the only one that can arrive in a different FORM. A restored workspace builds it by
	// joining a remembered relative path onto the root, and on Windows that used to come back
	// mixed-separator, matching no entry and leaving the open file unhighlighted.
	const isActive = (e: TreeEntry) => !!activePath && samePath(activePath, e.path);

	// .typ can be a main file too: the typst preview and PDF export both target mainFile ?? open file
	const isMainable = (e: TreeEntry) => e.type === 'file' && /\.(tex|typ)$/i.test(e.name);
	const isMain = (e: TreeEntry) => !!mainPath && e.path.replace(/\\/g, '/').toLowerCase() === mainPath.replace(/\\/g, '/').toLowerCase();

	// Git status badge (VS Code convention: a single colored letter). Only files carry one.
	const gitBadge = (e: TreeEntry): GitBadge | undefined => (e.type === 'file' ? gitStatus[gitKey(e.path)] : undefined);
	const BADGE_COLOR: Record<GitBadge, string> = {
		M: 'text-amber-500',
		A: 'text-green-500',
		D: 'text-red-500',
		U: 'text-sky-500',
		R: 'text-violet-500'
	};
	const BADGE_TITLE: Record<GitBadge, string> = {
		M: m.filetree_badge_modified(),
		A: m.filetree_badge_added(),
		D: m.filetree_badge_deleted(),
		U: m.filetree_badge_untracked(),
		R: m.filetree_badge_renamed()
	};

	let expanded = $state<Record<string, boolean>>({});
	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	let renameEdited = $state(false);
	let creatingIn = $state<string | null>(null);
	let createType = $state<'file' | 'dir' | 'include'>('file');
	let createValue = $state('');
	let createEdited = $state(false); // did the user actually type, or is this still our pre-fill?

	// ---- selection (ctrl/cmd toggles, shift ranges over the visible order) ----
	let selected = $state<string[]>([]);

	// The tree's SELECTION is its own state, separate from which file is open: clicking a row
	// leaves it selected (grey) so the context menu and multi-file drag have something to act on.
	// But changing file from anywhere else -- the tab bar, Ctrl+K, a SyncTeX jump -- left that grey
	// behind on the row you last clicked, which reads as a hover stuck under a cursor that moved
	// away long ago. Drop it, unless the newly opened file is itself in the selection: a plain row
	// click selects and opens in one gesture, and that selection has to survive its own open.
	$effect(() => {
		const a = activePath;
		if (!a) return;
		untrack(() => {
			if (!selected.some((p) => samePath(p, a))) selected = [];
		});
	});
	let anchorPath: string | null = null; // shift-range pivot; the last plain/ctrl-clicked row

	/** the tree in on-screen order, honouring which folders are expanded (shift-range domain). */
	function flattenVisible(entries: TreeEntry[] = tree, out: TreeEntry[] = []): TreeEntry[] {
		for (const e of entries) {
			out.push(e);
			if (e.type === 'dir' && expanded[e.path]) flattenVisible(e.children ?? [], out);
		}
		return out;
	}
	function findEntry(path: string, entries: TreeEntry[] = tree): TreeEntry | null {
		for (const e of entries) {
			if (e.path === path) return e;
			if (e.type === 'dir') {
				const hit = findEntry(path, e.children ?? []);
				if (hit) return hit;
			}
		}
		return null;
	}
	/** the selected entries with nested ones pruned: moving/deleting a folder covers its children,
	 *  and handling a child separately after its parent moved would act on a dead path. */
	function selectedEntries(): TreeEntry[] {
		const paths = selected.filter((p) => !selected.some((other) => other !== p && isInside(p, other)));
		return paths.map((p) => findEntry(p)).filter((e): e is TreeEntry => !!e);
	}
	function handleRowClick(e: MouseEvent, entry: TreeEntry) {
		if (e.ctrlKey || e.metaKey) {
			selected = selected.includes(entry.path) ? selected.filter((p) => p !== entry.path) : [...selected, entry.path];
			anchorPath = entry.path;
			return;
		}
		if (e.shiftKey && anchorPath) {
			const order = flattenVisible().map((x) => x.path);
			const a = order.indexOf(anchorPath);
			const b = order.indexOf(entry.path);
			if (a >= 0 && b >= 0) {
				selected = order.slice(Math.min(a, b), Math.max(a, b) + 1);
				return;
			}
		}
		selected = [entry.path];
		anchorPath = entry.path;
		if (entry.type === 'dir') expanded[entry.path] = !expanded[entry.path];
		else onOpen(entry);
	}

	// ---- drag & drop: internal moves and OS-file imports ----
	let dragging = $state<TreeEntry | null>(null);
	let dragPaths = $state<string[]>([]); // everything the drag carries (the multi-selection)
	let dropTarget = $state<string | null>(null); // the DIRECTORY that would receive the drop, or ROOT
	const ROOT = '__root__';

	const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');
	const parentOf = (p: string) => {
		const i = p.lastIndexOf(sepOf(p));
		return i >= 0 ? p.slice(0, i) : p;
	};
	// dropping on a folder targets it; dropping on a file targets its parent folder
	const dropDir = (entry: TreeEntry) => (entry.type === 'dir' ? entry.path : parentOf(entry.path));
	const isInside = (path: string, ancestor: string) => path.startsWith(ancestor + sepOf(ancestor));
	// a target is valid when no dragged item IS it or contains it
	const canDropAll = (target: string) => dragPaths.length > 0 && dragPaths.every((p) => target !== p && !isInside(target, p));
	/** a drag that comes from outside the app (OS file manager) rather than a tree row. */
	const isExternalDrag = (e: DragEvent) => !dragging && !!e.dataTransfer?.types?.includes('Files');
	// A tree drag from ANOTHER Texpile window: our own `dragging` is null, but the payload
	// carries this MIME tag. Only the TYPE is readable during dragover (drag data is sealed
	// until drop, by spec), which is exactly why the tag exists: it identifies the drag
	// without seeing the data, and plain editor text drags don't false-positive.
	const PATHS_MIME = 'application/x-texpile-paths';
	const isCrossWindowDrag = (e: DragEvent) => !dragging && !!e.dataTransfer?.types?.includes(PATHS_MIME);
	// ring the row of the receiving DIRECTORY (not whatever row the pointer is on)
	const markTarget = (dir: string) => {
		dropTarget = dir === rootPath ? ROOT : dir;
	};

	function onRowDragStart(e: DragEvent, entry: TreeEntry) {
		// dragging an unselected row abandons the selection and drags just that row
		if (!selected.includes(entry.path)) {
			selected = [entry.path];
			anchorPath = entry.path;
		}
		dragging = entry;
		dragPaths = selectedEntries().map((x) => x.path);
		if (e.dataTransfer) {
			// move within this window; a drop in another window's tree copies instead
			e.dataTransfer.effectAllowed = 'copyMove';
			e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
			e.dataTransfer.setData(PATHS_MIME, JSON.stringify(dragPaths));
		}
	}
	function onRowDragOver(e: DragEvent, entry: TreeEntry) {
		const dir = dropDir(entry);
		if (isExternalDrag(e) || isCrossWindowDrag(e)) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			markTarget(dir);
			return;
		}
		if (!canDropAll(dir)) return;
		e.preventDefault();
		e.stopPropagation(); // the container's handler would re-target the drop to ROOT
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		markTarget(dir);
	}
	function onRowDrop(e: DragEvent, entry: TreeEntry) {
		e.preventDefault();
		e.stopPropagation();
		finishDrop(e, dropDir(entry));
	}
	function onRootDragOver(e: DragEvent) {
		if (isExternalDrag(e) || isCrossWindowDrag(e)) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			dropTarget = ROOT;
			return;
		}
		if (!canDropAll(rootPath)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTarget = ROOT;
	}
	function onRootDrop(e: DragEvent) {
		e.preventDefault();
		finishDrop(e, rootPath);
	}
	function finishDrop(e: DragEvent, targetDir: string) {
		const external = isExternalDrag(e);
		const crossWindow = isCrossWindowDrag(e);
		const entries = dragging ? selectedEntries() : [];
		const valid = canDropAll(targetDir);
		dragging = null;
		dragPaths = [];
		dropTarget = null;
		if (crossWindow) {
			// a tree drag from another Texpile window: the data is readable now (drop), and
			// the drop COPIES so the source window's workspace is never mutated behind its back
			let paths: string[] = [];
			try {
				paths = JSON.parse(e.dataTransfer?.getData(PATHS_MIME) || '[]');
			} catch {
				/* malformed payload: ignore the drop */
			}
			const safe = paths.filter((p) => typeof p === 'string' && p && targetDir !== p && !isInside(targetDir, p));
			if (safe.length) onCopyIn?.(safe, targetDir);
		} else if (external) {
			void collectDropItems(e).then((items) => {
				if (items.length) onImport?.(items, targetDir);
			});
		} else if (entries.length && valid) {
			onMove(entries, targetDir);
		}
	}
	// clearing on the container, not per row: leaving one row for the next fires a dragleave
	// that would blank the ring mid-drag; only a true exit of the panel clears it
	function onTreeDragLeave(e: DragEvent) {
		const to = e.relatedTarget as Node | null;
		if (!to || !(e.currentTarget as HTMLElement).contains(to)) dropTarget = null;
	}
	function onDragEnd() {
		dragging = null;
		dragPaths = [];
		dropTarget = null;
	}

	// ---- OS-file imports (drop from the system file manager, or clipboard paste) ----
	// walks dropped directories via the webkitGetAsEntry tree so folder drops import their
	// contents; reads file BYTES (no OS paths involved), which also works for clipboard files
	async function collectDropItems(e: DragEvent): Promise<ImportItem[]> {
		const out: ImportItem[] = [];
		const items = [...(e.dataTransfer?.items ?? [])];
		const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
		if (!entries.length) {
			for (const f of e.dataTransfer?.files ?? []) out.push({ relPath: f.name, file: f });
			return out;
		}
		const readAll = (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
			new Promise((resolve) => {
				const reader = dir.createReader();
				const acc: FileSystemEntry[] = [];
				const step = () =>
					reader.readEntries(
						(batch) => {
							if (!batch.length) return resolve(acc);
							acc.push(...batch);
							step(); // readEntries returns at most ~100 per call
						},
						() => resolve(acc)
					);
				step();
			});
		const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
			if (entry.isFile) {
				const f = await new Promise<globalThis.File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)).catch(
					() => null
				);
				if (f) out.push({ relPath: prefix + entry.name, file: f });
			} else if (entry.isDirectory) {
				for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, prefix + entry.name + '/');
			}
		};
		for (const entry of entries) await walk(entry, '');
		return out;
	}

	/** paste lands in the single selected folder, else the workspace root */
	function pasteTargetDir(): string {
		const sel = selectedEntries();
		return sel.length === 1 && sel[0].type === 'dir' ? sel[0].path : rootPath;
	}

	// Ctrl+V while the editor doesn't own focus: save clipboard files/images into the tree.
	// A pasted screenshot arrives as a nameless "image.png"; give it a recognizable name.
	function onPaste(e: ClipboardEvent) {
		if (!allowImport || !onImport) return;
		const el = e.target as HTMLElement | null;
		if (el?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) return;
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.length) return;
		e.preventDefault();
		const items = files.map((f, i) => {
			let name = f.name || 'pasted-image.png';
			if (/^image\.(png|jpe?g|gif|webp)$/i.test(name)) name = name.replace(/^image/i, 'pasted-image');
			if (files.length > 1 && files.every((x) => x.name === files[0].name)) name = name.replace(/(\.[^.]+)$/, `-${i + 1}$1`);
			return { relPath: name, file: f };
		});
		onImport(items, pasteTargetDir());
	}

	// ---- copy / paste WITHIN the tree ----
	// Its own clipboard of absolute paths, not the OS one. Reading real file paths back out of a
	// system clipboard is not something a renderer can do, and putting the BYTES on it would mean
	// loading every selected file into memory to copy a folder. Paste reuses onCopyIn, which is the
	// same fs-side recursive copy a drag from another window already performs.
	let clipboard = $state<string[]>([]);
	const canPaste = $derived(clipboard.length > 0 && !!onCopyIn);

	function copySelection() {
		const paths = selectedEntries().map((e) => e.path);
		if (!paths.length) return;
		clipboard = paths;
		toaster.success({
			title:
				paths.length === 1 ? m.filetree_toast_copied_one({ count: paths.length }) : m.filetree_toast_copied_other({ count: paths.length })
		});
	}

	function pasteClipboard(targetDir = pasteTargetDir()) {
		// the same containment rule the drop path applies: a folder cannot be pasted into itself
		const safe = clipboard.filter((p) => targetDir !== p && !isInside(targetDir, p));
		if (safe.length) onCopyIn?.(safe, targetDir);
	}

	// The tree's keyboard shortcuts are scoped to the tree HAVING FOCUS, which matters most for
	// Ctrl+Z: the editor owns a text history on the same keystroke, and a file delete must never be
	// what Ctrl+Z takes back while the caret is in a document. Row buttons are focusable, so a
	// clicked row puts activeElement inside this container.
	let treeEl = $state<HTMLElement | null>(null);
	/**
	 * Whether the keyboard belongs to the tree. Drives BOTH the shortcut guard and the active row's
	 * highlight, deliberately from one source: the colour is a promise that Ctrl+Z will act on files
	 * here, and two separate notions of "focused" could disagree and turn it into a lie.
	 */
	let focused = $state(false);

	/**
	 * Put focus back on the tree after an action that took it away.
	 *
	 * Without this the shortcuts are close to unusable in the flow that wants them most: deleting
	 * goes through a confirm dialog, and dismissing one leaves focus on the dialog's trigger or the
	 * body - so the Ctrl+Z immediately afterwards, the whole point of having an undo, would land on
	 * nothing. The container carries tabindex="-1" purely so it can be focused programmatically like
	 * this; it stays out of the Tab order.
	 */
	const refocusTree = () => queueMicrotask(() => treeEl?.focus({ preventScroll: true }));

	function onTreeKeydown(e: KeyboardEvent) {
		if (!focused || !(e.ctrlKey || e.metaKey) || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k === 'c') {
			e.preventDefault();
			copySelection();
		} else if (k === 'v') {
			// only claim the keystroke when there is something of ours to paste; otherwise let it
			// through so the paste EVENT still fires and OS-clipboard files import as before
			if (!canPaste) return;
			e.preventDefault();
			pasteClipboard();
		} else if (k === 'z' && !e.shiftKey) {
			e.preventDefault();
			void history?.undo();
		} else if (k === 'y' || (k === 'z' && e.shiftKey)) {
			e.preventDefault();
			void history?.redo();
		}
	}

	let ctxMenu = $state<{ x: number; y: number; entry: TreeEntry | null } | null>(null);
	function openCtx(e: MouseEvent, entry: TreeEntry | null) {
		e.preventDefault();
		e.stopPropagation();
		// right-clicking outside the selection retargets it (the menu acts on what's selected)
		if (entry && !selected.includes(entry.path)) {
			selected = [entry.path];
			anchorPath = entry.path;
		}
		// keep the menu on-screen near the bottom/right edges. The height is the fullest the menu
		// gets - new file/folder/include, copy, paste, reveal, undo, redo, set main, rename, delete
		const x = Math.min(e.clientX, window.innerWidth - 184);
		const y = Math.min(e.clientY, window.innerHeight - 340);
		ctxMenu = { x, y, entry };
	}
	const ctxTargetDir = () => (ctxMenu?.entry?.type === 'dir' ? ctxMenu.entry.path : rootPath);

	/**
	 * Close the menu and hand focus back to the tree, so its shortcuts still work afterwards.
	 *
	 * Safe even for the items that open an inline name input: refocusTree lands in a microtask, and
	 * focusSelect re-grabs on the next animation frame precisely to survive this kind of contention.
	 */
	function closeCtx() {
		ctxMenu = null;
		refocusTree();
	}

	// focus on mount and select the base name (keep the extension, like VSCode).
	function focusSelect(node: HTMLInputElement) {
		const grab = () => {
			node.focus();
			const dot = node.value.lastIndexOf('.');
			if (dot > 0) node.setSelectionRange(0, dot);
			else node.select();
		};
		grab();
		// Skeleton's menu (Zag) refocuses its trigger in a queueMicrotask as it closes, which lands
		// just after we mount and takes the field away before the user can type. Grab it back once,
		// on the next frame, only if something actually took it. Deliberately NOT a re-assert loop:
		// that was tried, and it made the field impossible to leave.
		requestAnimationFrame(() => {
			if (node.isConnected && document.activeElement !== node) grab();
		});
	}

	function startCreate(dir: string, type: 'file' | 'dir' | 'include', defaultName = '') {
		creatingIn = dir;
		createType = type;
		createValue = defaultName;
		createEdited = false;
		if (dir !== rootPath) expanded[dir] = true;
	}
	/** begins creating a file/folder/include at the workspace root; defaultName pre-fills the input. */
	export function newAtRoot(type: 'file' | 'dir' | 'include', defaultName = '') {
		startCreate(rootPath, type, defaultName);
	}
	/** true while an inline name input is open, so callers don't rebuild the tree out from under it. */
	export function isEditing() {
		return creatingIn !== null || renaming !== null;
	}
	function commitCreate() {
		const v = createValue.trim();
		const dir = creatingIn;
		creatingIn = null;
		createValue = '';
		if (v && dir) onCreate(dir, v, createType);
	}
	// Blur is not consent: an untouched field losing focus means dismiss, not "accept the pre-fill".
	// But a menu closing hands focus back to its trigger a tick after we mount (Skeleton/Zag), and
	// focusSelect re-grabs it one frame later. So defer the decision a frame: if focus genuinely
	// left the field, dismiss it; if it came back (spurious refocus, or the window just blurred),
	// leave it. Directly checking activeElement beats a time window.
	function blurCreate(e: FocusEvent) {
		if (createEdited) {
			commitCreate();
			return;
		}
		const input = e.currentTarget as HTMLElement;
		requestAnimationFrame(() => {
			if (creatingIn !== null && document.activeElement !== input) cancelCreate();
		});
	}
	function cancelCreate() {
		creatingIn = null;
		createValue = '';
	}
	function startRename(e: TreeEntry) {
		renaming = e.path;
		renameValue = e.name;
		renameEdited = false;
	}
	function commitRename(e: TreeEntry) {
		if (renaming !== e.path) return; // guard against Enter + blur double-firing
		renaming = null;
		const v = renameValue.trim();
		if (v && v !== e.name) onRename(e, v);
	}
	/** same deferred-dismiss reasoning as blurCreate. */
	function blurRename(e: FocusEvent, entry: TreeEntry) {
		if (renameEdited) {
			commitRename(entry);
			return;
		}
		const input = e.currentTarget as HTMLElement;
		requestAnimationFrame(() => {
			if (renaming === entry.path && document.activeElement !== input) renaming = null;
		});
	}
	async function confirmDelete(e: TreeEntry) {
		// the confirm dialog takes focus and hands it back to its own trigger, so the tree has to
		// claim it again - otherwise the Ctrl+Z that undoes this delete would go nowhere
		// deleting a row that's part of a multi-selection deletes the whole selection
		if (selected.includes(e.path) && selectedEntries().length > 1) {
			const entries = selectedEntries();
			if (
				await confirmAsk(m.filetree_confirm_delete_many({ count: entries.length }), { confirmLabel: m.filetree_delete(), danger: true })
			) {
				onDelete(entries);
				selected = [];
			}
			refocusTree();
			return;
		}
		const message = e.type === 'dir' ? m.filetree_confirm_delete_dir({ name: e.name }) : m.filetree_confirm_delete_file({ name: e.name });
		if (await confirmAsk(message, { confirmLabel: m.filetree_delete(), danger: true })) onDelete([e]);
		refocusTree();
	}
	/** how many rows a delete from this entry would remove (for the context-menu label). */
	const deleteCount = (e: TreeEntry) => (selected.includes(e.path) ? selectedEntries().length : 1);
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key !== 'Escape') {
			onTreeKeydown(e);
			return;
		}
		// escape hatch even if the inline input lost focus
		if (ctxMenu) closeCtx();
		else if (creatingIn !== null) cancelCreate();
		else if (renaming !== null) renaming = null;
		else if (selected.length) selected = [];
	}}
	onpaste={onPaste}
/>

{#snippet createInput(depth: number)}
	<div class="flex items-center gap-1 py-0.5" style="padding-left: {depth * 12 + 6}px">
		<!-- the icon previews what the row is about to become, so it tracks the name as it is typed
		     (an empty name falls through to the generic document glyph) -->
		{#if createType === 'dir'}<FileIcon name="" folder="closed" class="size-4 shrink-0" />{:else if createType === 'include'}<FileSymlink
				class="text-surface-400 size-4 shrink-0"
			/>{:else}<FileIcon name={createValue} class="size-4 shrink-0" />{/if}
		<input
			class="input h-6 flex-1 py-0 text-sm"
			placeholder={createType === 'dir'
				? m.filetree_placeholder_folder_name()
				: createType === 'include'
					? m.filetree_placeholder_include_name()
					: m.filetree_placeholder_file_name()}
			value={createValue}
			oninput={(e) => {
				createValue = e.currentTarget.value;
				createEdited = true;
			}}
			use:focusSelect
			draggable="false"
			onpointerdown={(e) => e.stopPropagation()}
			onkeydown={(e) => {
				if (e.key === 'Enter') commitCreate();
				else if (e.key === 'Escape') cancelCreate();
			}}
			onblur={blurCreate}
		/>
	</div>
{/snippet}

{#snippet row(entry: TreeEntry, depth: number)}
	<div>
		<!-- The open file keeps its tint whatever has focus, so you can always see WHICH file is open;
		     only the accent TEXT is conditional. That makes the colour say something the tree could
		     not otherwise show: blue here means Ctrl+Z acts on files, not on your document. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="group flex items-center rounded text-sm transition-colors {isActive(entry)
				? `bg-primary-500/15 font-medium ${focused ? 'text-primary-700 dark:text-primary-300' : ''}`
				: selected.includes(entry.path)
					? 'bg-surface-300-700/60'
					: 'hover:bg-surface-200-800'} {dropTarget === entry.path && entry.type === 'dir'
				? 'ring-primary-500 ring-2 ring-inset'
				: ''} {dragPaths.includes(entry.path) ? 'opacity-50' : ''}"
			draggable={renaming !== entry.path}
			ondragstart={(e) => onRowDragStart(e, entry)}
			ondragover={(e) => onRowDragOver(e, entry)}
			ondrop={(e) => onRowDrop(e, entry)}
			ondragend={onDragEnd}
			oncontextmenu={(e) => openCtx(e, entry)}
		>
			<button
				class="flex min-w-0 flex-1 items-center gap-1 py-0.5"
				style="padding-left: {depth * 12 + 4}px"
				onclick={(e) => handleRowClick(e, entry)}
				ondblclick={() => entry.type === 'file' && onOpen(entry)}
			>
				{#if entry.type === 'dir'}
					{#if expanded[entry.path]}<ChevronDown class="text-surface-400 size-3.5 shrink-0" />{:else}<ChevronRight
							class="text-surface-400 size-3.5 shrink-0"
						/>{/if}
					<FileIcon name={entry.name} folder={expanded[entry.path] ? 'open' : 'closed'} class="size-4 shrink-0" />
				{:else}
					<span class="w-3.5 shrink-0"></span>
					<FileIcon name={entry.name} class="size-4 shrink-0" />
				{/if}
				{#if renaming === entry.path}
					<input
						class="input h-6 min-w-0 flex-1 py-0 text-sm"
						value={renameValue}
						oninput={(e) => {
							renameValue = e.currentTarget.value;
							renameEdited = true;
						}}
						use:focusSelect
						draggable="false"
						onpointerdown={(e) => e.stopPropagation()}
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							if (e.key === 'Enter') commitRename(entry);
							else if (e.key === 'Escape') renaming = null;
						}}
						onblur={(e) => blurRename(e, entry)}
					/>
				{:else}
					<span class="truncate">{entry.name}</span>
					{#if isMain(entry)}
						<Star class="fill-primary-500 text-primary-500 size-3 shrink-0" aria-label={m.filetree_main_file_label()} />
					{/if}
					{#if gitBadge(entry)}
						{@const b = gitBadge(entry)}
						<!-- stays put on hover and is pushed left by the buttons appearing beside it. Fading
						     it out instead read as a flicker, and left the trash standing where the badge had
						     been without lining up with the badges on the rows above. -->
						<span class="ml-auto shrink-0 pr-1 font-mono text-xs font-bold {b ? BADGE_COLOR[b] : ''}" title={b ? BADGE_TITLE[b] : ''}
							>{b}</span
						>
					{/if}
				{/if}
			</button>
			{#if renaming !== entry.path}
				<!-- `hidden`, not opacity-0: as a permanently-laid-out sibling it reserved its width on
				     every row, holding the git badge in off the right edge - a big share of a narrow
				     sidebar's row. Out of flow when idle, in flow on hover, so the badge sits at the edge
				     and gets pushed left rather than vanishing under the buttons. -->
				<div class="hidden shrink-0 items-center gap-0.5 pr-1 group-hover:flex">
					{#if entry.type === 'dir'}
						<button
							class="btn-icon btn-icon-xs hover:preset-tonal"
							title={m.filetree_new_file_title()}
							onclick={() => startCreate(entry.path, 'file')}
						>
							<FilePlus class="size-3.5" />
						</button>
					{/if}
					<button class="btn-icon btn-icon-xs hover:preset-tonal" title={m.filetree_rename()} onclick={() => startRename(entry)}>
						<Pencil class="size-3.5" />
					</button>
					<button class="btn-icon btn-icon-xs hover:preset-tonal-error" title={m.filetree_delete()} onclick={() => confirmDelete(entry)}>
						<Trash2 class="size-3.5" />
					</button>
				</div>
			{/if}
		</div>

		{#if entry.type === 'dir' && expanded[entry.path]}
			{#if creatingIn === entry.path}{@render createInput(depth + 1)}{/if}
			{#each entry.children ?? [] as child (child.path)}
				{@render row(child, depth + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

<!-- empty-space drops and right-clicks target the workspace root; clicking empty space clears
     the selection (Escape is the keyboard path for that, see the window handler above) -->
<div
	bind:this={treeEl}
	role="presentation"
	tabindex="-1"
	class="min-h-full rounded outline-none {dropTarget === ROOT ? 'ring-primary-500 ring-2 ring-inset' : ''}"
	onfocusin={() => (focused = true)}
	onfocusout={(e) => {
		// relatedTarget is where focus is HEADING; moving between two rows must not read as leaving
		if (!treeEl?.contains(e.relatedTarget as Node | null)) focused = false;
	}}
	ondragover={onRootDragOver}
	ondragleave={onTreeDragLeave}
	ondrop={onRootDrop}
	onclick={(e) => {
		if (e.target === e.currentTarget) selected = [];
	}}
	oncontextmenu={(e) => openCtx(e, null)}
>
	{#if creatingIn === rootPath}{@render createInput(0)}{/if}
	{#each tree as entry (entry.path)}
		{@render row(entry, 0)}
	{/each}
</div>

{#if ctxMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50"
		onpointerdown={() => (ctxMenu = null)}
		oncontextmenu={(e) => {
			e.preventDefault();
			closeCtx();
		}}
	></div>
	<div
		class="bg-surface-50-950 border-surface-300-700 fixed z-50 min-w-[11rem] overflow-hidden rounded border py-1 text-sm shadow-lg"
		style="left: {ctxMenu.x}px; top: {ctxMenu.y}px"
	>
		{#if !ctxMenu.entry || ctxMenu.entry.type === 'dir'}
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					const d = ctxTargetDir();
					closeCtx();
					startCreate(d, 'file');
				}}
			>
				<FilePlus class="text-surface-500 size-4" />
				{m.filetree_menu_new_file()}
			</button>
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					const d = ctxTargetDir();
					closeCtx();
					startCreate(d, 'dir');
				}}
			>
				<FolderPlus class="text-surface-500 size-4" />
				{m.filetree_menu_new_folder()}
			</button>
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					const d = ctxTargetDir();
					closeCtx();
					startCreate(d, 'include');
				}}
				title={typstProject ? m.filetree_new_include_hint_typst() : m.filetree_new_include_hint()}
			>
				<FileSymlink class="text-surface-500 size-4" />
				{m.filetree_menu_new_include()}
			</button>
		{/if}
		{#if ctxMenu.entry && deleteCount(ctxMenu.entry) === 1 && isMainable(ctxMenu.entry) && onSetMain}
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					const e = ctxMenu.entry;
					closeCtx();
					if (e) onSetMain?.(e);
				}}
			>
				<Star class="text-surface-500 size-4 {ctxMenu.entry && isMain(ctxMenu.entry) ? 'fill-primary-500 text-primary-500' : ''}" />
				{ctxMenu.entry && isMain(ctxMenu.entry) ? m.filetree_menu_unset_main() : m.filetree_menu_set_main()}
			</button>
		{/if}
		{#if ctxMenu.entry}
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					closeCtx();
					copySelection();
				}}
			>
				<Copy class="text-surface-500 size-4" />
				{m.filetree_menu_copy()}
			</button>
		{/if}
		{#if canPaste}
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					// right-clicking a FOLDER pastes into it; anywhere else uses the selection rule
					const d = ctxMenu?.entry?.type === 'dir' ? ctxMenu.entry.path : null;
					closeCtx();
					pasteClipboard(d ?? pasteTargetDir());
				}}
			>
				<ClipboardPaste class="text-surface-500 size-4" />
				{m.filetree_menu_paste()}
			</button>
		{/if}
		{#if ctxMenu.entry && onReveal && deleteCount(ctxMenu.entry) === 1}
			<button
				class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					const e = ctxMenu.entry;
					closeCtx();
					if (e) onReveal?.(e);
				}}
			>
				<FolderOpen class="text-surface-500 size-4" />
				{m.filetree_menu_reveal()}
			</button>
		{/if}
		{#if history && (history.canUndo || history.canRedo)}
			<!-- Something always precedes this group - right-clicking a file shows Copy, anywhere else
			     shows the New File block - so the LEADING rule is unconditional. -->
			<div class="border-surface-200-800 my-1 border-t"></div>
			{#if history.canUndo}
				<button
					class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
					onclick={() => {
						closeCtx();
						void history?.undo();
					}}
				>
					<Undo2 class="text-surface-500 size-4" />
					<span class="truncate">{m.filetree_menu_undo({ what: history.undoLabel ?? '' })}</span>
				</button>
			{/if}
			{#if history.canRedo}
				<button
					class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
					onclick={() => {
						closeCtx();
						void history?.redo();
					}}
				>
					<Redo2 class="text-surface-500 size-4" />
					<span class="truncate">{m.filetree_menu_redo({ what: history.redoLabel ?? '' })}</span>
				</button>
			{/if}
			<!-- ...but the TRAILING one only when Rename/Delete follow it. Right-clicking empty space
			     shows neither, and an unconditional rule then drew a stray line across the bottom of
			     the menu with nothing under it. Guarded rather than hidden with CSS, so the menu is
			     correct as markup instead of relying on a `last:` variant surviving the build. -->
			{#if ctxMenu.entry}
				<div class="border-surface-200-800 my-1 border-t"></div>
			{/if}
		{/if}
		{#if ctxMenu.entry}
			{#if deleteCount(ctxMenu.entry) === 1}
				<button
					class="hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
					onclick={() => {
						const e = ctxMenu.entry;
						closeCtx();
						if (e) startRename(e);
					}}
				>
					<Pencil class="text-surface-500 size-4" />
					{m.filetree_rename()}
				</button>
			{/if}
			<button
				class="hover:preset-tonal-error text-error-600 flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
				onclick={() => {
					const e = ctxMenu.entry;
					closeCtx();
					if (e) confirmDelete(e);
				}}
			>
				<Trash2 class="size-4" />
				{deleteCount(ctxMenu.entry) > 1 ? m.filetree_delete_many({ count: deleteCount(ctxMenu.entry) }) : m.filetree_delete()}
			</button>
		{/if}
	</div>
{/if}
