<script lang="ts">
	import {
		ZoomIn,
		ZoomOut,
		MoveHorizontal,
		RotateCcw,
		RotateCw,
		Search,
		ChevronLeft,
		ChevronRight,
		Download,
		Presentation,
		MoreHorizontal
	} from '@lucide/svelte';
	import { getPdfViewerContext } from './pdf-viewer/context';

	const { state: viewerState, actions } = getPdfViewerContext();

	let searchInput = $state('');

	// Collapse into a trailing "..." rather than scrolling controls out of reach. Only the optional
	// ones move: rotate and presentation and download. Page number, zoom and search always stay on
	// the bar. Deliberately a copy of the app's ToolbarOverflow rather than an import - this package
	// is a dependency OF that app, so the dependency cannot point the other way.
	// collapse order, first goes first. Only the search box and Fit Width are missing from this
	// list: those two stay on the bar at every width.
	const COLLAPSIBLE = ['extras', 'rotate', 'zoom', 'page'] as const;
	let row = $state<HTMLDivElement>();
	let menuButton = $state<HTMLButtonElement>();
	let menuEl = $state<HTMLDivElement>();
	let menuOpen = $state(false);
	let menuPos = $state({ top: 0, right: 0 });
	let collapsed = $state(0);

	function toggleMenu() {
		if (!menuOpen && menuButton) {
			const r = menuButton.getBoundingClientRect();
			menuPos = { top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) };
		}
		menuOpen = !menuOpen;
	}
	const hiddenIds = $derived(new Set(COLLAPSIBLE.slice(0, collapsed)));
	// row width when each step was taken; restoring only above it keeps the loop from oscillating
	const widthAt: number[] = [];
	let frame = 0;

	function schedule() {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			fit();
		});
	}
	function fit() {
		const el = row;
		if (!el) return;
		const over = el.scrollWidth > el.clientWidth + 1;
		if (over && collapsed < COLLAPSIBLE.length) {
			widthAt[collapsed + 1] = el.clientWidth;
			collapsed++;
			schedule();
			return;
		}
		if (!over && collapsed > 0 && el.clientWidth > (widthAt[collapsed] ?? 0) + 8) {
			collapsed--;
			schedule();
			return;
		}
	}
	// Dismiss on any pointer down outside, and on Escape. Deliberately NOT a scrim element: a scrim
	// only intercepts clicks if it paints above everything, and inside a component it competes in
	// whatever stacking context it lands in - the PDF canvas painted over it and ate the click.
	$effect(() => {
		if (!menuOpen) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && (menuEl?.contains(t) || menuButton?.contains(t))) return;
			// A control in the menu may open a popover that PORTALS to document.body - the math symbol
			// grids do. That content is outside menuEl by construction, so treating it as "outside"
			// tore the menu down mid-click: the symbol never inserted and the mathfield lost focus.
			if (t instanceof Element && t.closest('[data-scope]')) return;
			menuOpen = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') menuOpen = false;
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('keydown', onKey, true);
		};
	});

	$effect(() => {
		const el = row;
		if (!el) return;
		const ro = new ResizeObserver(schedule);
		ro.observe(el);
		schedule();
		return () => {
			ro.disconnect();
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		};
	});

	function handlePageChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const pageNum = parseInt(input.value, 10);
		if (pageNum >= 1 && pageNum <= viewerState.totalPages) {
			actions.goToPage(pageNum);
		}
	}

	async function handleSearch() {
		if (!searchInput.trim()) {
			actions.clearSearch();
			return;
		}
		await actions.search(searchInput);
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			if (e.shiftKey) {
				actions.searchPrevious();
			} else if (viewerState.searchTotal > 0) {
				actions.searchNext();
			} else {
				handleSearch();
			}
		}
	}
</script>

<div class="pdf-toolbar" bind:this={row}>
	{#snippet pdfPage()}
		<div class="pdf-toolbar-group">
			<input
				type="number"
				value={viewerState.currentPage}
				min="1"
				max={viewerState.totalPages}
				onchange={handlePageChange}
				aria-label="Current page"
			/>
			<span class="page-info">/ {viewerState.totalPages}</span>
		</div>
	{/snippet}
	{#if !hiddenIds.has('page')}{@render pdfPage()}{/if}

	{#snippet pdfZoom()}
		<div class="pdf-toolbar-group">
			<button onclick={() => actions.zoomOut()} aria-label="Zoom out" title="Zoom Out">
				<ZoomOut size={16} />
			</button>
			<span class="zoom-level">{Math.round(viewerState.scale * 100)}%</span>
			<button onclick={() => actions.zoomIn()} aria-label="Zoom in" title="Zoom In">
				<ZoomIn size={16} />
			</button>
		</div>
	{/snippet}
	{#if !hiddenIds.has('zoom')}{@render pdfZoom()}{/if}

	<!-- pinned: Fit Width is the one zoom control worth keeping at any width -->
	<div class="pdf-toolbar-group">
		<button onclick={() => actions.fitWidth()} aria-label="Fit width" title="Fit Width">
			<MoveHorizontal size={16} />
		</button>
	</div>

	{#snippet pdfRotate()}
		<div class="pdf-toolbar-group">
			<button onclick={() => actions.rotateCounterClockwise()} aria-label="Rotate counter-clockwise" title="Rotate Left">
				<RotateCcw size={16} />
			</button>
			<button onclick={() => actions.rotateClockwise()} aria-label="Rotate clockwise" title="Rotate Right">
				<RotateCw size={16} />
			</button>
		</div>
	{/snippet}

	{#if !hiddenIds.has('rotate')}{@render pdfRotate()}{/if}

	<div class="pdf-toolbar-group">
		<input
			type="text"
			class="search-input"
			placeholder="Search..."
			bind:value={searchInput}
			onkeydown={handleSearchKeydown}
			aria-label="Search in document"
		/>
		<button onclick={handleSearch} disabled={viewerState.isSearching} aria-label="Search" title="Search">
			<Search size={16} />
		</button>
		{#if viewerState.searchTotal > 0}
			<button onclick={() => actions.searchPrevious()} aria-label="Previous match" title="Previous">
				<ChevronLeft size={16} />
			</button>
			<button onclick={() => actions.searchNext()} aria-label="Next match" title="Next">
				<ChevronRight size={16} />
			</button>
			<span class="match-info">{viewerState.searchCurrent}/{viewerState.searchTotal}</span>
		{/if}
	</div>

	{#snippet pdfExtras()}
		<div class="pdf-toolbar-group">
			<button onclick={() => actions.enterPresentationMode()} aria-label="Presentation Mode" title="Presentation Mode">
				<Presentation size={16} />
			</button>
			<button onclick={() => actions.download()} aria-label="Download PDF" title="Download">
				<Download size={16} />
			</button>
		</div>
	{/snippet}

	{#if !hiddenIds.has('extras')}{@render pdfExtras()}{/if}

	{#if collapsed > 0}
		<div class="pdf-toolbar-group pdf-overflow">
			<button bind:this={menuButton} onclick={toggleMenu} aria-label="More actions" title="More actions" aria-expanded={menuOpen}>
				<MoreHorizontal size={16} />
			</button>
			{#if menuOpen}
				<div bind:this={menuEl} class="pdf-overflow-menu" style="top: {menuPos.top}px; right: {menuPos.right}px" role="group">
					{#if hiddenIds.has('page')}{@render pdfPage()}{/if}
					{#if hiddenIds.has('zoom')}{@render pdfZoom()}{/if}
					{#if hiddenIds.has('rotate')}{@render pdfRotate()}{/if}
					{#if hiddenIds.has('extras')}{@render pdfExtras()}{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* all colors go through --pdf-toolbar-* custom properties (light defaults) so a host app
	   can theme the toolbar */
	.pdf-toolbar {
		display: flex;
		/* safe center: stays centered when it fits, but aligns to the start (no groups clipped
		   past the left edge) once it is tight */
		justify-content: safe center;
		align-items: center;
		/* matches the editor (ProseMirror/CodeMirror) and draft toolbars: a 40px bar, border included */
		min-height: 40px;
		box-sizing: border-box;
		gap: 0.5rem;
		padding: 0 0.5rem;
		background-color: var(--pdf-toolbar-bg, #ffffff);
		color: var(--pdf-toolbar-fg, #333);
		flex-shrink: 0;
		/* never wraps to a second row (it shifted the whole viewer down and read as a layout
		   glitch) and never scrolls either: a bar that does not fit collapses into the "..." */
		flex-wrap: nowrap;
		overflow: hidden;
		border-bottom: 1px solid var(--pdf-toolbar-border, #e0e0e0);
		/* No drop shadow. It is 40px like every other bar in the app, but the shadow spread its band
		   ~3px further, so it never read level with whatever the editor column had beside it - the
		   diff header most visibly. A leftover from pdf.js's light-theme chrome; no other bar here
		   has one, and the border already separates it from the page. */
	}

	.pdf-overflow {
		position: relative;
		margin-left: auto;
	}
	/* fixed, not absolute: the bar is an overflow-x container and clips a menu hanging below it,
	   so the button appeared to do nothing at all. coordinates come from the button's rect. */
	.pdf-overflow-menu {
		position: fixed;
		z-index: 50;
		max-width: min(22rem, calc(100vw - 1rem));
		flex-wrap: wrap;
		row-gap: 0.5rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem;
		border-radius: 6px;
		border: 1px solid var(--pdf-toolbar-border, #e0e0e0);
		background-color: var(--pdf-toolbar-bg, #ffffff);
		box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
	}

	.pdf-toolbar-group {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.pdf-toolbar button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--pdf-toolbar-btn-border, #e0e0e0);
		background-color: var(--pdf-toolbar-btn-bg, #fafafa);
		color: var(--pdf-toolbar-btn-fg, #555);
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.pdf-toolbar button:hover:not(:disabled) {
		background-color: var(--pdf-toolbar-btn-hover-bg, #f0f0f0);
		border-color: var(--pdf-toolbar-btn-hover-border, #d0d0d0);
		color: var(--pdf-toolbar-fg, #333);
	}

	.pdf-toolbar button:active:not(:disabled) {
		background-color: var(--pdf-toolbar-btn-active-bg, #e8e8e8);
	}

	.pdf-toolbar button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.pdf-toolbar input[type='text'],
	.pdf-toolbar input[type='number'] {
		height: 28px;
		padding: 0 0.5rem;
		border: 1px solid var(--pdf-toolbar-input-border, #e0e0e0);
		border-radius: 6px;
		background-color: var(--pdf-toolbar-input-bg, #fff);
		color: var(--pdf-toolbar-fg, #333);
		font-size: 0.8rem;
		outline: none;
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
	}

	.pdf-toolbar input[type='text']:focus,
	.pdf-toolbar input[type='number']:focus {
		border-color: var(--pdf-toolbar-accent, #0066cc);
		box-shadow: 0 0 0 2px var(--pdf-toolbar-accent-ring, rgba(0, 102, 204, 0.15));
	}

	.pdf-toolbar input[type='number'] {
		width: 34px;
		font-size: 0.75rem;
		text-align: center;
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.pdf-toolbar input[type='number']::-webkit-outer-spin-button,
	.pdf-toolbar input[type='number']::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.pdf-toolbar .search-input {
		width: 160px;
	}

	.pdf-toolbar .zoom-level {
		min-width: 48px;
		text-align: center;
		font-size: 0.8rem;
		color: var(--pdf-toolbar-muted, #666);
		font-weight: 500;
	}

	.pdf-toolbar .page-info {
		font-size: 0.8rem;
		color: var(--pdf-toolbar-muted, #888);
		margin-left: 0.25rem;
	}

	.pdf-toolbar .match-info {
		font-size: 0.75rem;
		color: var(--pdf-toolbar-muted, #888);
		min-width: 60px;
		margin-left: 0.25rem;
	}
</style>
