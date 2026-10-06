<script lang="ts">
	// The left sidebar: folder header + explorer / source-control / find-in-files, with the file
	// tree and (in explorer) a resizable table-of-contents. Presentational — logic stays in the view.
	import FileTree from './FileTree.svelte';
	import GlobalSearch from './GlobalSearch.svelte';
	import SourceControlPanel from './SourceControlPanel.svelte';
	import TableOfContents from './TableOfContents.svelte';
	import { workspaceRoot, fileTree, activeFilePath, mainFile } from '$lib/workspace/workspaceStore';
	import { isGitRepo, gitBranch, gitChanges, gitStatusMap } from '$lib/workspace/gitStore';
	import { basename, type TreeEntry } from '$lib/workspace/fileSystem';
	import type { FileHistory } from '$lib/workspace/fileHistory.svelte';
	import type { GitStatusEntry } from '$lib/workspace/git';
	import { m } from '$lib/paraglide/messages';
	import { FilePlus, FolderPlus, RefreshCw, GitBranch, Search } from '@lucide/svelte';

	interface Props {
		width: number;
		modLabel: string;
		view: 'explorer' | 'scm' | 'search';
		scmBusy: boolean;
		showToc: boolean;
		tocFraction: number;
		viewMode: 'visual' | 'source' | 'diff';
		fileTreeRef?: { newAtRoot: (type: 'file' | 'dir' | 'include', defaultName?: string) => void; isEditing: () => boolean };
		globalSearchRef?: GlobalSearch | null;
		splitEl?: HTMLDivElement;
		onRefreshTree: () => void;
		onOpenGlobalSearch: () => void;
		onCloseGlobalSearch: () => void;
		onOpenFileAt: (file: string, line: number, selectText?: string) => void;
		onOpenEntry: (entry: TreeEntry) => void;
		onCreate: (parentDir: string, name: string, type: 'file' | 'dir' | 'include') => void;
		/** the compile target is Typst: the tree's New Include creates a .typ fragment */
		typstProject?: boolean;
		onRename: (entry: TreeEntry, newName: string) => void;
		onDelete: (entries: TreeEntry[]) => void;
		onMove: (entries: TreeEntry[], targetDir: string) => void;
		onImport: (items: { relPath: string; file: globalThis.File }[], targetDir: string) => void;
		onCopyIn: (paths: string[], targetDir: string) => void;
		onSetMain: (entry: TreeEntry) => void;
		onReveal: (entry: TreeEntry) => void;
		/** the file tree's own undo/redo stack, kept separate from the editor's text history. */
		fileHistory: FileHistory | null;
		onStartTocResize: (e: MouseEvent) => void;
		onResizeTocByKey: (e: KeyboardEvent) => void;
		onRefreshGit: () => void;
		scmInit: () => void;
		scmStage: (paths: string[]) => void;
		scmUnstage: (paths: string[]) => void;
		scmDiscard: (changes: GitStatusEntry[]) => void;
		scmCommit: (message: string) => Promise<boolean>;
		scmOpenDiff: (path: string) => void;
	}
	let {
		width,
		modLabel,
		view = $bindable(),
		scmBusy,
		showToc,
		tocFraction,
		viewMode,
		fileTreeRef = $bindable(),
		globalSearchRef = $bindable(),
		splitEl = $bindable(),
		onRefreshTree,
		onOpenGlobalSearch,
		onCloseGlobalSearch,
		onOpenFileAt,
		onOpenEntry,
		onCreate,
		typstProject = false,
		onRename,
		onDelete,
		onMove,
		onImport,
		onCopyIn,
		onSetMain,
		onReveal,
		fileHistory,
		onStartTocResize,
		onResizeTocByKey,
		onRefreshGit,
		scmInit,
		scmStage,
		scmUnstage,
		scmDiscard,
		scmCommit,
		scmOpenDiff
	}: Props = $props();
</script>

<!-- Escape leaves the Source Control / Find-in-files views and returns to the file tree, the same way
     it dismisses the tree's own context menu. Skipped while a text field has focus, so Escape in the
     commit message or the search box is not a trapdoor out of the panel you are typing into. -->
<svelte:window
	onkeydown={(e) => {
		if (e.key !== 'Escape' || view === 'explorer') return;
		const el = document.activeElement;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable) return;
		e.preventDefault();
		if (view === 'search') onCloseGlobalSearch();
		view = 'explorer';
	}}
/>

<!-- no border-r: the splitter beside it draws its own 1px, and a border as well read as two -->
<aside class="bg-surface-50-950 flex shrink-0 flex-col" style="width: {width}px">
	<!-- shrink-0: h-12 sets a height, it does not defend one. A flex child shrinks below its height
	     whenever the column overflows, so any view below that asks for more room than is left takes
	     it out of this row - and a title bar that changes height as you switch views reads as the
	     whole layout twitching. -->
	<div class="border-surface-200-800 flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
		<span class="truncate text-sm font-semibold" title={$workspaceRoot ?? ''}>
			{$workspaceRoot ? basename($workspaceRoot) : m.wsview_no_folder()}
		</span>
		<div class="flex items-center gap-1">
			<button
				class="btn-icon btn-icon-xs workbench-shell-quiet-hover"
				title={m.wsview_new_file_title()}
				onclick={() => fileTreeRef?.newAtRoot('file')}
			>
				<FilePlus class="size-4" />
			</button>
			<button
				class="btn-icon btn-icon-xs workbench-shell-quiet-hover"
				title={m.wsview_new_folder_title()}
				onclick={() => fileTreeRef?.newAtRoot('dir')}
			>
				<FolderPlus class="size-4" />
			</button>
			<button class="btn-icon btn-icon-xs workbench-shell-quiet-hover" title={m.wsview_refresh_tree_title()} onclick={onRefreshTree}>
				<RefreshCw class="size-4" />
			</button>
			<button
				class="btn-icon btn-icon-xs {view === 'scm' ? 'workbench-shell-active' : 'workbench-shell-quiet-hover'}"
				title={m.wsview_source_control()}
				aria-label={m.wsview_source_control()}
				onclick={() => (view = view === 'scm' ? 'explorer' : 'scm')}
			>
				<GitBranch class="size-4" />
			</button>
			<button
				class="btn-icon btn-icon-xs {view === 'search' ? 'workbench-shell-active' : 'workbench-shell-quiet-hover'}"
				title={m.wsview_find_in_files_title({ combo: `${modLabel}+Shift+F` })}
				aria-label={m.wsview_find_in_files()}
				onclick={() => (view === 'search' ? (view = 'explorer') : onOpenGlobalSearch())}
			>
				<Search class="size-4" />
			</button>
		</div>
	</div>
	{#if view === 'search'}
		<GlobalSearch bind:this={globalSearchRef} root={$workspaceRoot ?? ''} onOpen={onOpenFileAt} onClose={onCloseGlobalSearch} />
	{:else if view === 'scm'}
		<div class="scroll-inset-r min-h-0 flex-1 overflow-y-auto">
			<SourceControlPanel
				root={$workspaceRoot ?? ''}
				isRepo={$isGitRepo}
				branch={$gitBranch}
				changes={$gitChanges}
				busy={scmBusy}
				onInit={scmInit}
				onStage={scmStage}
				onUnstage={scmUnstage}
				onDiscard={scmDiscard}
				onCommit={scmCommit}
				onOpenDiff={scmOpenDiff}
				onRefresh={onRefreshGit}
			/>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col" bind:this={splitEl}>
			<div class="scroll-inset-r min-h-0 overflow-y-auto p-1.5" style={showToc ? `flex: ${1 - tocFraction} 1 0%` : 'flex: 1 1 0%'}>
				<FileTree
					bind:this={fileTreeRef}
					tree={$fileTree}
					rootPath={$workspaceRoot ?? ''}
					activePath={$activeFilePath}
					mainPath={$mainFile}
					gitStatus={$gitStatusMap}
					onOpen={onOpenEntry}
					{onCreate}
					{typstProject}
					{onRename}
					{onDelete}
					{onMove}
					{onImport}
					{onCopyIn}
					{onSetMain}
					{onReveal}
					history={fileHistory}
				/>
			</div>
			{#if showToc}
				<!-- arrow keys resize when focused: the WAI-ARIA window-splitter pattern (role=separator + tabindex) -->
				<!-- eslint-disable-next-line svelte/valid-compile -->
				<div
					class="workbench-divider-grab relative z-20 -my-[3px] h-1.5 shrink-0 cursor-row-resize bg-transparent transition-colors"
					onmousedown={onStartTocResize}
					onkeydown={onResizeTocByKey}
					role="separator"
					aria-orientation="horizontal"
					aria-label={m.wsview_resize_toc_aria()}
					tabindex="0"
				></div>
				<!-- scroll-inset-r moves the scrollbar in, not the box: the border-t still reaches the divider -->
				<div class="border-surface-200-800 scroll-inset-r min-h-0 overflow-y-auto border-t p-2" style="flex: {tocFraction} 1 0%">
					<TableOfContents mode={viewMode === 'source' ? 'source' : 'visual'} onOpenFile={onOpenFileAt} />
				</div>
			{/if}
		</div>
	{/if}
</aside>
