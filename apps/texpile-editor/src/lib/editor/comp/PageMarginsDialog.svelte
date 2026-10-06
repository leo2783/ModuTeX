<script lang="ts">
	import { untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import { m } from '$lib/paraglide/messages';
	import { DEFAULT_PAGE_MARGINS, validatePageMargins, type PageMarginSide, type PageMargins } from '$lib/workspace/geometryPatch';
	import { PageMarginsCoordinator, type PageMarginsApplyResult, type PageMarginsDialogSnapshot } from '$lib/workspace/page-margins-context';

	let {
		open,
		coordinator,
		onClose
	}: {
		open: boolean;
		coordinator: PageMarginsCoordinator;
		onClose: () => void;
	} = $props();
	let dialogElement: HTMLDivElement | undefined = $state();
	let snapshot: PageMarginsDialogSnapshot | null = $state(null);
	let values = $state<PageMargins>({ ...DEFAULT_PAGE_MARGINS });
	let error: PageMarginsApplyResult | 'invalid-values' | null = $state(null);
	let busy = $state(false);
	let request: AbortController | null = null;

	$effect(() => {
		if (!open) {
			request?.abort();
			request = null;
			return;
		}
		const currentCoordinator = coordinator;
		const snapshotValue = untrack(() => currentCoordinator.inspect());
		snapshot = snapshotValue;
		values = snapshotValue.kind === 'ready' ? { ...snapshotValue.values } : { ...DEFAULT_PAGE_MARGINS };
		error = null;
		queueMicrotask(() => {
			const focusTarget =
				dialogElement?.querySelector<HTMLInputElement>('input:not([disabled])') ??
				dialogElement?.querySelector<HTMLElement>('button:not([disabled])') ??
				dialogElement;
			focusTarget?.focus();
		});
	});

	function close(): void {
		request?.abort();
		request = null;
		onClose();
	}

	function update(side: PageMarginSide, value: string): void {
		values = { ...values, [side]: value };
		error = null;
	}

	function resultMessage(result: PageMarginsApplyResult | 'invalid-values' | null): string {
		switch (result) {
			case 'stale':
				return m.page_margins_stale();
			case 'blocked':
				return m.page_margins_unsafe_preamble();
			case 'sync-failed':
				return m.page_margins_sync_failed();
			case 'invalid':
			case 'invalid-values':
				return m.page_margins_invalid_value();
			case 'cancelled':
				return m.page_margins_cancelled();
			default:
				return '';
		}
	}

	function snapshotMessage(value: PageMarginsDialogSnapshot | null): string {
		if (!value || value.kind === 'ready') return '';
		switch (value.reason) {
			case 'not-editable':
				return m.page_margins_not_editable();
			case 'invalid-preamble':
				return m.page_margins_unsafe_preamble();
			case 'geometry-package-options':
				return m.page_margins_package_options();
			case 'malformed-managed-settings':
				return m.page_margins_unknown_settings();
			default:
				return m.page_margins_unknown_settings();
		}
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy || snapshot?.kind !== 'ready') return;
		if (!validatePageMargins(values)) {
			error = 'invalid-values';
			return;
		}
		const controller = new AbortController();
		request = controller;
		busy = true;
		error = null;
		try {
			const result = await coordinator.apply(values, snapshot.source, controller.signal);
			if (result === 'applied') {
				close();
				return;
			}
			if (!controller.signal.aborted) error = result;
		} finally {
			if (request === controller) request = null;
			busy = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		if (event.key !== 'Tab' || !dialogElement) return;
		const focusable = [...dialogElement.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first?.focus();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-1200 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
		onmousedown={(event) => event.target === event.currentTarget && close()}
	>
		<div
			bind:this={dialogElement}
			class="card bg-surface-50-950 border-surface-300-700 w-full max-w-lg border p-5 shadow-2xl"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="page-margins-title"
			aria-describedby="page-margins-description"
			onkeydown={onKeydown}
		>
			<div class="mb-2 flex items-center justify-between gap-4">
				<h2 id="page-margins-title" class="text-lg font-semibold">{m.page_margins_title()}</h2>
				<button class="btn-icon btn-icon-xs hover:preset-tonal" type="button" aria-label={m.page_margins_cancel()} onclick={close}>
					<X class="size-4" />
				</button>
			</div>
			<p id="page-margins-description" class="text-surface-600-300 mb-4 text-sm">{m.page_margins_description()}</p>

			{#if snapshot?.kind === 'ready'}
				<form onsubmit={submit}>
					<div class="grid grid-cols-2 gap-3">
						{#each ['top', 'right', 'bottom', 'left'] as side (side)}
							<label class="label text-sm">
								<span
									>{side === 'top'
										? m.page_margins_top()
										: side === 'right'
											? m.page_margins_right()
											: side === 'bottom'
												? m.page_margins_bottom()
												: m.page_margins_left()}</span
								>
								<div class="flex items-center gap-2">
									<input
										type="text"
										inputmode="decimal"
										autocomplete="off"
										class="input min-w-0 flex-1"
										value={values[side as PageMarginSide]}
										aria-label={side === 'top'
											? m.page_margins_top()
											: side === 'right'
												? m.page_margins_right()
												: side === 'bottom'
													? m.page_margins_bottom()
													: m.page_margins_left()}
										disabled={busy}
										oninput={(event) => update(side as PageMarginSide, event.currentTarget.value)}
									/>
									<span class="text-surface-600-300 shrink-0">cm</span>
								</div>
							</label>
						{/each}
					</div>
					{#if error}
						<p class="text-error-600-300 mt-3 text-sm" role="alert">{resultMessage(error)}</p>
					{/if}
					<div class="mt-5 flex justify-end gap-2">
						<button class="btn hover:preset-tonal" type="button" disabled={busy} onclick={close}>{m.page_margins_cancel()}</button>
						<button class="btn preset-filled-primary-500" type="submit" disabled={busy}>
							{busy ? m.page_margins_applying() : m.page_margins_apply()}
						</button>
					</div>
				</form>
			{:else}
				<p class="border-warning-500/40 bg-warning-500/10 text-warning-800-200 rounded-base border p-3 text-sm" role="status">
					{snapshotMessage(snapshot)}
				</p>
				<div class="mt-5 flex justify-end">
					<button class="btn hover:preset-tonal" type="button" onclick={close}>{m.page_margins_cancel()}</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
