<script lang="ts">
	import { onDestroy } from 'svelte';
	import { clampSplitterValue, splitterKeyboardValue, type SplitterAxis } from './resize-logic.ts';

	let {
		value,
		min,
		max,
		axis,
		label,
		controls,
		container,
		class: className = '',
		onChange,
		onCommit = () => {}
	}: {
		value: number;
		min: number;
		max: number;
		axis: SplitterAxis;
		label: string;
		controls: string;
		container: HTMLElement | null;
		class?: string;
		onChange: (value: number) => void;
		onCommit?: () => void;
	} = $props();

	let dragging = $state(false);
	let activePointerId: number | null = null;
	let capturedElement: HTMLElement | null = null;

	function stopDragging(event?: PointerEvent) {
		if (event && activePointerId !== null && event.pointerId !== activePointerId) return;
		if (!dragging && activePointerId === null && capturedElement === null) return;
		const element = capturedElement;
		const pointerId = activePointerId;
		dragging = false;
		activePointerId = null;
		capturedElement = null;
		if (element && pointerId !== null && typeof element.releasePointerCapture === 'function') {
			try {
				if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
					element.releasePointerCapture(pointerId);
				}
			} catch {
				// Capture may already have been released by the browser.
			}
		}
		onCommit();
	}

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0 || activePointerId !== null) return;
		event.preventDefault();
		activePointerId = event.pointerId;
		capturedElement = event.currentTarget as HTMLElement;
		dragging = true;
		try {
			capturedElement.setPointerCapture?.(event.pointerId);
		} catch {
			stopDragging();
		}
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging || event.pointerId !== activePointerId || !container) return;
		const rect = container.getBoundingClientRect();
		const coordinate = axis === 'vertical' ? event.clientX - rect.left : event.clientY - rect.top;
		if ((axis === 'vertical' && rect.width <= 0) || (axis === 'horizontal' && rect.height <= 0)) return;
		onChange(clampSplitterValue(coordinate, { min, max }));
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
			event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const next = splitterKeyboardValue(event.key, axis, value, { min, max });
		if (next === null) return;
		event.preventDefault();
		onChange(next);
		onCommit();
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		const finish = () => stopDragging();
		window.addEventListener('blur', finish);
		window.addEventListener('resize', finish);
		return () => {
			window.removeEventListener('blur', finish);
			window.removeEventListener('resize', finish);
		};
	});

	onDestroy(() => stopDragging());
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	role="separator"
	tabindex="0"
	aria-orientation={axis}
	aria-controls={controls}
	aria-label={label}
	aria-valuenow={Math.round(value)}
	aria-valuemin={Math.round(min)}
	aria-valuemax={Math.round(max)}
	class={`splitter ${axis} ${className}`}
	class:dragging
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={stopDragging}
	onpointercancel={stopDragging}
	onlostpointercapture={stopDragging}
	onkeydown={onKeyDown}
>
	<span class="splitter-line" aria-hidden="true"></span>
</div>

<style>
	.splitter {
		position: relative;
		z-index: 5;
		display: flex;
		flex: none;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 0;
		background: transparent;
		touch-action: none;
		user-select: none;
		appearance: none;
		-webkit-appearance: none;
	}
	.splitter.vertical { width: 8px; cursor: col-resize; }
	.splitter.horizontal { height: 8px; cursor: row-resize; }
	.splitter-line { display: block; flex: none; background: var(--line); pointer-events: none; transition: background-color 0.15s ease, transform 0.15s ease; }
	.splitter.vertical .splitter-line { width: 1px; height: 100%; }
	.splitter.horizontal .splitter-line { width: 100%; height: 1px; }
	.splitter.vertical:hover .splitter-line,
	.splitter.vertical:focus-visible .splitter-line,
	.splitter.vertical.dragging .splitter-line { transform: scaleX(3); background: var(--accent); }
	.splitter.horizontal:hover .splitter-line,
	.splitter.horizontal:focus-visible .splitter-line,
	.splitter.horizontal.dragging .splitter-line { transform: scaleY(3); background: var(--accent); }
	.splitter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
	@media (prefers-reduced-motion: reduce) { .splitter-line { transition: none; } }
</style>
