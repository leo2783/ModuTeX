<script lang="ts">
	// The right-hand preview pane (+ its drag splitter): the Typst live preview, the live draft
	// renderer, or the compiled PDF. Renders two grid siblings, so it must
	// sit in a display:contents wrapper on the editor grid.
	import { ArrowRight, ChevronRight, X } from '@lucide/svelte';
	import PaneHandle from './PaneHandle.svelte';
	import PaneSplitter from './PaneSplitter.svelte';
	import PDFViewer from './PDFViewer.svelte';
	import type DraftView from '$lib/draft/DraftView.svelte';
	import type TypstPreview from '$lib/typst/preview/TypstPreview.svelte';
	import { settings } from '$lib/settings';
	import { m } from '$lib/paraglide/messages';

	// DraftView drags in opentype.js; draft mode is opt-in, so it loads only when first shown
	let DraftViewComp = $state<typeof DraftView | null>(null);
	$effect(() => {
		if ($settings.draftMode && !DraftViewComp) {
			import('$lib/draft/DraftView.svelte').then(
				(mod) => (DraftViewComp = mod.default),
				(e) => console.error('Failed to load draft view chunk:', e)
			);
		}
	});

	// The Typst preview carries a ~1.2MB wasm renderer; a LaTeX project must never pay for it, so
	// the chunk is fetched only once a preview has actually been started.
	let TypstPreviewComp = $state<typeof TypstPreview | null>(null);
	$effect(() => {
		if (typstPreviewWanted && !TypstPreviewComp) {
			import('$lib/typst/preview/TypstPreview.svelte').then(
				(mod) => (TypstPreviewComp = mod.default),
				(e) => console.error('Failed to load Typst preview chunk:', e)
			);
		}
	});

	interface Props {
		width: number;
		maxWidth?: number;
		/** when the main work area is narrow, this pane occupies the full column and can be switched */
		narrowMode?: boolean;
		narrowActive?: boolean;
		dockShrunk: boolean;
		pdfFilename: string;
		draftRoot: string;
		draftMainRel: string;
		draftTrigger: number;
		/** `host:port` of a running Typst preview, or null while one is still starting */
		typstPreviewHost: string | null;
		/**
		 * A Typst preview is what this pane is FOR, even before it has an address.
		 *
		 * Kept separate from the host so the pane never briefly shows the compiled PDF while the
		 * preview is being prepared - that flash is jarring and looks like a bug.
		 */
		typstPreviewWanted: boolean;
		/** compile the previewed document to a PDF on disk (the preview itself never writes one) */
		onSaveTypstPdf: () => Promise<void>;
		/** one-shot jump of the preview to the editor caret; null hides the floating sync button */
		onSyncToCursor?: (() => void) | null;
		/** a splitter is being dragged; the frame holds its size rather than reflowing every frame */
		paneDragging: boolean;
		pdfPaneRef?: { scrollToPosition: (page: number, x: number, y: number, w?: number, h?: number) => void };
		draftRef?: DraftView | null;
		onStartResize: (e: MouseEvent) => void;
		onResizeByKey: (e: KeyboardEvent) => void;
		onClose: () => void;
		onPageClick: (page: number, x: number, y: number, selectText?: string) => void;
		onInverseSync: (file: string, line: number, selectText?: string) => void;
		onSettled: () => void;
		/** the finished compile's log path, for the Problems panel */
		onDiagnostics: (logPath: string) => void;
	}
	let {
		width,
		maxWidth = 960,
		narrowMode = false,
		narrowActive = false,
		dockShrunk,
		pdfFilename,
		draftRoot,
		draftMainRel,
		draftTrigger,
		typstPreviewHost,
		typstPreviewWanted,
		onSaveTypstPdf,
		onSyncToCursor = null,
		paneDragging,
		pdfPaneRef = $bindable(),
		draftRef = $bindable(),
		onStartResize,
		onResizeByKey,
		onClose,
		onPageClick,
		onInverseSync,
		onSettled,
		onDiagnostics
	}: Props = $props();
</script>

<PaneSplitter
	resizable
	resizeLabel={m.wsview_resize_pdf_preview_aria()}
	value={Math.min(width, maxWidth)}
	minValue={280}
	maxValue={maxWidth}
	{onStartResize}
	{onResizeByKey}
	toggle={{ icon: ChevronRight, onclick: onClose, title: m.wsview_toggle_pdf_preview(), ariaLabel: m.wsview_toggle_pdf_preview() }}
	class="workbench-preview-splitter z-20"
	style="grid-column: 2; grid-row: {dockShrunk ? '2 / -1' : '2'}"
/>
<!-- no border-l: the splitter's own 1px IS the rule now, and a border beside it read as two -->
<aside
	class="workbench-preview-panel relative flex shrink-0 flex-col"
	data-inactive={narrowMode && !narrowActive}
	role={narrowMode ? 'tabpanel' : undefined}
	id={narrowMode ? 'workbench-preview-panel' : undefined}
	aria-labelledby={narrowMode ? 'workbench-preview-tab' : undefined}
	aria-hidden={narrowMode && !narrowActive}
	inert={narrowMode && !narrowActive}
	style={narrowMode
		? 'width: 100%; min-width: 0; grid-column: 1; grid-row: 2'
		: `width: ${width}px; grid-column: 3; grid-row: ${dockShrunk ? '2 / -1' : '2'}`}
>
	{#if onSyncToCursor}
		<!-- forward sync rides the same divider, high and clear of the collapse lozenge. -12.5px
		     centres a 24px chip on the rule, matching the lozenge below it. This one is wider than
		     the 3px the panes hold clear, so it does cross the scrollbar - it is also the one you
		     press once and forget, rather than something parked on the line.

		     top-28, not Overleaf's own 68px: their toolbars are not ours. Here the editor's tab
		     strip (h-9) and format toolbar (min-h-10) put a horizontal rule at 76px, and a chip at
		     68 spans 68-92 - so that rule ran straight through it. 112px clears the toolbar
		     entirely, which is where this sat before and why. Round rather than a
		     lozenge because it acts on the document, not on the boundary. The reverse direction
		     needs no button: a click in the preview is the inverse jump. -->
		<PaneHandle
			icon={ArrowRight}
			class="top-28 -left-[12.5px]"
			onclick={onSyncToCursor}
			title={typstPreviewWanted ? m.wsview_sync_to_preview_title() : m.wsview_sync_to_pdf_title()}
			ariaLabel={typstPreviewWanted ? m.wsview_sync_to_preview_aria() : m.wsview_sync_to_pdf_aria()}
		/>
	{/if}
	{#if !typstPreviewWanted}
		<!-- h-9 matches the editor column's tab strip, so the two header borders draw one line -->
		<div
			class="bg-surface-100-900 text-surface-600-300 border-surface-200-800 flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs"
		>
			<span class="font-medium">
				{#if $settings.draftMode}
					{m.wsview_live_preview_label()}
				{:else}
					{m.wsview_pdf_preview_label()}
				{/if}
			</span>
			<div class="flex items-center gap-1">
				<button
					class="hover:preset-tonal rounded p-1"
					onclick={onClose}
					title={m.wsview_close_preview()}
					aria-label={m.wsview_close_preview()}
				>
					<X class="size-4" />
				</button>
			</div>
		</div>
	{/if}
	<div class="min-h-0 flex-1">
		{#if typstPreviewWanted}
			<!-- tinymist's document stream, rendered in-pane. Takes precedence over the compiled PDF:
			     it is the same document and it is ahead of it, since it needs no save. Rendered on
			     `wanted` rather than on the host so the PDF never flashes up while it starts. -->
			{#if TypstPreviewComp}
				<TypstPreviewComp host={typstPreviewHost} {paneDragging} {onSaveTypstPdf} {onClose} />
			{/if}
		{:else if $settings.draftMode}
			{#if DraftViewComp}
				<DraftViewComp
					bind:this={draftRef}
					root={draftRoot}
					mainFile={draftMainRel}
					trigger={draftTrigger}
					{onInverseSync}
					{onSettled}
					{onDiagnostics}
				/>
			{/if}
		{:else}
			<PDFViewer bind:this={pdfPaneRef} filename={pdfFilename} {onPageClick} />
		{/if}
	</div>
</aside>
