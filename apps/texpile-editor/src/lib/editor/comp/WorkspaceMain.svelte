<script lang="ts">
	import { onMount } from 'svelte';
	import './workbench.css';
	// The editor column: toolbar, editor/preview pair, and the bottom dock. Everything here reads
	// from the workspace's state objects rather than a long list of scalar props, which is what
	// makes this splittable at all - the state lives in lib/workspace/*.svelte.ts, not in the view.
	import EditorTopbar from '$lib/editor/comp/EditorTopbar.svelte';
	import EditorPane from '$lib/editor/comp/EditorPane.svelte';
	import PreviewPane from '$lib/editor/comp/PreviewPane.svelte';
	import PaneSplitter from '$lib/editor/comp/PaneSplitter.svelte';
	import TerminalDock from '$lib/editor/comp/TerminalDock.svelte';
	import { ChevronLeft } from '@lucide/svelte';
	import { m } from '$lib/paraglide/messages';
	import type DraftView from '$lib/draft/DraftView.svelte';
	import type { DocumentBuffer, FileKind } from '$lib/workspace/documentBuffer.svelte';
	import type { ViewModeSwitch } from '$lib/workspace/viewModeSwitch.svelte';
	import type { PaneLayout } from '$lib/workspace/paneLayout.svelte';
	import type { DiffMode } from '$lib/workspace/diffMode.svelte';
	import type { VisualParser } from '$lib/workspace/visualParse.svelte';
	import type { TerminalDockState } from '$lib/workspace/terminalDockState.svelte';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pipelines are structural here
	type Any = any;

	let {
		doc,
		modes,
		layout = $bindable(),
		diff,
		parser,
		termDock = $bindable(),
		compiler,
		saver,
		kind,
		folderEmpty,
		modLabel,
		dockShrunk,
		draft,
		typstPreviewHost,
		typstPreviewWanted,
		panes,
		actions,
		dockView = $bindable(),
		pdfPaneRef = $bindable(),
		draftRef = $bindable()
	}: {
		doc: DocumentBuffer;
		modes: ViewModeSwitch;
		layout: PaneLayout;
		diff: DiffMode;
		parser: VisualParser;
		termDock: TerminalDockState;
		compiler: Any;
		saver: Any;
		kind: FileKind;
		folderEmpty: boolean;
		modLabel: string;
		dockShrunk: boolean;
		/** live-preview inputs: root, main file, recompile trigger, paused flag */
		draft: { root: string; mainRel: string; trigger: number; paused: boolean };
		/** `host:port` of a running Typst preview, null while one is still starting */
		typstPreviewHost: string | null;
		/** this pane is for a Typst preview, even before it has an address */
		typstPreviewWanted: boolean;
		/** editor inputs that are not workspace state: tabs, references, jump targets */
		panes: Any;
		actions: Any;
		dockView: 'terminal' | 'problems' | 'comments';
		pdfPaneRef: Any;
		draftRef: DraftView | null;
	} = $props();

	const NARROW_WORKBENCH_WIDTH = 720;
	let mainEl: HTMLElement | undefined = $state();
	let workbenchWidth = $state(1280);
	let pdfMaxWidth = $state(320);
	let narrow = $state(false);
	let activePane = $state<'document' | 'preview'>('document');

	$effect(() => {
		if (narrow && !layout.pdfPaneOpen) activePane = 'document';
	});

	onMount(() => {
		const main = mainEl;
		if (!main) return;
		const measure = () => {
			const nextWidth = main.clientWidth;
			if (nextWidth !== workbenchWidth) workbenchWidth = nextWidth;
			const nextPdfMaxWidth = layout.clampPdf(Number.POSITIVE_INFINITY);
			if (nextPdfMaxWidth !== pdfMaxWidth) pdfMaxWidth = nextPdfMaxWidth;
			const nextNarrow = nextWidth < NARROW_WORKBENCH_WIDTH;
			if (nextNarrow !== narrow) narrow = nextNarrow;
		};
		let frame = 0;
		const scheduleMeasure = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		measure();
		const observer = new ResizeObserver(scheduleMeasure);
		observer.observe(main);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	});

	function selectPane(pane: 'document' | 'preview') {
		activePane = pane;
		// Reuse the existing persisted pane-open callback. Selecting the document never closes the
		// preview, so switching back does not recreate or reset its viewer state.
		if (pane === 'preview' && !layout.pdfPaneOpen) layout.togglePdfPane();
	}

	function togglePdfPane() {
		const wasOpen = layout.pdfPaneOpen;
		layout.togglePdfPane();
		if (wasOpen) activePane = 'document';
	}
</script>

<main
	bind:this={mainEl}
	class="document-workbench grid min-h-0 min-w-0 flex-1"
	data-layout={narrow ? 'narrow' : 'wide'}
	style="grid-template-columns: {narrow ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto auto'}; grid-template-rows: auto minmax(0, 1fr) auto auto"
>
	<EditorTopbar
		loadedPath={doc.path}
		{kind}
		viewMode={modes.mode}
		terminalAvailable={termDock.available}
		compiling={compiler.compiling}
		{typstPreviewWanted}
		pdfPaneOpen={layout.pdfPaneOpen}
		{narrow}
		{activePane}
		draftPaused={draft.paused}
		saving={saver.saving}
		{modLabel}
		onSetViewMode={actions.setViewMode}
		onStopCompile={compiler.stopCompile}
		onPauseDraft={actions.pauseDraft}
		onResumeDraft={actions.resumeDraft}
		onCompile={compiler.runCompile}
		commandPending={panes.commandPending}
		onConfigureCompile={actions.openCompileModal}
		onShowProblems={actions.showProblems}
		onSelectPane={selectPane}
		onTogglePdf={togglePdfPane}
		onSave={actions.save}
	/>

	<!-- editor column (toolbar + content) with the PDF pane beside it, so the PDF skips the
	     toolbar while the header (Compile) stays above it. the wrapper is display:contents so
	     editor/splitter/preview place themselves on main's grid -->
	<div class="contents">
		<div
			class="workbench-document-panel"
			data-inactive={narrow && activePane === 'preview'}
			role={narrow ? 'tabpanel' : undefined}
			id={narrow ? 'workbench-document-panel' : undefined}
			aria-labelledby={narrow ? 'workbench-document-tab' : undefined}
			aria-hidden={narrow && activePane === 'preview'}
			inert={narrow && activePane === 'preview'}
			style="grid-column: 1; grid-row: 2"
		>
			<EditorPane
				openTabs={panes.openTabs}
				onActivateTab={actions.activateTab}
				onCloseTab={actions.closeTab}
				loadedPath={doc.path}
				{kind}
				viewMode={modes.mode}
				{folderEmpty}
				loadError={doc.loadError}
				applyingStarter={panes.applyingStarter}
				texSource={doc.texSource}
				rawContent={doc.rawContent}
				visualDoc={doc.visualDoc}
				parseProgress={parser.progress}
				onUseSource={actions.useSource}
				docMeta={doc.docMeta}
				allReferences={panes.allReferences}
				sourceGotoLine={panes.sourceGotoLine}
				sourceScrollAnchor={modes.sourceScrollAnchor}
				sourceDiagnostics={panes.sourceDiagnostics}
				diffOriginal={diff.original}
				diffModified={diff.modified}
				diffLayout={diff.layout}
				diffLoading={diff.loading}
				diffError={diff.error}
				diffHasHead={diff.hasHead}
				fileUrl={panes.fileUrl}
				onPickStarter={actions.pickStarter}
				onBlankStarter={actions.newTexFile}
				onImportStarter={actions.importStarter}
				onTexInput={actions.onTexInput}
				onRawInput={actions.onRawInput}
				onVisualChange={actions.onVisualChange}
				onVisualSelection={actions.onVisualSelection}
				onEditFrontmatter={actions.onEditFrontmatter}
				onAddTitle={actions.onAddTitle}
				onSyncToPdf={actions.syncToPdf}
				onHistoryBoundary={actions.historyStep}
				onJumpToFile={actions.jumpToFile}
				onOpenFileAt={actions.openFileAt}
				onCaretMove={actions.onCaretMove}
				onToggleDiffLayout={() => diff.toggleLayout()}
				onRefreshDiff={actions.refreshDiff}
				onExitDiff={actions.exitDiff}
				commentRanges={panes.commentRanges}
				commentThreads={panes.comments.filter((t) => t.file === panes.commentFile)}
				selectedComment={panes.commentSelected}
				onAddComment={actions.beginComment}
				onAddCommentAnchored={actions.beginCommentAnchored}
				onCommentsPlaced={actions.visualCommentsPlaced}
				onSelectComment={actions.selectComment}
			/>
		</div>
		{#if layout.pdfPaneOpen}
			<PreviewPane
				width={layout.pdfPaneWidth}
				maxWidth={pdfMaxWidth}
				narrowMode={narrow}
				narrowActive={activePane === 'preview'}
				{dockShrunk}
				pdfFilename={compiler.pdfFilename}
				draftRoot={draft.root}
				draftMainRel={draft.mainRel}
				draftTrigger={draft.trigger}
				{typstPreviewHost}
				{typstPreviewWanted}
				onSaveTypstPdf={actions.onSaveTypstPdf}
				onSyncToCursor={(kind === 'tex' || kind === 'typ') && modes.mode !== 'diff' ? actions.syncForward : null}
				paneDragging={layout.paneDragging}
				bind:pdfPaneRef
				bind:draftRef
				onStartResize={layout.startPdfResize}
				onResizeByKey={layout.resizePdfByKey}
				onClose={togglePdfPane}
				onPageClick={actions.onPdfDoubleClick}
				onInverseSync={actions.onInverseSync}
				onSettled={actions.onPreviewSettled}
				onDiagnostics={actions.onPreviewDiagnostics}
			/>
		{:else if termDock.available}
			<!-- the pane is gone but its divider stays, on the editor's right edge with the chevron
			     flipped: that is the way back, now that the toolbar has no toggle. Not resizable -
			     there is nothing to size - so it loses the drag cursor too.

			     mr-[7px] holds the rule off the window edge. The lozenge is centred on it like every
			     other one, and its chevron is 14px against a 7px lozenge, so the glyph needs 7px of
			     clearance or the window edge cuts it in half - there is no pane out there to
			     overhang into.

			     It spans every row so the rule reaches the bottom of the window: with the preview shut
			     the dock stops at the editor column (see dockShrunk), and a rail that stopped at the
			     editor would leave a notch beside it.

			     bottomInset then holds the toggle level with the one it took over from. PreviewPane's
			     divider spans past the dock only when shrink is on; when it is off that divider ends
			     above the dock, so this one has to discount the same height or the lozenge slides
			     down the screen the moment you close the pane. -->
			<!-- resizable while shut on purpose: dragging it back into the window is the other half of
			     the drag-to-close gesture, so the rail has to accept the same drag the real divider
			     does. PaneLayout measures from the edge in this state. -->
			<PaneSplitter
				resizable
				resizeLabel={m.wsview_resize_pdf_preview_aria()}
				value={0}
				minValue={0}
				maxValue={layout.clampPdf(Number.POSITIVE_INFINITY)}
				onStartResize={layout.startPdfResize}
				onResizeByKey={layout.resizePdfByKey}
				toggle={{
					icon: ChevronLeft,
					onclick: layout.togglePdfPane,
					title: m.wsview_toggle_pdf_preview(),
					ariaLabel: m.wsview_toggle_pdf_preview()
				}}
				bottomInset={termDock.shrink || !termDock.visible ? 0 : termDock.height}
				class="workbench-closed-preview-rail z-20 mr-[7px]"
				style="grid-column: 3; grid-row: 2 / -1"
			/>
		{/if}
	</div>

	{#if termDock.mounted && termDock.available}
		<TerminalDock
			terminalEnabled={termDock.available}
			visible={termDock.visible}
			height={termDock.height}
			shrink={termDock.shrink}
			{dockShrunk}
			cwd={panes.cwd}
			pdfPaneOpen={layout.pdfPaneOpen}
			bind:view={dockView}
			bind:dock={termDock.dock}
			onStartResize={termDock.startResize}
			onResizeByKey={termDock.resizeByKey}
			onToggleShrink={actions.toggleTerminalShrink}
			onClose={actions.toggleTerminal}
			onProblemJump={actions.openFileAt}
			comments={panes.comments}
			commentFile={panes.commentFile}
			commentsOrphaned={panes.commentsOrphaned}
			commentsNotVisible={panes.commentsNotVisible}
			commentFilesPresent={panes.commentFilesPresent}
			commentSelected={panes.commentSelected}
			onCommentOpen={actions.openComment}
			onCommentReply={actions.replyToComment}
			onCommentResolve={actions.resolveComment}
			onCommentDelete={actions.deleteComment}
			onCommentEditMessage={actions.editCommentMessage}
			onCommentDeleteMessage={actions.deleteCommentMessage}
			commentPending={panes.commentPending}
			onCommentSubmitPending={actions.submitComment}
			onCommentCancelPending={actions.cancelComment}
		/>
	{/if}

	{#if termDock.available && !termDock.visible}
		<!-- the dock's divider, left behind at the foot of the window when the dock is put away, so
		     dragging it back up reopens it. Outside the `mounted` gate above on purpose: the rail is
		     the way in, and it has to be there before the dock has ever been built.

		     No lozenge, unlike the side rails. Those carry a collapse toggle because their panes lost
		     the toolbar buttons that used to open them; the dock kept both its toolbar button and its
		     menu item, so a control here would only be a third copy. -->
		<!-- eslint-disable-next-line svelte/valid-compile -->
		<div class="bg-surface-200-800 relative z-20 h-px shrink-0" style="grid-row: 4; grid-column: {dockShrunk ? '1' : '1 / -1'}">
			<!-- the grab zone overhangs the rule by 3px, and can only overhang upwards here: below it
			     is the window's edge -->
			<div
				class="hover:bg-primary-500/30 active:bg-primary-500/50 absolute inset-x-0 -inset-y-[3px] cursor-row-resize transition-colors"
				onmousedown={termDock.startResize}
				onkeydown={termDock.resizeByKey}
				role="separator"
				aria-orientation="horizontal"
				aria-label={m.wsview_resize_terminal_aria()}
				tabindex="0"
			></div>
		</div>
	{/if}
</main>
