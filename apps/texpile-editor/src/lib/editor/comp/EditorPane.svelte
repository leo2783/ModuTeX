<script lang="ts">
	// The editor column: the mode toolbar on top and, under it, whichever surface the open file
	// needs (starter picker, diff, source, visual, bib, pdf, image). Chooses the surface; the
	// state behind it all lives in WorkspaceView.
	import type { Node as PMNode } from 'prosemirror-model';
	import { NodeSelection } from 'prosemirror-state';
	import type { EditorView as PMView } from 'prosemirror-view';
	import { getContext, onDestroy, type ComponentProps } from 'svelte';
	import { Loader2, CircleAlert, Info, FileText } from '@lucide/svelte';
	import { isTexpileManaged, managedKind } from '$lib/comments/managed';
	import Toolbar from './toolbar/Toolbar.svelte';
	import SourceToolbar from './toolbar/SourceToolbar.svelte';
	import SearchBar from './SearchBar.svelte';
	import StarterPicker from './StarterPicker.svelte';
	import DiffPane from './DiffPane.svelte';
	import SourceEditor from './SourceEditor.svelte';
	import BibManager from './BibManager.svelte';
	import PDFViewer from './PDFViewer.svelte';
	import PreambleFrontmatter from './PreambleFrontmatter.svelte';
	import EditorView from '$lib/editor/EditorView.svelte';
	import MarkdownEditorView from '$lib/markdown/MarkdownEditorView.svelte';
	import MarkdownToolbar from '$lib/markdown/MarkdownToolbar.svelte';
	import MarkdownSourceToolbar from '$lib/markdown/MarkdownSourceToolbar.svelte';
	import TypstEditorView from '$lib/typst/visual/TypstEditorView.svelte';
	import TypstToolbar from '$lib/typst/visual/TypstToolbar.svelte';
	import TypstSourceToolbar from '$lib/typst/visual/TypstSourceToolbar.svelte';
	import type { ParsedLatexFile, ParsePhase } from '$lib/workspace/latexRoundtrip';
	import VisualLoading from './VisualLoading.svelte';
	import type { BibLaTeXReference } from '$lib/workspace/citations';
	import type { Starter, ImportedFile } from '$lib/workspace/starters';
	import { get } from 'svelte/store';
	import { basename, dirname } from '$lib/workspace/fileSystem';
	import { activeFilePath, isDirty } from '$lib/workspace/workspaceStore';
	import { editorViewStore } from '$lib/stores/editorStore';
	import { isReadOnly } from '$lib/stores/permissionStore';
	import { restoreVisualPosition } from '$lib/workspace/visualPositions';
	import { stripFor } from '$lib/markdown/sourceMap';
	import { bodyOffsetOf } from '$lib/workspace/latexRoundtrip';
	import TabBar from './TabBar.svelte';
	import { m } from '$lib/paraglide/messages';
	import { settings } from '$lib/settings';
	import DrawioDiagramModal from '$lib/diagram/DrawioDiagramModal.svelte';
	import { FIGURE_COORDINATOR_CONTEXT, type FigureCoordinator, type FigureOperationContext } from '$lib/diagram/figure-coordinator';
	import { MATH_PACKAGE_CONTEXT, type MathPackageRequester } from '$lib/workspace/math-package-context';
	import { registerDiagramRequester, requestDiagramForView } from '$lib/editor/extensions/blockInsertItems';
	import type { BlockCommandContext } from '$lib/editor/extensions/blockInsertItems';

	import type { FileKind } from '$lib/workspace/documentBuffer.svelte';

	interface Props {
		loadedPath: string | null;
		openTabs: string[];
		onActivateTab: (path: string) => void;
		onCloseTab: (path: string) => void;
		kind: FileKind;
		viewMode: 'visual' | 'source' | 'diff';
		folderEmpty: boolean;
		loadError: string | null;
		applyingStarter: boolean;
		texSource: string;
		rawContent: string;
		visualDoc: PMNode | null;
		/** stage of the in-flight parse, for the visual-mode loading bar; null = idle */
		parseProgress?: ParsePhase | null;
		/** escape hatch offered once the parse looks slow */
		onUseSource?: () => void;
		docMeta: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'> | null;
		allReferences: BibLaTeXReference[];
		sourceGotoLine: { line: number; token: number; selectText?: string } | undefined;
		sourceScrollAnchor: { scroll: number | null; cursor: number | null } | null;
		sourceDiagnostics: NonNullable<ComponentProps<typeof SourceEditor>['diagnostics']>;
		diffOriginal: string;
		diffModified: string;
		diffLayout: 'unified' | 'split';
		diffLoading: boolean;
		diffError: string | null;
		diffHasHead: boolean;
		/** the workspace provider's URL builder. */
		fileUrl: (path: string) => string;
		onPickStarter: (s: Starter) => void;
		onBlankStarter: () => void;
		onImportStarter: (files: ImportedFile[]) => void;
		onTexInput: (v: string) => void;
		onRawInput: (v: string) => void;
		onVisualChange: (doc: PMNode) => void;
		/** visual-editor caret movement. */
		onVisualSelection?: () => void;
		onEditFrontmatter: (kind: string, inner: string) => void;
		onAddTitle: () => void;
		onSyncToPdf: (line: number) => void;
		onHistoryBoundary: (dir: 'undo' | 'redo') => boolean;
		onJumpToFile: (name: string) => void;
		onOpenFileAt: (file: string, line: number, selectText?: string) => void;
		/** caret moved to this ZERO-based line/column in the source editor */
		onCaretMove?: (line: number, character: number) => void;
		/** review-comment ranges for the open file, and the hooks the editor raises; see lib/comments */
		commentRanges?: import('$lib/editor/extensions/comments').CommentRange[];
		/** the same file's threads with their anchors: the visual editor re-resolves against its own
		 * rendered text, because source offsets mean nothing there (see pmComments) */
		commentThreads?: import('$lib/comments/log').CommentThread[];
		selectedComment?: string | null;
		onAddComment?: (from: number, to: number) => void;
		/** the visual editor's add: it hands a finished rendered-dialect anchor, not source offsets */
		onAddCommentAnchored?: (anchor: import('$lib/comments/anchor').CommentAnchor | null) => void;
		/** threads the visual editor could not draw, so the panel can label them "not in this view" */
		onCommentsPlaced?: (lost: string[]) => void;
		onSelectComment?: (id: string, from: 'text' | 'gutter' | 'visual') => void;

		onToggleDiffLayout: () => void;
		onRefreshDiff: () => void;
		onExitDiff: () => void;
	}
	let {
		loadedPath,
		openTabs,
		onActivateTab,
		onCloseTab,
		kind,
		viewMode,
		folderEmpty,
		loadError,
		applyingStarter,
		texSource,
		rawContent,
		visualDoc,
		parseProgress = null,
		onUseSource,
		docMeta,
		allReferences,
		sourceGotoLine,
		sourceScrollAnchor,
		sourceDiagnostics,
		diffOriginal,
		diffModified,
		diffLayout,
		diffLoading,
		diffError,
		diffHasHead,
		fileUrl,
		onPickStarter,
		onBlankStarter,
		onImportStarter,
		onTexInput,
		onRawInput,
		onVisualChange,
		onVisualSelection,
		onEditFrontmatter,
		onAddTitle,
		onSyncToPdf,
		onHistoryBoundary,
		onJumpToFile,
		onOpenFileAt,
		onCaretMove,
		commentRanges = [],
		commentThreads = [],
		selectedComment = null,
		onAddComment,
		onAddCommentAnchored,
		onCommentsPlaced,
		onSelectComment,
		onToggleDiffLayout,
		onRefreshDiff,
		onExitDiff
	}: Props = $props();

	// Remount the source editor when the local file changes.
	const sourceKey = $derived(loadedPath);

	// Building the visual editor's node views is one long synchronous block - seconds on a large
	// paper - and it does NOT happen when <EditorView> mounts. That component's onMount awaits a
	// dynamic import first, so the browser paints (the title appears, the editor area is still
	// empty), and only then does ProseMirror construct and freeze the thread. So mounting is not the
	// signal; EditorView reports the real one through onReady.
	//
	// Keeping the loading bar rendered until then puts it on screen during that import-await paint,
	// and whatever was last painted stays up through the block that follows.
	//
	// Tracked per path rather than as a plain boolean so opening another file resets it for free.
	let readyFor = $state<string | null>(null);
	const editorReady = $derived(!!loadedPath && readyFor === loadedPath);
	const figureCoordinator = getContext<FigureCoordinator>(FIGURE_COORDINATOR_CONTEXT);
	const mathPackageRequester = getContext<MathPackageRequester | undefined>(MATH_PACKAGE_CONTEXT);
	type ActiveDiagramPanel = { type: 'drawio'; context: FigureOperationContext; onAbort: () => void };
	// This value is an operation capability: FigureCoordinator keys it by exact context identity.
	// Deep $state proxies nested objects, which would replace the frozen context object with a
	// different Map key before the modal receives it. Every lifecycle transition replaces the
	// panel reference, so raw state remains reactive without wrapping the capability.
	let activeDiagramPanel = $state.raw<ActiveDiagramPanel | null>(null);

	/** Rendered for the whole build, but it holds itself invisible for the first 300 ms through a CSS
	 * animation delay (see VisualLoading), so a fast build never flashes a bar. Deliberately not a
	 * size threshold: that would bake in an assumption about how fast the machine is, and suppress
	 * the bar on a slow CPU exactly where the wait is worst. */
	const showRenderBar = $derived(!editorReady);

	/** kinds that have a visual (ProseMirror) surface */
	const structured = $derived(kind === 'tex' || kind === 'md' || kind === 'typ');

	/** md link tooltip Open: real schemes go to the browser, in-doc anchors are swallowed (no
	 * anchor targets yet), anything path-like opens in the workspace. */
	function onMdLink(href: string): boolean {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
		if (href.startsWith('#')) return true;
		const path = href.split('#')[0];
		// hrefs reach us already decoded (see `dest` in markdown/converter.ts); this only catches a
		// target still holding escapes, and must not throw on a literal `%` that decodes to nothing
		let target = path;
		try {
			target = decodeURIComponent(path);
		} catch {
			/* not valid escaping: the raw text IS the path */
		}
		onJumpToFile(target);
		return true;
	}
	/** the visual editor is wanted, whether or not it has been built yet */
	const visualPending = $derived(loadedPath && structured && viewMode === 'visual');

	/** ProseMirror is built: put the caret back where this file was left. A one-shot callback rather
	 *  than an effect, so it cannot re-enter - the editor is built exactly once per file. */
	function onVisualReady(): void {
		readyFor = loadedPath;
		const v = get(editorViewStore);
		if (!v || !loadedPath) return;
		restoreVisualPosition(v, loadedPath, texSource, docMeta ? bodyOffsetOf(docMeta) : 0, stripFor(kind));
	}

	function openDiagramFromCommand(type: 'mermaid' | 'drawio', view: PMView, command: BlockCommandContext): void {
		if (
			type !== 'drawio' ||
			activeDiagramPanel ||
			!figureCoordinator ||
			kind !== 'tex' ||
			viewMode !== 'visual' ||
			!editorReady ||
			!loadedPath ||
			view.isDestroyed ||
			!view.dom.isConnected ||
			view.state.doc !== command.state.doc
		)
			return;

		const node = view.state.doc.nodeAt(command.targetPos);
		if (!node) return;
		const intent = node.type.name === 'image' && node.attrs.diagramType === type ? 'edit' : 'insert';
		const externalSignal = command.abortSignal ?? new AbortController().signal;
		const context = figureCoordinator.begin(type, view, externalSignal, {
			pos: command.targetPos,
			intent,
			placement: command.placement
		});
		if (!context) return;
		if (intent === 'edit' && !figureCoordinator.existing(context)) {
			figureCoordinator.release(context);
			return;
		}
		const panel: ActiveDiagramPanel = {
			type,
			context,
			onAbort: () => {
				if (activeDiagramPanel === panel) activeDiagramPanel = null;
			}
		};
		activeDiagramPanel = panel;
		context.signal.addEventListener('abort', panel.onAbort, { once: true });
		if (context.signal.aborted) panel.onAbort();
	}

	function openDiagramAtSelection(type: 'mermaid' | 'drawio'): void {
		const view = $editorViewStore;
		if (!view || view.isDestroyed || !view.dom.isConnected) return;
		const selection = view.state.selection;
		if (!(selection instanceof NodeSelection) && selection.$from.depth === 0) return;
		const targetPos = selection instanceof NodeSelection ? selection.from : selection.$from.before(1);
		const placement = selection instanceof NodeSelection ? 'replace' : 'after';
		requestDiagramForView(view, type, targetPos, placement);
	}

	function closeDiagramPanel(context: FigureOperationContext): void {
		const panel = activeDiagramPanel;
		if (!panel || panel.context !== context) return;
		context.signal.removeEventListener('abort', panel.onAbort);
		figureCoordinator?.abort(context);
		activeDiagramPanel = null;
	}

	$effect(() => {
		const view = $editorViewStore;
		if (!view || !editorReady || !loadedPath || kind !== 'tex' || viewMode !== 'visual' || view.isDestroyed || !view.dom.isConnected)
			return;
		return registerDiagramRequester(view, (type, command) => openDiagramFromCommand(type, view, command));
	});

	onDestroy(() => {
		if (activeDiagramPanel) closeDiagramPanel(activeDiagramPanel.context);
	});
</script>

<div class="flex min-h-0 min-w-0 flex-col" style="grid-column: 1; grid-row: 2">
	<TabBar tabs={openTabs} activePath={loadedPath} dirty={$isDirty} onActivate={onActivateTab} onClose={onCloseTab} />
	{#if visualDoc && loadedPath && structured && viewMode === 'visual'}
		<div
			class="border-surface-200-800 @container relative z-20 flex min-h-10 items-center overflow-hidden border-b px-2"
			inert={activeDiagramPanel !== null}
		>
			{#if kind === 'md'}
				<MarkdownToolbar />
			{:else if kind === 'typ'}
				<TypstToolbar />
			{:else}
				<Toolbar minimal />
				{#if kind === 'tex' && editorReady}
					<div class="ml-auto flex shrink-0 items-center gap-1 pl-2">
						<button
							class="btn-icon"
							type="button"
							title={m.blockmenu_drawio_diagram()}
							aria-label={m.blockmenu_drawio_diagram()}
							onclick={() => openDiagramAtSelection('drawio')}
						>
							<FileText class="size-4" />
						</button>
					</div>
				{/if}
			{/if}
		</div>
	{:else if loadedPath && structured && viewMode === 'source'}
		<div class="border-surface-200-800 @container relative z-20 flex min-h-10 items-center overflow-hidden border-b px-2">
			{#if kind === 'md'}
				<MarkdownSourceToolbar />
			{:else if kind === 'typ'}
				<TypstSourceToolbar />
			{:else}
				<SourceToolbar />
			{/if}
		</div>
	{/if}
	<!-- not in diff mode: DiffPane carries its own, and both rendered gave two stacked banners -->
	{#if loadedPath && viewMode !== 'diff' && isTexpileManaged(loadedPath)}
		<!-- Above the editor, not in it: .texpile is hidden from the tree, so anyone who has this
		     open reached it deliberately from Source Control and deserves to know what it is before
		     they touch it. A warning rather than read-only - the file is plain text on their disk
		     and the app should not pretend otherwise - but hand edits really are lost, so say so.

		     EXCEPT the .gitignore, where editing is the supported override (Texpile only seeds it
		     when missing): telling someone "not by hand" about the one file whose hand-edits are
		     honoured would hide the override it exists to provide. -->
		{@const note = managedKind(loadedPath) === 'ignore' ? m.texpile_managed_ignore_note() : m.texpile_managed_edit_warning()}
		<!-- 40px is the app's bar height - the PDF, editor and draft toolbars are all min-h-10, border
		     included - so this reads as another piece of chrome rather than prose shoving the document
		     down. One line, so the tail truncates: the lead is the part that has to land, and the full
		     warning is on the tooltip. -->
		<div
			class="border-surface-200-800 bg-surface-100-900 text-surface-600-300 flex min-h-10 shrink-0 items-center gap-2 border-b px-3 text-xs"
			title={note}
		>
			<Info class="text-primary-500 size-3.5 shrink-0" />
			<p class="min-w-0 truncate"><span class="font-medium">{m.vcs_texpile_managed()}.</span> {note}</p>
		</div>
	{/if}
	<!-- relative anchors the floating find bar; it sits outside the scroller so it doesn't scroll away -->
	<div class="relative min-h-0 min-w-0 flex-1">
		<div class="h-full min-h-0" inert={activeDiagramPanel !== null}>
			{#if loadedPath && structured && viewMode === 'visual' && visualDoc}
				<SearchBar />
			{/if}
			<!-- scroll-inset-r keeps this scrollbar clear of the lozenge on the preview divider. NOT in diff
		     mode: DiffPane is a pane, not a document - it fills the height, scrolls inside itself and
		     draws its own full-width bars, so the 3px showed up as a gap between every one of those
		     bars and the divider. It wears the inset on its own scroller instead. -->
			<div class="h-full w-full overflow-auto {viewMode === 'diff' ? '' : 'scroll-inset-r'}">
				{#if folderEmpty && !$activeFilePath}
					<div class="mx-auto mt-16 max-w-xl px-6">
						<div class="text-center">
							<h2 class="text-lg font-semibold">{m.wsview_start_new_doc_heading()}</h2>
							<p class="text-surface-500 mt-1 text-sm">
								{m.wsview_start_new_doc_desc_pre()} <code>.tex</code>
								{m.wsview_start_new_doc_desc_post()}
							</p>
						</div>
						<div class="mt-6">
							<StarterPicker onPick={onPickStarter} onBlank={onBlankStarter} onImport={onImportStarter} busy={applyingStarter} />
						</div>
					</div>
				{:else if loadError}
					<div class="text-error-600 mx-auto mt-12 flex max-w-md flex-col items-center gap-2 text-center">
						<CircleAlert class="size-8" />
						<p class="text-sm">{loadError}</p>
					</div>
				{:else if loadedPath && viewMode === 'diff' && (structured || kind === 'bib' || kind === 'text')}
					<DiffPane
						filename={loadedPath}
						original={diffOriginal}
						modified={diffModified}
						layout={diffLayout}
						loading={diffLoading}
						error={diffError}
						hasHead={diffHasHead}
						onToggleLayout={onToggleDiffLayout}
						onRefresh={onRefreshDiff}
						onExit={onExitDiff}
					/>
				{:else if loadedPath && structured && viewMode === 'source'}
					{#key sourceKey}
						<SourceEditor
							docPath={loadedPath}
							value={texSource}
							onInput={onTexInput}
							gotoLine={sourceGotoLine}
							{onSyncToPdf}
							initialScrollPos={sourceScrollAnchor}
							{onHistoryBoundary}
							diagnostics={kind === 'typ' ? undefined : sourceDiagnostics}
							{onJumpToFile}
							{onOpenFileAt}
							{onCaretMove}
							{commentRanges}
							{selectedComment}
							{onAddComment}
							{onSelectComment}
						/>
					{/key}
				{:else if loadedPath && structured && visualDoc}
					{#key loadedPath}
						<!-- texpile-main-editor scopes the editor's right-click context menu (ContextMenu.svelte) -->
						<!-- px-12 reserves room for the block-handle gutters (~48px left / ~30px right); on narrow
				     windows the mx-auto centering margin collapses and this padding keeps them from clipping.
				     The \noindent marker has to fit this 48px too, which is why it is abbreviated (app.css) -->
						<div class="px-12 py-8">
							<!-- the measure, from Preferences. Was a fixed max-w-3xl (768px), which is still the
						     default; past it a wide window pads with empty space rather than stretching the
						     line length, and how much of that is comfortable is a matter of taste -->
							<div class="texpile-main-editor mx-auto w-full min-w-0" style="max-width: {$settings.visualMaxWidth ?? 768}px">
								{#if docMeta?.hadDocumentEnv && kind === 'tex'}
									<!-- \title/\author fields are LaTeX; md frontmatter is YAML, edited in source mode -->
									<PreambleFrontmatter preamble={docMeta.preamble} disabled={$isReadOnly} onEdit={onEditFrontmatter} {onAddTitle} />
								{/if}
								{#if kind === 'md'}
									<!-- an entirely separate ProseMirror over mdSchema; see lib/markdown -->
									<MarkdownEditorView
										localValue={visualDoc}
										localReferences={allReferences}
										imageDir={dirname(loadedPath)}
										onLocalChange={onVisualChange}
										onSelectionChange={onVisualSelection}
										placeholder={m.wsview_editor_placeholder()}
										{onHistoryBoundary}
										onReady={onVisualReady}
										onOpenLink={onMdLink}
										{commentThreads}
										{selectedComment}
										{onSelectComment}
										onAddComment={onAddCommentAnchored}
										{onCommentsPlaced}
										addCommentLabel={m.comments_add()}
									/>
								{:else if kind === 'typ'}
									<!-- an entirely separate ProseMirror over typSchema; see lib/typst/visual -->
									<TypstEditorView
										localValue={visualDoc}
										localReferences={allReferences}
										docDir={dirname(loadedPath)}
										onLocalChange={onVisualChange}
										onSelectionChange={onVisualSelection}
										placeholder={m.wsview_editor_placeholder()}
										{onHistoryBoundary}
										onReady={onVisualReady}
										onOpenLink={onMdLink}
										{commentThreads}
										{selectedComment}
										{onSelectComment}
										onAddComment={onAddCommentAnchored}
										{onCommentsPlaced}
										addCommentLabel={m.comments_add()}
									/>
								{:else}
									<EditorView
										localValue={visualDoc}
										{mathPackageRequester}
										localReferences={allReferences}
										imageDir={dirname(loadedPath)}
										onLocalChange={onVisualChange}
										onSelectionChange={onVisualSelection}
										placeholder={m.wsview_editor_placeholder()}
										{onHistoryBoundary}
										onReady={onVisualReady}
										{commentThreads}
										{selectedComment}
										{onSelectComment}
										onAddComment={onAddCommentAnchored}
										{onCommentsPlaced}
										addCommentLabel={m.comments_add()}
									/>
								{/if}
								{#if showRenderBar}
									<!-- EditorView keeps its own root hidden until ProseMirror exists, so this sits in the
								     space the editor will occupy rather than over it. It is on screen for the paint
								     that happens while EditorView awaits its dynamic import, and stays there through
								     the synchronous build that follows. -->
									<VisualLoading mounting sizeBytes={texSource.length} />
								{/if}
							</div>
						</div>
					{/key}
				{:else if visualPending}
					<!-- doc not here yet: the parse runs in a worker and fills this in when it lands -->
					<VisualLoading phase={parseProgress} sizeBytes={texSource.length} {onUseSource} />
				{:else if loadedPath && kind === 'bib' && viewMode === 'source'}
					<!-- Source mode edits raw BibTeX; Visual mode below uses BibManager. -->
					{#key sourceKey}
						<SourceEditor docPath={loadedPath} value={rawContent} onInput={onRawInput} filename={loadedPath} gotoLine={sourceGotoLine} />
					{/key}
				{:else if loadedPath && kind === 'bib'}
					{#key loadedPath}
						<BibManager value={rawContent} onInput={onRawInput} />
					{/key}
				{:else if loadedPath && kind === 'text'}
					<!-- .typ no longer lands here: it is structured now (typSchema), so its source mode
				     is the texSource branch above, which carries onCaretMove/onSyncToPdf for the
				     Typst preview's follow and "Show in preview" -->
					{#key sourceKey}
						<SourceEditor docPath={loadedPath} value={rawContent} onInput={onRawInput} filename={loadedPath} gotoLine={sourceGotoLine} />
					{/key}
				{:else if loadedPath && kind === 'pdf'}
					<!-- a .pdf opened directly: its own src, independent of the compile-output pane -->
					<div class="h-full w-full">
						<PDFViewer src={fileUrl(loadedPath)} filename={basename(loadedPath)} />
					</div>
				{:else if loadedPath && kind === 'image'}
					<div class="flex h-full items-center justify-center p-8">
						<img src={fileUrl(loadedPath)} alt={basename(loadedPath)} class="max-h-full max-w-full object-contain" />
					</div>
				{:else if loadedPath && kind === 'binary'}
					<div class="text-surface-500 mt-12 text-center text-sm">
						{m.wsview_binary_file_note({ name: basename(loadedPath) })}
					</div>
				{:else if $activeFilePath}
					<!-- shown while the visual parse runs; fades in late so a fast parse never strobes a spinner -->
					<div class="text-surface-500 spinner-late mt-12 flex items-center justify-center gap-2 text-sm">
						<Loader2 class="size-4 animate-spin" />
						{m.wsview_opening()}
					</div>
				{:else}
					<div class="text-surface-500 mt-12 text-center text-sm">{m.wsview_select_file_prompt()}</div>
				{/if}
			</div>
		</div>
		{#if activeDiagramPanel}
			{@const panel = activeDiagramPanel}
			<DrawioDiagramModal
				context={panel.context}
				coordinator={figureCoordinator}
				existing={figureCoordinator.existing(panel.context)}
				onClose={() => closeDiagramPanel(panel.context)}
			/>
		{/if}
	</div>
</div>

<style>
	.spinner-late {
		opacity: 0;
		animation: spinner-late-in 0.2s ease 0.15s forwards;
	}
	@keyframes spinner-late-in {
		to {
			opacity: 1;
		}
	}
</style>
