<script lang="ts">
	// The symbol palette, DOCKED at the bottom of the editor pane rather than floating over it.
	//
	// It used to be a Popover anchored to the toolbar, which meant it opened downward straight onto
	// the equation being edited - and, worse, Zag returns focus to a popover's trigger when it closes
	// (setFinalFocus), blurring the mathfield after every single insert. As part of the layout it
	// covers nothing, and there is no trigger for focus to go back to.
	import { onDestroy, onMount } from 'svelte';
	import { getContext } from 'svelte';
	import { X } from '@lucide/svelte';
	import { m } from '$lib/paraglide/messages';
	import { insertSymbol, liveMathfield } from './mathInsert';
	import { SYMBOL_GROUPS, MATRIX_BRACKETS, generateMatrixLatex, symbolTooltip, type MatrixBracket } from './mathSymbols';
	import { requiresAmsmath, validInteractiveMatrixSize } from '$lib/editor/extensions/mathlivebridge/matrixLatex';
	import { captureMathfieldEditReceipt, type MathfieldEditReceipt } from '$lib/editor/extensions/mathlivebridge/mlview.svelte';
	import {
		clearQueuedOwnedPromptIds,
		ownMathLiveTemplate,
		queueOwnedPromptIds
	} from '$lib/editor/extensions/mathlivebridge/owned-prompt-output';
	import { MATH_PACKAGE_CONTEXT, type MathPackageGateLease, type MathPackageRequester } from '$lib/workspace/math-package-context';

	let { groupId, top, left, onClose }: { groupId: string; top: number; left: number; onClose: () => void } = $props();

	let panelEl = $state<HTMLDivElement>();

	const group = $derived(SYMBOL_GROUPS.find((g) => g.id === groupId) ?? SYMBOL_GROUPS[0]);

	let matrixGridHoverRows = $state(2);
	let matrixGridHoverCols = $state(2);
	let matrixBracketMode = $state<MatrixBracket>('pmatrix');
	let customMatrixN = $state<number | undefined>(2);
	let customMatrixRows = $state<number | undefined>(2);
	let customMatrixCols = $state<number | undefined>(2);
	let intendedMathfield = $state<HTMLElement | null>(null);
	let intendedReceipt = $state<MathfieldEditReceipt | null>(null);
	let isMounted = true;
	let pickInFlight = false;
	let pickCompleted = false;
	let cancelPendingFocus: (() => void) | null = null;
	let packageRequest: AbortController | null = null;
	const mathPackages = getContext<MathPackageRequester | undefined>(MATH_PACKAGE_CONTEXT);
	const focusReadyTimeoutMs = 1000;
	const customSquareSizeIsValid = $derived(validInteractiveMatrixSize(customMatrixN, customMatrixN));
	const customMatrixSizeIsValid = $derived(validInteractiveMatrixSize(customMatrixRows, customMatrixCols));
	const customMatrixSizeError = $derived(m.matrix_size_error());

	// mathlive loads lazily so a static edge here can't drag it into the eager bundle
	let convertLatexToMarkup = $state<((latex: string) => string) | null>(null);
	onDestroy(() => {
		isMounted = false;
		packageRequest?.abort();
		packageRequest = null;
		cancelPendingFocus?.();
		intendedMathfield = null;
	});

	onMount(() => {
		// Capture the field that opened this panel before its inputs/buttons can take focus. Never
		// retarget an in-flight picker from a later active field.
		intendedMathfield = currentMathfield();
		intendedReceipt = intendedMathfield ? captureMathfieldEditReceipt(intendedMathfield) : null;
		Promise.all([import('mathlive'), import('mathlive/static.css')]).then(([ml]) => {
			convertLatexToMarkup = ml.convertLatexToMarkup;
		});
	});

	function renderLatex(latex: string): string {
		try {
			return convertLatexToMarkup ? convertLatexToMarkup(latex) : latex;
		} catch {
			return latex;
		}
	}

	// mousedown fires before focus changes, so preventDefault keeps the mathfield focused
	function preventFocusLoss(e: MouseEvent | PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
	}

	function isReadyMathfield(target: HTMLElement): boolean {
		return isMounted && !!panelEl?.isConnected && target.isConnected && currentMathfield() === target;
	}

	function focusMathfieldWhenReady(target: HTMLElement): Promise<boolean> {
		if (isReadyMathfield(target)) return Promise.resolve(true);
		const MathfieldElementClass = window.MathfieldElement;
		if (
			!isMounted ||
			!panelEl?.isConnected ||
			!target.isConnected ||
			!MathfieldElementClass ||
			!(target instanceof MathfieldElementClass)
		) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let settled = false;
			let timeoutId: number | undefined;
			const observer = new MutationObserver((records) => {
				const removedTargetOrPanel = records.some((record) =>
					Array.from(record.removedNodes).some(
						(removed) => removed === target || removed.contains(target) || removed === panelEl || (!!panelEl && removed.contains(panelEl))
					)
				);
				if (removedTargetOrPanel || !target.isConnected || !panelEl?.isConnected) finish(false);
			});
			const onFocusIn = () => {
				if (!isMounted || !panelEl?.isConnected || !target.isConnected) {
					finish(false);
					return;
				}
				const liveTarget = currentMathfield();
				if (liveTarget === target) finish(true);
				else if (liveTarget) finish(false);
			};
			const cleanup = () => {
				observer.disconnect();
				document.removeEventListener('focusin', onFocusIn, true);
				if (timeoutId !== undefined) window.clearTimeout(timeoutId);
				if (cancelPendingFocus === cancel) cancelPendingFocus = null;
			};
			const finish = (ready: boolean) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(ready && isReadyMathfield(target));
			};
			const cancel = () => finish(false);

			try {
				cancelPendingFocus = cancel;
				observer.observe(document.documentElement, { childList: true, subtree: true });
				document.addEventListener('focusin', onFocusIn, true);
				timeoutId = window.setTimeout(cancel, focusReadyTimeoutMs);
				if (isReadyMathfield(target)) {
					finish(true);
					return;
				}

				target.focus();
				if (isReadyMathfield(target)) finish(true);
			} catch (error) {
				finish(false);
				console.error('[math-toolbar] MathLive focus failed', error);
			}
		});
	}

	async function pick(latex: string, matrixColumns?: number) {
		if (pickInFlight || pickCompleted || !isMounted || !panelEl?.isConnected) return;
		const target = intendedMathfield;
		const MathfieldElementClass = window.MathfieldElement;
		if (!target || !MathfieldElementClass || !(target instanceof MathfieldElementClass) || !target.isConnected) return;
		const receipt = intendedReceipt?.field === target ? intendedReceipt : null;

		pickInFlight = true;
		let gateLease: MathPackageGateLease | null = null;
		try {
			if (requiresAmsmath(latex)) {
				if (!mathPackages || !receipt?.isCurrent()) return;
				const controller = new AbortController();
				packageRequest = controller;
				gateLease = await mathPackages.ensureAmsmath(
					controller.signal,
					() => isMounted && !!panelEl?.isConnected && target.isConnected && receipt.isCurrent()
				);
				if (
					!gateLease ||
					controller.signal.aborted ||
					!gateLease.isCurrent() ||
					!receipt.isCurrent() ||
					!isMounted ||
					!panelEl?.isConnected ||
					!target.isConnected
				)
					return;
			}
			if (currentMathfield() !== target && !(await focusMathfieldWhenReady(target))) return;
			if (!isReadyMathfield(target) || (gateLease && !gateLease.isCurrent()) || (gateLease && !receipt?.isCurrent())) return;
			const previousMaxMatrixCols = target.maxMatrixCols;
			try {
				if (matrixColumns !== undefined && matrixColumns > previousMaxMatrixCols) {
					target.maxMatrixCols = matrixColumns;
				}
				const ownedTemplate = ownMathLiveTemplate(latex);
				queueOwnedPromptIds(target, ownedTemplate.promptIds);
				const inserted = insertSymbol(ownedTemplate.latex, target);
				if (!inserted) clearQueuedOwnedPromptIds(target, ownedTemplate.promptIds);
				if (!inserted) return;
			} finally {
				if (target.maxMatrixCols !== previousMaxMatrixCols) target.maxMatrixCols = previousMaxMatrixCols;
			}
			pickCompleted = true;
			intendedMathfield = null;
			onClose();
		} catch (error) {
			console.error('[math-toolbar] Matrix picker insertion failed', error);
		} finally {
			packageRequest = null;
			pickInFlight = false;
		}
	}

	function insertCustomMatrix(rows: number, cols: number) {
		if (!validInteractiveMatrixSize(rows, cols)) return;
		void pick(generateMatrixLatex(rows, cols, matrixBracketMode), cols);
	}

	function currentMathfield(): HTMLElement | null {
		return 'MathfieldElement' in window ? liveMathfield() : null;
	}

	function moveMatrixGridFocus(event: KeyboardEvent, row: number, col: number) {
		const next =
			event.key === 'ArrowUp'
				? [Math.max(0, row - 1), col]
				: event.key === 'ArrowDown'
					? [Math.min(9, row + 1), col]
					: event.key === 'ArrowLeft'
						? [row, Math.max(0, col - 1)]
						: event.key === 'ArrowRight'
							? [row, Math.min(9, col + 1)]
							: null;
		if (!next) return false;
		event.preventDefault();
		matrixGridHoverRows = next[0] + 1;
		matrixGridHoverCols = next[1] + 1;
		panelEl?.querySelector<HTMLButtonElement>(`[data-matrix-cell="${next[0]}-${next[1]}"]`)?.focus();
		return true;
	}

	function handleMatrixGridKeydown(event: KeyboardEvent, row: number, col: number) {
		if (moveMatrixGridFocus(event, row, col)) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			insertCustomMatrix(row + 1, col + 1);
		}
	}

	// Dismiss on pointer down outside and on Escape. No scrim (it competes in whatever stacking
	// context it lands in) and no Zag popover (its setFinalFocus returns focus to the trigger, which
	// blurred the mathfield after every insert - the bug this whole panel came from).
	$effect(() => {
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && panelEl?.contains(t)) return;
			if (t instanceof Element && t.closest('[data-math-toolbar]')) return; // the trigger toggles itself
			onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('keydown', onKey, true);
		};
	});
</script>

<div
	bind:this={panelEl}
	class="card bg-surface-50-950 border-surface-300-700 fixed z-50 flex max-h-[min(26rem,60vh)] min-w-[200px] flex-col border shadow-lg"
	style="top: {top}px; left: {left}px"
>
	<div class="border-surface-300-700 flex shrink-0 items-center justify-between border-b px-3 py-1.5">
		<span class="text-surface-600-400 text-xs font-semibold uppercase">{group.label()}</span>
		<button class="hover:preset-tonal rounded p-1" onmousedown={preventFocusLoss} onclick={onClose} aria-label={m.mathpanel_close_aria()}>
			<X class="size-4" />
		</button>
	</div>
	<div class="flex-1 overflow-y-auto" tabindex="-1" role="presentation" onmousedown={preventFocusLoss}>
		{#if group.id === 'matrices'}
			<div class="border-surface-300-700 border-b p-3">
				<div class="mb-2 text-xs font-medium">{m.mathtoolbar_matrix_style_label()}</div>
				<div class="mb-3 flex flex-wrap gap-2">
					{#each MATRIX_BRACKETS as b (b.mode)}
						<button
							type="button"
							class="rounded border px-2 py-1 text-xs transition-colors"
							class:preset-tonal-primary={matrixBracketMode === b.mode}
							class:border-blue-400={matrixBracketMode === b.mode}
							class:bg-surface-100-900={matrixBracketMode !== b.mode}
							class:border-surface-300-700={matrixBracketMode !== b.mode}
							onclick={() => (matrixBracketMode = b.mode)}
							onmousedown={preventFocusLoss}
							aria-pressed={matrixBracketMode === b.mode}
							title={b.title()}
						>
							{b.label}
						</button>
					{/each}
				</div>
				<div class="mb-2 text-xs font-medium">{m.mathtoolbar_matrix_size_label()}</div>
				<div class="space-y-2">
					<div class="grid gap-1" role="group" aria-label="Matrix size picker" style="grid-template-columns: repeat(10, 1.25rem);">
						{#each Array.from({ length: 10 }) as _, row}
							{#each Array.from({ length: 10 }) as _, col}
								<button
									type="button"
									class="aspect-square w-full rounded border text-xs transition-colors"
									class:preset-tonal-primary={row + 1 <= matrixGridHoverRows && col + 1 <= matrixGridHoverCols}
									class:border-blue-400={row + 1 <= matrixGridHoverRows && col + 1 <= matrixGridHoverCols}
									class:bg-surface-100-900={!(row + 1 <= matrixGridHoverRows && col + 1 <= matrixGridHoverCols)}
									class:border-surface-300-700={!(row + 1 <= matrixGridHoverRows && col + 1 <= matrixGridHoverCols)}
									aria-label={m.mathtoolbar_insert_matrix_aria({ rows: row + 1, cols: col + 1 })}
									data-matrix-cell={`${row}-${col}`}
									onmouseover={() => {
										matrixGridHoverRows = row + 1;
										matrixGridHoverCols = col + 1;
									}}
									onfocus={() => {
										matrixGridHoverRows = row + 1;
										matrixGridHoverCols = col + 1;
									}}
									onkeydown={(event) => handleMatrixGridKeydown(event, row, col)}
									onpointerdown={(e) => {
										e.preventDefault();
										insertCustomMatrix(row + 1, col + 1);
									}}
									onmousedown={preventFocusLoss}
									tabindex={row === 0 && col === 0 ? 0 : -1}
								>
								</button>
							{/each}
						{/each}
					</div>
					<div class="text-surface-600 text-center text-xs font-medium">{matrixGridHoverRows}×{matrixGridHoverCols}</div>
					<label class="label mt-3 text-xs">
						<span>{m.matrix_square_size_label()}</span>
						<input
							type="number"
							class="input input-sm"
							min="1"
							max="10"
							step="1"
							aria-label={m.matrix_square_size_label()}
							aria-invalid={!customSquareSizeIsValid}
							aria-describedby="matrix-square-size-error"
							bind:value={customMatrixN}
							onmousedown={(event) => event.stopPropagation()}
						/>
					</label>
					{#if !customSquareSizeIsValid}
						<p id="matrix-square-size-error" class="text-error-600 text-xs" role="alert">{customMatrixSizeError}</p>
					{/if}
					<button
						type="button"
						class="btn btn-sm preset-filled-primary mt-2 w-full"
						data-matrix-insert="square"
						disabled={!customSquareSizeIsValid}
						aria-label={m.mathtoolbar_insert_matrix_aria({ rows: customMatrixN ?? 0, cols: customMatrixN ?? 0 })}
						onmousedown={preventFocusLoss}
						onclick={() => insertCustomMatrix(customMatrixN!, customMatrixN!)}
					>
						{m.mathtoolbar_insert_matrix_aria({ rows: customMatrixN ?? 0, cols: customMatrixN ?? 0 })}
					</button>
					<div class="text-surface-600 mt-3 text-xs font-medium">Rows / Columns</div>
					<div class="grid grid-cols-2 gap-2">
						<label class="label text-xs">
							<span>Rows</span>
							<input
								type="number"
								class="input input-sm"
								min="1"
								max="10"
								step="1"
								aria-label="Matrix rows"
								aria-invalid={!customMatrixSizeIsValid}
								aria-describedby="matrix-size-error"
								bind:value={customMatrixRows}
								onmousedown={(event) => event.stopPropagation()}
							/>
						</label>
						<label class="label text-xs">
							<span>Columns</span>
							<input
								type="number"
								class="input input-sm"
								min="1"
								max="10"
								step="1"
								aria-label="Matrix columns"
								aria-invalid={!customMatrixSizeIsValid}
								aria-describedby="matrix-size-error"
								bind:value={customMatrixCols}
								onmousedown={(event) => event.stopPropagation()}
							/>
						</label>
					</div>
					{#if !customMatrixSizeIsValid}
						<p id="matrix-size-error" class="text-error-600 text-xs" role="alert">{customMatrixSizeError}</p>
					{/if}
					<button
						type="button"
						class="btn btn-sm preset-filled-primary w-full"
						data-matrix-insert="rectangular"
						disabled={!customMatrixSizeIsValid}
						aria-label={m.mathtoolbar_insert_matrix_aria({ rows: customMatrixRows ?? 0, cols: customMatrixCols ?? 0 })}
						onmousedown={preventFocusLoss}
						onclick={() => insertCustomMatrix(customMatrixRows!, customMatrixCols!)}
					>
						{m.mathtoolbar_insert_matrix_aria({ rows: customMatrixRows ?? 0, cols: customMatrixCols ?? 0 })}
					</button>
				</div>
			</div>
		{/if}

		{#if group.id === 'environments'}
			<div class="env-list">
				{#each group.symbols as symbol}
					<button
						type="button"
						class="env-btn bg-surface-100-900"
						tabindex="-1"
						onmousedown={preventFocusLoss}
						onpointerdown={(e) => {
							e.preventDefault();
							void pick(symbol.latex);
						}}
						title={symbolTooltip(symbol) || symbol.latex}
					>
						<span class="env-label">{symbolTooltip(symbol)}</span>
						<span class="env-preview">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderLatex() is mathlive's own trusted math-typesetting HTML for a symbol from the hardcoded SYMBOL_GROUPS table above, never user/network input. -->
							{@html renderLatex(symbol.displayLatex ?? symbol.latex)}
						</span>
					</button>
				{/each}
			</div>
		{:else}
			<div class="symbol-grid" data-group={group.id}>
				{#each group.symbols as symbol}
					<button
						type="button"
						class="symbol-btn bg-surface-100-900"
						tabindex="-1"
						onmousedown={preventFocusLoss}
						onpointerdown={(e) => {
							e.preventDefault();
							void pick(symbol.latex);
						}}
						title={symbolTooltip(symbol) || symbol.latex}
					>
						<span class="symbol-content">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderLatex() is mathlive's own trusted math-typesetting HTML for a symbol from the hardcoded SYMBOL_GROUPS table above, never user/network input. -->
							{@html renderLatex(symbol.displayLatex ?? symbol.latex)}
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style lang="postcss">
	@reference "../../../../app.css";

	/* No max-height or overflow here: the card body scrolls (see the wrapper's overflow-y-auto), and
	   when both did you got two scrollbars side by side. Each grid used to sit in its own popover and
	   owned its own height; the panel owns it now. */
	.symbol-grid {
		display: grid;
		gap: 4px;
		grid-template-columns: repeat(4, 80px);
		padding: 6px;
	}

	.symbol-grid[data-group='greek'] {
		grid-template-columns: repeat(6, 56px);
	}

	.symbol-grid[data-group='matrices'] {
		grid-template-columns: repeat(3, 66px);
	}

	.env-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		width: 260px;
	}

	.env-btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		width: 100%;
		padding: 8px 12px;
		border-radius: 4px;
		border: 1px solid transparent;
		text-align: left;
		transition:
			background-color 0.15s,
			border-color 0.15s;
	}

	.env-btn:hover {
		background: var(--color-blue-200, #bfdbfe);
		border-color: var(--color-blue-400, #60a5fa);
	}

	.env-btn:active {
		@apply bg-blue-300;
	}

	.env-label {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--color-surface-600);
	}

	.env-preview {
		display: flex;
		align-items: center;
		font-size: 0.95rem;
		pointer-events: none;
	}

	.symbol-btn {
		display: grid;
		place-items: center;
		width: 80px;
		height: 80px;
		border-radius: 4px;
		border: 1px solid transparent;
		transition:
			background-color 0.15s,
			border-color 0.15s;
		overflow: hidden;
	}

	.symbol-content {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		overflow: hidden;
		pointer-events: none;
	}

	.symbol-grid[data-group='matrices'] .symbol-btn {
		width: 66px;
		height: 66px;
		padding: 4px;
	}

	.symbol-grid[data-group='matrices'] .symbol-content {
		font-size: 1.1rem;
	}

	.symbol-grid[data-group='greek'] .symbol-btn {
		width: 56px;
		height: 56px;
	}

	.symbol-grid[data-group='greek'] .symbol-content {
		font-size: 1.8rem;
	}

	.symbol-btn:hover {
		background: var(--color-blue-200, #bfdbfe);
		border-color: var(--color-blue-400, #60a5fa);
	}

	.symbol-btn:active {
		@apply bg-blue-300;
	}
</style>
