<script lang="ts">
	import { preventDefault } from 'svelte/legacy';

	import { Search, Undo, Redo, Bold, Underline, Italic, Code, BoxSelect, Eye } from '@lucide/svelte';
	import { selectParentNode } from 'prosemirror-commands';
	import ToolbarTable from './ToolbarTable.svelte';
	import TextColorDropdown from './TextColorDropdown.svelte';
	import HighlightDropdown from './HighlightDropdown.svelte';
	import { markIsActive, activeMarkColor } from './markState';
	import { displaySearchBarStore, editorViewStore, rawEditorActiveStore } from '../../../stores/editorStore';
	import { previewStore } from '$lib/stores/previewStore';
	import { schema } from '$lib/schema/schema';
	import { setHeadingLevel, setParagraphIndent, type ParagraphIndent } from '../../helperCommands';
	import HeadingDropdown from './HeadingDropdown.svelte';
	import ParagraphIndentDropdown from './ParagraphIndentDropdown.svelte';
	import TextFormattingControls from './TextFormattingControls.svelte';
	import SupSubDropdown from './SupSubDropdown.svelte';
	import { createCodeBlock } from '../../extensions/codemirrorbridge/cmcommands';
	import { toggleMark } from 'prosemirror-commands';
	import MathDropdown from './MathDropdown.svelte';
	import MathToolbar, { mathToolbarState } from './MathToolbar.svelte';
	import { undo, redo } from 'prosemirror-history';
	import { currentlyCompilingStore } from '$lib/stores/pdfStore';
	import { isReadOnly } from '$lib/stores/permissionStore';
	import { onMount } from 'svelte';
	import MobileActionBar from './MobileActionBar.svelte';
	import ToolbarOverflow from './ToolbarOverflow.svelte';
	import type { OverflowItem } from './toolbarOverflow';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		// hides the Preview/Compile buttons
		minimal?: boolean;
	}

	let { minimal = false }: Props = $props();

	let isCompiling = $derived($currentlyCompilingStore);
	let isPreviewVisible = $derived($previewStore.isVisible);

	let isMathfieldActive = $state(false);

	type ActiveCommandsType = { strong?: boolean; em?: boolean; u?: boolean; sup?: boolean; sub?: boolean };
	let activeCommands: ActiveCommandsType = $state({});
	let currentHeadingLevel = $state(0);
	let currentHeadingNumbered = $state(true);
	let currentParagraphIndent = $state<ParagraphIndent>('auto');
	let paragraphIndentAvailable = $state(false);

	// Whether a mathfield is focused - which decides whether MathToolbar exists at all.
	//
	// Focus landing on the math toolbar's own palette does NOT mean the user left their equation.
	// Treating it as such unmounted the toolbar between mousedown and click on a symbol button: the
	// button was gone before the click could dispatch, so nothing inserted and nothing reported it,
	// because the handler never ran. Repro was two symbols in a row - the second one vanished.
	function updateMathfieldState() {
		setTimeout(() => {
			const active = document.activeElement;
			if (active instanceof window.MathfieldElement) {
				isMathfieldActive = true;
				return;
			}
			// our own palette (portalled, hence [data-scope]) or anything inside this toolbar: the user
			// is still working on the equation, so hold the previous answer rather than tearing down
			if (active instanceof Element && active.closest('[data-scope], [data-math-toolbar]')) return;
			isMathfieldActive = false;
		}, 0);
	}

	onMount(() => {
		window.addEventListener('focusin', updateMathfieldState);
		// custom event, see the monkey patch in mlview.ts
		window.addEventListener('ml:focusin', updateMathfieldState);
		window.addEventListener('focusout', updateMathfieldState);
		return () => {
			window.removeEventListener('focusin', updateMathfieldState);
			window.removeEventListener('ml:focusin', updateMathfieldState);
			window.removeEventListener('focusout', updateMathfieldState);
		};
	});

	function keepEditorFocus(cmd: (state, dispatch) => boolean) {
		return (e: MouseEvent) => {
			e.preventDefault();
			cmd($editorViewStore.state, $editorViewStore.dispatch);
			$editorViewStore.focus();
		};
	}

	let activeTextColor = $state<string | null>(null);
	let activeHighlightColor = $state<string | null>(null);

	$effect(() => {
		if ($editorViewStore) {
			activeCommands = {
				strong: markIsActive($editorViewStore.state, schema.marks.strong),
				em: markIsActive($editorViewStore.state, schema.marks.em),
				u: markIsActive($editorViewStore.state, schema.marks.u),
				sup: markIsActive($editorViewStore.state, schema.marks.sup),
				sub: markIsActive($editorViewStore.state, schema.marks.sub)
			};

			activeTextColor = activeMarkColor($editorViewStore.state, schema.marks.textcolor);
			activeHighlightColor = activeMarkColor($editorViewStore.state, schema.marks.highlight);

			const node = $editorViewStore.state.selection.$from.node($editorViewStore.state.selection.$from.depth);
			const inHeading = node?.type?.name === 'heading';
			currentHeadingLevel = inHeading ? node.attrs.level : 0;
			currentHeadingNumbered = inHeading ? node.attrs.numbered !== false : true;

			const selectionFrom = $editorViewStore.state.selection.$from;
			paragraphIndentAvailable = false;
			currentParagraphIndent = 'auto';
			for (let depth = selectionFrom.depth; depth >= 0; depth--) {
				const parent = selectionFrom.node(depth);
				if (parent.type.name !== 'paragraph') continue;
				paragraphIndentAvailable = true;
				currentParagraphIndent = (parent.attrs.indent ?? 'auto') as ParagraphIndent;
				break;
			}
		}
	});

	function applyHeading(level: number, numbered: boolean) {
		setHeadingLevel(level, numbered)($editorViewStore.state, $editorViewStore.dispatch);
		$editorViewStore.focus();
	}

	function applyParagraphIndent(indent: ParagraphIndent) {
		if (!$editorViewStore || !paragraphIndentAvailable) return;
		setParagraphIndent(indent)($editorViewStore.state, $editorViewStore.dispatch);
		$editorViewStore.focus();
	}

	// read breakpoints from CSS variables so logic stays in sync with the Tailwind config
	function getCssBreakpoint(name: string, fallback: number): number {
		if (typeof window === 'undefined') return fallback;
		const v = getComputedStyle(document.documentElement).getPropertyValue(name)?.trim();
		const px = v?.endsWith('px') ? parseFloat(v) : Number(v);
		return Number.isFinite(px) && px! > 0 ? (px as number) : fallback;
	}
	const mdBp = getCssBreakpoint('--breakpoint-md', 768);
	// preview only at >= md; the mobile action bar handles smaller screens
	function isPreviewAllowed() {
		if (typeof window === 'undefined') return true;
		return window.matchMedia(`(min-width: ${mdBp}px)`).matches;
	}

	function togglePreview() {
		if (!isPreviewAllowed()) return; // keep behavior in sync with visibility
		previewStore.update((state) => ({ ...state, isVisible: !state.isVisible }));
		const element = document.querySelector('.wrapper');
		if ($previewStore.isVisible) {
			element?.classList.add('moble-box');
			element?.classList.remove('box-show');
		} else {
			element?.classList.add('box-show');
			element?.classList.remove('moble-box');
		}
	}

	function showPreview() {
		if (!isPreviewAllowed()) return; // no preview below sm breakpoint
		previewStore.update((state) => ({ ...state, isVisible: true }));
		const element = document.querySelector('.wrapper');
		element?.classList.add('moble-box');
		element?.classList.remove('box-show');
	}

	function handleCompile() {
		if (isCompiling) return;

		if (isPreviewAllowed()) showPreview();
		currentlyCompilingStore.set(true);

		// EditorView.svelte listens for this event
		window.dispatchEvent(new CustomEvent('compile'));
	}

	// preventDefault on mousedown anywhere in the toolbar so clicks never steal focus from
	// PM/mathfield; otherwise Skeleton's Popover loses the focus race on close and the next
	// keystroke goes nowhere. click handlers still fire.
	function preventEditorFocusLoss(e: MouseEvent) {
		e.preventDefault();
	}
</script>

<div class="flex min-w-0 flex-1 items-center gap-3 sm:gap-4" data-keep-caret role="presentation" onmousedown={preventEditorFocusLoss}>
	<div class="flex min-w-0 flex-1 items-center">
		<!-- item gaps and divider padding use the same step per breakpoint, so the border sits centered in its gap -->
		<div class="text-surface-800-200 flex min-h-9 min-w-0 flex-1 items-center gap-2 sm:gap-3 2xl:gap-4">
			<ul class="border-surface-300-700 flex shrink-0 items-center gap-2 border-r pr-2 sm:gap-3 sm:pr-3 2xl:gap-4 2xl:pr-4">
				<li class="toolbarButton hover:preset-tonal">
					<button
						onclick={() => {
							displaySearchBarStore.set(!$displaySearchBarStore);
						}}
						class="flex items-center p-1"
					>
						<Search class="h-5 w-5" />
					</button>
				</li>
			</ul>

			{#if $isReadOnly}
				<div class="text-surface-500 flex items-center gap-1.5">
					<Eye class="size-4" />
					<span class="text-sm font-medium">{m.toolbar_read_only()}</span>
				</div>
			{:else}
				<ul class="border-surface-300-700 flex shrink-0 items-center gap-2 border-r pr-2 sm:gap-3 sm:pr-3 2xl:gap-4 2xl:pr-4">
					<li class="toolbarButton hover:preset-tonal">
						<button onclick={keepEditorFocus(undo)} class="flex items-center p-1" aria-label={m.toolbar_undo_aria()}>
							<Undo class="h-5 w-5" />
						</button>
					</li>
					<li class="toolbarButton hover:preset-tonal">
						<button onclick={keepEditorFocus(redo)} class="flex items-center p-1" aria-label={m.toolbar_redo_aria()}>
							<Redo class="h-5 w-5" />
						</button>
					</li>
				</ul>

				{#if $rawEditorActiveStore}
					<!-- a raw-LaTeX CM block is focused: prose formatting doesn't apply, show a minimal bar -->
					<!-- Sheds the hint first, then the whole indicator - icon included. A bare icon left
					     behind reads as a button you can press, and this is a status label, not a control.
					     Container queries, not sm:, which measures the WINDOW: a wide window with a narrow
					     editor pane kept showing the hint and it wrapped onto a second line. -->
					<div class="text-surface-600-300 hidden min-h-9 min-w-0 items-center gap-2 text-sm whitespace-nowrap @sm:flex">
						<Code class="size-4 shrink-0" />
						<span class="font-medium">{m.toolbar_latex_code()}</span>
						<span class="text-surface-500 hidden @xl:inline">{m.toolbar_latex_code_hint()}</span>
					</div>
				{:else if isMathfieldActive || mathToolbarState.aiInputActive || mathToolbarState.paletteOpen}
					<MathToolbar />
				{:else}
					{#snippet tb_heading(_item: OverflowItem)}
						<div>
							<HeadingDropdown level={currentHeadingLevel} numbered={currentHeadingNumbered} onSelect={applyHeading} />
						</div>
					{/snippet}
					{#snippet tb_paragraphindent(_item: OverflowItem)}
						<div>
							<ParagraphIndentDropdown
								value={currentParagraphIndent}
								onSelect={applyParagraphIndent}
								disabled={!paragraphIndentAvailable}
							/>
						</div>
					{/snippet}
					{#snippet tb_textformat(_item: OverflowItem)}
						<TextFormattingControls />
					{/snippet}
					{#snippet tb_bold(_item: OverflowItem)}
						<div class={`toolbarButton ${activeCommands.strong ? 'preset-tonal-primary' : 'hover:preset-tonal'}`}>
							<button
								onclick={keepEditorFocus((s, d) => toggleMark(schema.marks.strong)(s, d))}
								class="flex items-center p-1"
								aria-label={m.toolbar_bold_aria()}
							>
								<Bold class="h-5 w-5" />
							</button>
						</div>
					{/snippet}
					{#snippet tb_underline(_item: OverflowItem)}
						<div class={`toolbarButton ${activeCommands.u ? 'preset-tonal-primary' : 'hover:preset-tonal'}`}>
							<button
								onclick={keepEditorFocus((s, d) => toggleMark(schema.marks.u)(s, d))}
								class="flex items-center p-1"
								aria-label={m.toolbar_underline_aria()}
							>
								<!-- nudged down 1.5px, lucide's U glyph rides high of the other icons' center line -->
								<Underline class="h-5 w-5 translate-y-[1.5px]" />
							</button>
						</div>
					{/snippet}
					{#snippet tb_italic(_item: OverflowItem)}
						<div class={`toolbarButton ${activeCommands.em ? 'preset-tonal-primary' : 'hover:preset-tonal'}`}>
							<button
								onclick={keepEditorFocus((s, d) => toggleMark(schema.marks.em)(s, d))}
								class="flex items-center p-1"
								aria-label={m.toolbar_italic_aria()}
							>
								<Italic class="h-5 w-5" />
							</button>
						</div>
					{/snippet}
					{#snippet tb_supsub(_item: OverflowItem)}
						<div>
							<SupSubDropdown
								sup={!!activeCommands.sup}
								sub={!!activeCommands.sub}
								onToggle={(which) => {
									toggleMark(schema.marks[which])($editorViewStore.state, $editorViewStore.dispatch);
									$editorViewStore.focus();
								}}
							/>
						</div>
					{/snippet}
					{#snippet tb_textcolor(_item: OverflowItem)}
						<div>
							<TextColorDropdown {activeTextColor} />
						</div>
					{/snippet}
					{#snippet tb_highlight(_item: OverflowItem)}
						<div>
							<HighlightDropdown {activeHighlightColor} />
						</div>
					{/snippet}
					{#snippet tb_math(_item: OverflowItem)}
						<div>
							<MathDropdown />
						</div>
					{/snippet}
					{#snippet tb_table(_item: OverflowItem)}
						<div>
							<ToolbarTable />
						</div>
					{/snippet}
					{#snippet tb_code(_item: OverflowItem)}
						<div class="toolbarButton hover:preset-tonal">
							<button
								class="flex items-center p-1"
								onclick={() => {
									createCodeBlock()($editorViewStore.state, $editorViewStore.dispatch);
								}}
								aria-label={m.toolbar_insert_code_block_aria()}
							>
								<Code class="h-5 w-5" />
							</button>
						</div>
					{/snippet}
					{#snippet tb_selectblock(_item: OverflowItem)}
						<div class="toolbarButton hover:preset-tonal">
							<button
								class="flex items-center p-1"
								onclick={keepEditorFocus(selectParentNode)}
								aria-label={m.toolbar_select_block_aria()}
								title={m.toolbar_select_parent_block_title()}
							>
								<BoxSelect class="h-5 w-5" />
							</button>
						</div>
					{/snippet}

					<ToolbarOverflow
						gapClass="gap-3 2xl:gap-4"
						menuLabel={m.toolbar_more_actions_aria()}
						items={[
							{ id: 'heading', pinned: true, render: tb_heading },
							{ id: 'paragraphindent', render: tb_paragraphindent },
							{ id: 'textformat', render: tb_textformat },
							{ id: 'bold', pinned: true, render: tb_bold },
							{ id: 'underline', pinned: true, render: tb_underline },
							{ id: 'italic', pinned: true, render: tb_italic },
							{ id: 'supsub', render: tb_supsub },
							{ id: 'textcolor', render: tb_textcolor },
							{ id: 'highlight', render: tb_highlight },
							{ id: 'math', render: tb_math },
							{ id: 'table', render: tb_table },
							{ id: 'code', render: tb_code },
							{ id: 'selectblock', render: tb_selectblock }
						]}
					/>
				{/if}
			{/if}
		</div>
	</div>

	{#if !minimal}
		<div class="flex-1"></div>

		<ul class="mt-4 flex items-center gap-4 sm:mt-0">
			<li class="hidden md:block">
				<button
					class="text-blue border-blue hover:bg-blue font-Work-Sans flex h-9 w-full items-center justify-center rounded border text-sm font-semibold transition-all duration-500 ease-in-out hover:text-white sm:w-[83px]"
					onclick={preventDefault(togglePreview)}
				>
					{isPreviewVisible ? m.toolbar_hide() : m.toolbar_preview()}
				</button>
			</li>
			<li class="hidden md:block">
				<button
					data-tour="compile-button"
					data-compiling={isCompiling}
					onclick={preventDefault(handleCompile)}
					disabled={isCompiling}
					class="border-blue bg-blue hover:text-blue font-Work-Sans flex h-9 w-full items-center justify-center rounded border text-sm font-semibold text-white transition-all duration-500 ease-in-out hover:bg-transparent disabled:cursor-not-allowed disabled:opacity-50 sm:w-[125px]"
				>
					{#if isCompiling}
						<span class="loader"></span>
						{m.toolbar_compiling()}
					{:else}
						{m.toolbar_compile()}
					{/if}
				</button>
			</li>
		</ul>
	{/if}
</div>

{#if !minimal}
	<MobileActionBar />
{/if}

<style lang="postcss">
	@reference "../../../../app.css";

	.toolbarButton {
		@apply rounded-base transition-all ease-in-out;
	}

	.loader {
		border: 2px solid #f3f3f3;
		border-top: 2px solid #3498db;
		border-radius: 50%;
		width: 14px;
		height: 14px;
		animation: spin 1s linear infinite;
		margin-right: 8px;
	}

	@keyframes spin {
		0% {
			transform: rotate(0deg);
		}
		100% {
			transform: rotate(360deg);
		}
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
