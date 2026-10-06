<script lang="ts">
	// The editor's top bar: sidebar toggle, word count, the visual/source toggle, and the
	// compile / preview / save controls. Pure chrome driven by props + callbacks. The open-file
	// tabs live on their own strip below (TabBar in EditorPane).
	import { settings } from '$lib/settings';
	import { isDirty } from '$lib/workspace/workspaceStore';
	import { compileLog } from '$lib/stores/compileLogStore';
	import WordCount from './WordCount.svelte';
	import CompileButton, { COMPILE_TONE } from './CompileButton.svelte';
	import type { ComponentProps } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import {
		FileText,
		Eye,
		Code,
		Square,
		Play,
		ChevronDown,
		Settings2,
		CircleAlert,
		TriangleAlert,
		Save,
		Loader2,
		ShieldQuestion
	} from '@lucide/svelte';

	interface Props {
		loadedPath: string | null;
		kind: string;
		viewMode: 'visual' | 'source' | 'diff';
		terminalAvailable: boolean;
		compiling: boolean;
		/** the preview pane is (or is about to be) a Typst live preview; see WorkspaceView */
		typstPreviewWanted: boolean;
		pdfPaneOpen: boolean;
		narrow?: boolean;
		activePane?: 'document' | 'preview';
		draftPaused: boolean;
		saving: boolean;
		modLabel: string;
		onSetViewMode: (m: 'visual' | 'source') => void;
		onStopCompile: () => void;
		onPauseDraft: () => void;
		onResumeDraft: () => void;
		onCompile: () => void;
		/** the project asks for an unaccepted compile command; the slot shows blocked (see runCompile) */
		commandPending?: boolean;
		onConfigureCompile: () => void;
		onShowProblems: () => void;
		onSelectPane?: (pane: 'document' | 'preview') => void;
		onTogglePdf: () => void;
		onSave: () => void;
	}
	let {
		loadedPath,
		kind,
		viewMode,
		terminalAvailable,
		compiling,
		typstPreviewWanted,
		pdfPaneOpen,
		narrow = false,
		activePane = 'document',
		draftPaused,
		saving,
		modLabel,
		onSetViewMode,
		onStopCompile,
		onPauseDraft,
		onResumeDraft,
		onCompile,
		commandPending = false,
		onConfigureCompile,
		onShowProblems,
		onSelectPane = () => {},
		onTogglePdf,
		onSave
	}: Props = $props();

	let compileMenuOpen = $state(false);
	let documentTab = $state<HTMLButtonElement>();
	let previewTab = $state<HTMLButtonElement>();

	function handlePaneTabKeydown(event: KeyboardEvent) {
		const next =
			event.key === 'ArrowRight' || event.key === 'End' ? 'preview' : event.key === 'ArrowLeft' || event.key === 'Home' ? 'document' : null;
		if (!next) return;
		event.preventDefault();
		onSelectPane(next);
		queueMicrotask(() => (next === 'document' ? documentTab : previewTab)?.focus());
	}

	// Typst's Preview replaces Compile the way LaTeX's live mode does: same slot, same states.
	// Driven by the same flag the preview pane branches on - sticky across tabs - so the green
	// Live button does not flip back to Compile when a .bib or an image has focus.
	const typstLive = $derived(typstPreviewWanted);

	/**
	 * What the compile slot is right now: colour, icon, label and click, in one place.
	 *
	 * The state used to be a five-branch chain of near-identical <button> blocks, with the
	 * conditions repeated a sixth time to colour the chevron - so the two could disagree, and did.
	 * One descriptor drives both.
	 */
	const compile = $derived.by((): ComponentProps<typeof CompileButton> => {
		// The project names a command this machine has not accepted: nothing compiles until the
		// banner is answered, so the button says so instead of looking live and refusing on click.
		// This is presentation only - runCompile holds the actual gate, for the six other ways in.
		if (commandPending)
			return {
				tone: 'warning',
				icon: ShieldQuestion,
				label: m.wsview_compile_label(),
				title: m.project_command_blocked_desc(),
				disabled: true,
				onclick: () => {}
			};
		if (compiling)
			return {
				tone: 'stop',
				icon: Square,
				label: m.wsview_stop_label(),
				title: m.wsview_stop_compile_title({ combo: `${modLabel}+Alt+Enter` }),
				onclick: onStopCompile
			};
		// the preview is attached; closing the pane is its stop (the pane detaches the server task
		// on close), so this is both indicator and off switch
		if (typstLive && pdfPaneOpen)
			return { tone: 'success', dot: true, label: m.wsview_live_label(), title: m.wsview_typst_preview_live_title(), onclick: onTogglePdf };
		if ($settings.draftMode && pdfPaneOpen) {
			if (draftPaused)
				return {
					tone: 'warning',
					icon: Play,
					label: m.wsview_paused_label(),
					title: m.wsview_engine_stopped_title(),
					onclick: onResumeDraft
				};
			return {
				tone: 'success',
				dot: true,
				label: m.wsview_live_label(),
				title: m.wsview_live_preview_running_title(),
				onclick: onPauseDraft
			};
		}
		const live = typstLive || $settings.draftMode;
		return {
			tone: 'primary',
			icon: Play,
			label: live ? m.wsview_preview_label() : m.wsview_compile_label(),
			title: live ? m.wsview_open_live_preview_title() : m.wsview_compile_title({ combo: `${modLabel}+Alt+Enter` }),
			onclick: onCompile
		};
	});
</script>

<header class="workbench-topbar border-surface-200-800 col-span-full flex h-12 items-center justify-between gap-3 border-b px-4">
	<!-- the sidebar and preview toggles used to bracket this row. Both moved onto the divider of the
	     pane they open (WorkspaceChrome / PreviewPane), where the control sits on the boundary it
	     moves - so this row is only about the document -->
	<div class="workbench-topbar-info flex min-w-0 items-center gap-2">
		{#if !loadedPath}
			<FileText class="text-surface-400 size-4 shrink-0" />
			<span class="truncate text-sm font-medium">{m.wsview_no_file()}</span>
		{/if}
		{#if loadedPath && (kind === 'tex' || kind === 'md' || kind === 'typ') && (viewMode === 'visual' || viewMode === 'source')}
			<span class="shrink-0"><WordCount /></span>
		{/if}
	</div>
	{#if narrow}
		<div
			class="workbench-pane-tabs border-surface-300-700 inline-flex min-w-0 rounded-md border p-0.5 text-xs"
			role="tablist"
			tabindex="-1"
			aria-label="{m.wsview_badge_document()} / {m.wsview_pdf_preview_label()}"
			onkeydown={handlePaneTabKeydown}
		>
			<button
				bind:this={documentTab}
				class="workbench-pane-tab rounded px-3 py-1 {activePane === 'document'
					? 'bg-surface-200-800 text-surface-900-100 font-medium'
					: 'workbench-shell-quiet-hover'}"
				id="workbench-document-tab"
				role="tab"
				aria-controls="workbench-document-panel"
				aria-selected={activePane === 'document'}
				tabindex={activePane === 'document' ? 0 : -1}
				onclick={() => onSelectPane('document')}
			>
				{m.wsview_badge_document()}
			</button>
			<button
				bind:this={previewTab}
				class="workbench-pane-tab rounded px-3 py-1 {activePane === 'preview'
					? 'bg-surface-200-800 text-surface-900-100 font-medium'
					: 'workbench-shell-quiet-hover'}"
				id="workbench-preview-tab"
				role="tab"
				aria-controls="workbench-preview-panel"
				aria-selected={activePane === 'preview'}
				tabindex={activePane === 'preview' ? 0 : -1}
				onclick={() => onSelectPane('preview')}
			>
				{m.wsview_pdf_preview_label()}
			</button>
		</div>
	{/if}
	<div class="workbench-topbar-actions flex items-center gap-2">
		{#if loadedPath && (kind === 'tex' || kind === 'md' || kind === 'typ' || kind === 'bib')}
			<!-- visual/source toggle; for .bib it's the reference editor vs raw BibTeX -->
			<div class="border-surface-300-700 inline-flex shrink-0 overflow-hidden rounded-md border text-xs">
				<button
					class="flex items-center gap-1 px-2.5 py-1 {viewMode === 'visual' ? 'workbench-action-filled' : 'workbench-shell-quiet-hover'}"
					onclick={() => onSetViewMode('visual')}
					title={m.wsview_visual_editor_title()}
				>
					<Eye class="size-3.5" />
					{m.wsview_visual_label()}
				</button>
				<button
					class="flex items-center gap-1 px-2.5 py-1 {viewMode === 'source' ? 'workbench-action-filled' : 'workbench-shell-quiet-hover'}"
					onclick={() => onSetViewMode('source')}
					title={kind === 'typ' ? m.wsview_typst_source_title() : m.wsview_latex_source_title()}
				>
					<Code class="size-3.5" />
					{m.wsview_source_label()}
				</button>
			</div>
		{/if}
		{#if $compileLog && ($compileLog.errors.length > 0 || $compileLog.warnings.length > 0)}
			<button
				class="btn btn-xs workbench-problem-badge gap-1 {$compileLog.errors.length > 0
					? 'workbench-problem-error'
					: 'workbench-problem-warning'}"
				onclick={onShowProblems}
				title={m.wsview_show_problems_title()}
			>
				{#if $compileLog.errors.length > 0}
					<CircleAlert class="size-3.5" /> {$compileLog.errors.length}
				{/if}
				{#if $compileLog.warnings.length > 0}
					<TriangleAlert class="size-3.5" /> {$compileLog.warnings.length}
				{/if}
			</button>
		{/if}
		{#if terminalAvailable}
			<!-- the one-shot sync-to-cursor button used to sit here; it lives on the preview pane's
			     own header now (PreviewPane / TypstPreview) - the button moves THAT pane -->
			<div class="relative flex items-center">
				<CompileButton {...compile} />
				<!-- border-l-0: the button's right edge already draws the seam, and two hairlines
				     meeting there would read as a heavier line than the outline itself -->
				<button
					class="btn btn-xs workbench-compile-menu {COMPILE_TONE[compile.tone]} rounded-l-none self-stretch border-l-0 px-1"
					onclick={() => (compileMenuOpen = !compileMenuOpen)}
					title={m.wsview_compile_options()}
					aria-label={m.wsview_compile_options()}
					aria-haspopup="menu"
					aria-expanded={compileMenuOpen}
				>
					<ChevronDown class="size-3.5 transition-transform {compileMenuOpen ? 'rotate-180' : ''}" />
				</button>
				{#if compileMenuOpen}
					<!-- click-away layer -->
					<button class="fixed inset-0 z-1200 cursor-default" onclick={() => (compileMenuOpen = false)} tabindex="-1" aria-hidden="true"
					></button>
					<div class="card bg-surface-50-950 border-surface-300-700 absolute top-full right-0 z-1300 mt-1 w-max border p-1 shadow-xl">
						<button
							class="workbench-shell-quiet-hover flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm whitespace-nowrap"
							onclick={() => {
								compileMenuOpen = false;
								onConfigureCompile();
							}}
						>
							<Settings2 class="size-4 shrink-0" />
							{m.wsview_configure_compile_command()}
						</button>
					</div>
				{/if}
			</div>
		{/if}
		<button class="btn btn-xs workbench-action-filled gap-1.5" onclick={onSave} disabled={!loadedPath || saving || !$isDirty}>
			{#if saving}<Loader2 class="size-4 animate-spin" />{:else}<Save class="size-4" />{/if}
			{m.wsview_save_label()}
		</button>
	</div>
</header>
