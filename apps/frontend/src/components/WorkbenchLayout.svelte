<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy, tick, untrack } from 'svelte';
	import { text, type Language } from '../i18n/text.ts';

	let {
		locale = 'zh-Hant',
		activePane = $bindable<'document' | 'pdf'>('document'),
		splitRatio = $bindable(0.5),
		forceMode,
		sidebarContent,
		editor,
		preview
	}: {
		locale?: Language;
		activePane?: 'document' | 'pdf';
		splitRatio?: number;
		forceMode?: 'wide' | 'narrow';
		sidebarContent: Snippet;
		editor: Snippet<[{ active: boolean; hidden: boolean; inert: boolean }]>;
		preview: Snippet<[{ active: boolean; hidden: boolean; inert: boolean }]>;
	} = $props();

	const t = (zh: string, en: string) => text(locale, zh, en);

	let isWide = $state(true);
	let isDragging = $state(false);
	let activePointerId: number | null = null;
	let capturedElement: HTMLElement | null = null;
	let panesContainer: HTMLElement | null = $state(null);
	let docTabButton: HTMLButtonElement | null = $state(null);
	let pdfTabButton: HTMLButtonElement | null = $state(null);
	let sidebarSlot: HTMLElement | null = null;
	let separatorElement: HTMLElement | null = null;
	let previousIsWide: boolean | null = null;
	let pendingFocusRecovery: { readonly origin: HTMLElement } | null = null;
	let disposed = false;

	const MIN_RATIO = 0.2;
	const MAX_RATIO = 0.8;
	const MIN_PANE_WIDTH = 280;

	function getEffectiveBounds(): { min: number; max: number } {
		if (!panesContainer) return { min: MIN_RATIO, max: MAX_RATIO };
		const rect = panesContainer.getBoundingClientRect();
		if (!rect || rect.width <= 0) return { min: MIN_RATIO, max: MAX_RATIO };

		const minAllowed = Math.max(MIN_RATIO, MIN_PANE_WIDTH / rect.width);
		const maxAllowed = Math.min(MAX_RATIO, 1 - (MIN_PANE_WIDTH / rect.width));

		if (minAllowed >= maxAllowed) {
			return { min: 0.5, max: 0.5 };
		}
		return { min: minAllowed, max: maxAllowed };
	}

	function clampRatio(ratio: number): number {
		const { min, max } = getEffectiveBounds();
		return Math.max(min, Math.min(max, ratio));
	}

	$effect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mql = window.matchMedia('(min-width: 961px)');
		isWide = mql.matches;
		const handler = (e: MediaQueryListEvent) => {
			isWide = e.matches;
		};
		if (mql.addEventListener) {
			mql.addEventListener('change', handler);
			return () => mql.removeEventListener('change', handler);
		} else if ('addListener' in mql) {
			type LegacyMql = { addListener: (cb: typeof handler) => void; removeListener: (cb: typeof handler) => void };
			(mql as unknown as LegacyMql).addListener(handler);
			return () => (mql as unknown as LegacyMql).removeListener(handler);
		}
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const handleBlur = () => {
			stopDragging();
		};
		window.addEventListener('blur', handleBlur);
		return () => {
			window.removeEventListener('blur', handleBlur);
		};
	});

	onDestroy(() => {
		disposed = true;
		pendingFocusRecovery = null;
		stopDragging();
	});

	$effect(() => {
		if (typeof window === 'undefined') return;

		const handleResize = () => {
			splitRatio = clampRatio(splitRatio);
		};

		let resizeObserver: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined' && panesContainer) {
			resizeObserver = new ResizeObserver(handleResize);
			resizeObserver.observe(panesContainer);
		}
		window.addEventListener('resize', handleResize);

		return () => {
			window.removeEventListener('resize', handleResize);
			if (resizeObserver) resizeObserver.disconnect();
		};
	});

	const effectiveIsWide = $derived(forceMode ? forceMode === 'wide' : isWide);

	function deferFocusRecovery(origin: HTMLElement) {
		const recovery = { origin };
		pendingFocusRecovery = recovery;
		void tick().then(() => {
			if (disposed || pendingFocusRecovery !== recovery) return;
			pendingFocusRecovery = null;
			if (effectiveIsWide || recovery.origin.isConnected) return;

			// Only restore focus when the element captured before removal is gone
			// and focus has not moved to another connected element in the meantime.
			const current = document.activeElement;
			if (current !== null && current !== document.body && current !== recovery.origin) return;
			const target = activePane === 'document' ? docTabButton : pdfTabButton;
			if (!target?.isConnected || target.getAttribute('aria-selected') !== 'true') return;
			target.focus();
		}).catch(() => {
			if (pendingFocusRecovery === recovery) pendingFocusRecovery = null;
		});
	}

	$effect.pre(() => {
		const wide = effectiveIsWide;
		if (previousIsWide === true && !wide && typeof document !== 'undefined') {
			const focused = document.activeElement;
			if (focused instanceof HTMLElement &&
				(sidebarSlot?.contains(focused) || separatorElement?.contains(focused))) {
				deferFocusRecovery(focused);
			}
		}
		// Keep a pending recovery through rapid width changes. Its callback uses
		// the final mode and pane, and declines to focus if the final mode is wide.
		previousIsWide = wide;
	});

	$effect(() => {
		// Only track effectiveIsWide; if narrow, stop dragging without reactive coupling to isDragging
		if (!effectiveIsWide) {
			untrack(() => {
				stopDragging();
			});
		}
	});

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		// (1) Ignore any non-matching / secondary pointer while actively captured
		if (activePointerId !== null) return;

		activePointerId = e.pointerId;
		capturedElement = e.currentTarget as HTMLElement | null;
		isDragging = true;

		if (capturedElement && typeof capturedElement.setPointerCapture === 'function') {
			try {
				capturedElement.setPointerCapture(e.pointerId);
			} catch {
				isDragging = false;
				activePointerId = null;
				capturedElement = null;
			}
		}
	}

	function onPointerMove(e: PointerEvent) {
		if (!isDragging || e.pointerId !== activePointerId || !panesContainer) return;
		const rect = panesContainer.getBoundingClientRect();
		if (!rect || rect.width <= 0) return;

		const pointerOffset = e.clientX - rect.left;
		const rawRatio = pointerOffset / rect.width;
		splitRatio = clampRatio(rawRatio);
	}

	function stopDragging(e?: PointerEvent) {
		if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
		if (!isDragging && activePointerId === null && capturedElement === null) return;

		const elem = capturedElement;
		const pid = activePointerId;

		// (2) Clear state BEFORE releasing capture to avoid recursive lostcapture callback loop
		isDragging = false;
		activePointerId = null;
		capturedElement = null;

		if (elem && pid !== null && typeof elem.releasePointerCapture === 'function') {
			try {
				if (typeof elem.hasPointerCapture === 'function') {
					if (elem.hasPointerCapture(pid)) {
						elem.releasePointerCapture(pid);
					}
				} else {
					elem.releasePointerCapture(pid);
				}
			} catch {
				// Ignore release errors
			}
		}
	}

	function onKeyDown(e: KeyboardEvent) {
		if (shouldIgnoreKeyboardEvent(e)) return;
		const step = 0.03;
		const bounds = getEffectiveBounds();
		// (3) Keyboard Home/End/Arrows use container-derived 280px min constraints
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			splitRatio = clampRatio(splitRatio - step);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			splitRatio = clampRatio(splitRatio + step);
		} else if (e.key === 'Home') {
			e.preventDefault();
			splitRatio = bounds.min;
		} else if (e.key === 'End') {
			e.preventDefault();
			splitRatio = bounds.max;
		}
	}

	function shouldIgnoreKeyboardEvent(e: KeyboardEvent): boolean {
		return e.defaultPrevented || e.isComposing || e.keyCode === 229 ||
			e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
	}

	function onTabKeyDown(e: KeyboardEvent, currentTab: 'document' | 'pdf') {
		if (shouldIgnoreKeyboardEvent(e)) return;
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			const nextTab = currentTab === 'document' ? 'pdf' : 'document';
			activePane = nextTab;
			if (nextTab === 'document') {
				docTabButton?.focus();
			} else {
				pdfTabButton?.focus();
			}
		} else if (e.key === 'Home') {
			e.preventDefault();
			activePane = 'document';
			docTabButton?.focus();
		} else if (e.key === 'End') {
			e.preventDefault();
			activePane = 'pdf';
			pdfTabButton?.focus();
		}
	}

	const editorActive = $derived(effectiveIsWide || activePane === 'document');
	const editorHidden = $derived(!effectiveIsWide && activePane !== 'document');
	const editorInert = $derived(!effectiveIsWide && activePane !== 'document');

	const previewActive = $derived(effectiveIsWide || activePane === 'pdf');
	const previewHidden = $derived(!effectiveIsWide && activePane !== 'pdf');
	const previewInert = $derived(!effectiveIsWide && activePane !== 'pdf');
</script>

<div class="workbench-layout" class:wide={effectiveIsWide} class:narrow={!effectiveIsWide}>
	{#if !effectiveIsWide}
		<div class="workbench-tabs" role="tablist" aria-label={t('工作台視圖', 'Workbench views')}>
			<button
				type="button"
				role="tab"
				id="workbench-tab-document"
				aria-controls="workbench-panel-document"
				aria-selected={activePane === 'document'}
				tabindex={activePane === 'document' ? 0 : -1}
				bind:this={docTabButton}
				class="workbench-tab"
				onclick={() => (activePane = 'document')}
				onkeydown={(e) => onTabKeyDown(e, 'document')}
			>
				{t('文件', 'Document')}
			</button>
			<button
				type="button"
				role="tab"
				id="workbench-tab-pdf"
				aria-controls="workbench-panel-pdf"
				aria-selected={activePane === 'pdf'}
				tabindex={activePane === 'pdf' ? 0 : -1}
				bind:this={pdfTabButton}
				class="workbench-tab"
				onclick={() => (activePane = 'pdf')}
				onkeydown={(e) => onTabKeyDown(e, 'pdf')}
			>
				{t('PDF 預覽', 'PDF preview')}
			</button>
		</div>
	{/if}

	<div class="workbench-body">
		{#if effectiveIsWide}
			<div class="workbench-sidebar-slot" bind:this={sidebarSlot}>
				{@render sidebarContent()}
			</div>
		{/if}

		<div
			class="workbench-panes"
			bind:this={panesContainer}
			style:--editor-width={effectiveIsWide ? `${splitRatio * 100}%` : '100%'}
			style:--preview-width={effectiveIsWide ? `${(1 - splitRatio) * 100}%` : '100%'}
		>
			<div
				id="workbench-panel-document"
				role="tabpanel"
				aria-labelledby="workbench-tab-document"
				class="pane-wrapper editor-wrapper"
				class:hidden-pane={editorHidden}
			>
				{@render editor({ active: editorActive, hidden: editorHidden, inert: editorInert })}
			</div>

			{#if effectiveIsWide}
				<!-- WAI-ARIA window splitter is a focusable separator widget, not a static separator.
				     https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/ -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					role="separator"
					tabindex="0"
					aria-orientation="vertical"
					aria-controls="workbench-panel-document"
					aria-label={t('調整編輯器與預覽比例', 'Resize editor and preview')}
					aria-valuenow={Math.round(splitRatio * 100)}
					aria-valuemin={Math.round(getEffectiveBounds().min * 100)}
					aria-valuemax={Math.round(getEffectiveBounds().max * 100)}
					class="workbench-separator"
					bind:this={separatorElement}
					class:dragging={isDragging}
					onpointerdown={onPointerDown}
					onpointermove={onPointerMove}
					onpointerup={stopDragging}
					onpointercancel={stopDragging}
					onlostpointercapture={stopDragging}
					onkeydown={onKeyDown}
				>
					<span class="separator-line"></span>
				</div>
			{/if}

			<div
				id="workbench-panel-pdf"
				role="tabpanel"
				aria-labelledby="workbench-tab-pdf"
				class="pane-wrapper preview-wrapper"
				class:hidden-pane={previewHidden}
			>
				{@render preview({ active: previewActive, hidden: previewHidden, inert: previewInert })}
			</div>
		</div>
	</div>
</div>

<style>
	.workbench-layout {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.workbench-tabs {
		display: flex;
		gap: 8px;
		padding: 6px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--canvas);
		min-height: 40px;
		align-items: center;
	}
	.workbench-tab {
		border: 1px solid var(--line);
		border-radius: 4px;
		background: var(--surface);
		color: var(--ink);
		padding: 4px 12px;
		min-height: 30px;
		font-size: 13px;
		cursor: pointer;
	}
	.workbench-tab[aria-selected='true'] {
		background: var(--selection);
		color: var(--accent);
		border-color: var(--accent);
		font-weight: 600;
	}
	.workbench-body {
		display: flex;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.workbench-sidebar-slot {
		flex: 0 0 220px;
		min-width: 180px;
		max-width: 260px;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--line);
		background: var(--surface);
	}
	.workbench-panes {
		flex: 1;
		display: flex;
		min-height: 0;
		min-width: 0;
		position: relative;
	}
	.wide .pane-wrapper.editor-wrapper {
		width: var(--editor-width, 50%);
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.wide .pane-wrapper.preview-wrapper {
		width: var(--preview-width, 50%);
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.narrow .workbench-body {
		flex-direction: column;
	}
	.narrow .pane-wrapper {
		flex: 1;
		width: 100%;
		display: flex;
		flex-direction: column;
	}
	.hidden-pane {
		display: none !important;
	}
	.workbench-separator {
		width: 9px;
		margin: 0 -4px;
		padding: 0;
		border: none;
		cursor: col-resize;
		background: transparent;
		position: relative;
		z-index: 5;
		touch-action: none;
		user-select: none;
		display: flex;
		align-items: center;
		justify-content: center;
		appearance: none;
		-webkit-appearance: none;
	}
	.separator-line {
		width: 1px;
		height: 100%;
		background: var(--line);
		pointer-events: none;
		transition: background-color 0.15s ease, transform 0.15s ease;
	}
	.workbench-separator:hover .separator-line,
	.workbench-separator:focus-visible .separator-line,
	.workbench-separator.dragging .separator-line {
		transform: scaleX(3);
		background: var(--accent);
	}
	.workbench-separator:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	@media (prefers-reduced-motion: reduce) {
		.separator-line { transition: none; }
	}
</style>
