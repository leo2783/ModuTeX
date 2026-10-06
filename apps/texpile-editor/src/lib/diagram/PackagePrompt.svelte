<script lang="ts">
	import { X } from '@lucide/svelte';
	import { m } from '$lib/paraglide/messages';
	import type { PackagePromptChoice, PackagePromptRequest } from './package-prompt.svelte';

	let { request, onResolve }: { request: PackagePromptRequest | null; onResolve: (id: number, choice: PackagePromptChoice) => void } =
		$props();
	let dialogElement: HTMLDivElement | undefined = $state();
	let previousFocus: HTMLElement | null = null;

	$effect(() => {
		const id = request?.id;
		if (!id) return;
		previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => {
			if (request?.id !== id || !dialogElement?.isConnected) return;
			dialogElement.querySelector<HTMLButtonElement>('[data-dialog-action]:not([disabled])')?.focus();
		});
	});

	function choose(choice: PackagePromptChoice): void {
		if (request) onResolve(request.id, choice);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			choose('cancel');
			return;
		}
		if (event.key !== 'Tab' || !dialogElement) return;
		const focusable = [...dialogElement.querySelectorAll<HTMLElement>('button:not([disabled])')];
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

	$effect(() => {
		if (request) return;
		const target = previousFocus;
		previousFocus = null;
		queueMicrotask(() => {
			if (!request && target?.isConnected) target.focus();
		});
	});
</script>

{#if request}
	<div
		class="fixed inset-0 z-1300 flex items-center justify-center app-scrim bg-black/40 p-4"
		role="presentation"
		onmousedown={(event) => event.target === event.currentTarget && choose('cancel')}
	>
		<div
			bind:this={dialogElement}
			class="card bg-surface-50-950 border-surface-300-700 w-full max-w-md border p-5 shadow-2xl"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="package-prompt-title"
			aria-describedby="package-prompt-description"
			onkeydown={onKeydown}
		>
			<div class="mb-2 flex items-center justify-between gap-4">
				<h2 id="package-prompt-title" class="text-lg font-semibold">
					{request.packageName === 'amsmath'
						? m.math_package_prompt_title()
						: request.packageName === 'booktabs'
							? m.table_package_prompt_title()
							: request.packageName === 'arydshln'
								? m.arydshln_package_prompt_title()
								: request.packageName === 'xcolor'
									? m.textcolor_package_prompt_title()
									: request.packageName === 'geometry'
										? m.page_margins_package_prompt_title()
										: m.diagram_package_prompt_title()}
				</h2>
				<button
					class="btn-icon btn-icon-xs hover:preset-tonal"
					type="button"
					aria-label={m.diagram_package_prompt_cancel()}
					onclick={() => choose('cancel')}
				>
					<X class="size-4" />
				</button>
			</div>
			<p id="package-prompt-description" class="text-surface-600-300 text-sm">
				{request.packageName === 'amsmath'
					? m.math_package_prompt_body()
					: request.packageName === 'booktabs'
						? m.table_package_prompt_body()
						: request.packageName === 'arydshln'
							? m.arydshln_package_prompt_body()
							: request.packageName === 'xcolor'
								? m.textcolor_package_prompt_body()
								: request.packageName === 'geometry'
									? m.page_margins_package_prompt_body()
									: m.diagram_package_prompt_body()}
			</p>
			<div class="mt-5 flex flex-wrap justify-end gap-2">
				<button
					class="btn preset-tonal border border-surface-300-700 font-medium"
					data-dialog-action
					type="button"
					disabled={!request.canAdd}
					onclick={() => choose('add-and-insert')}
				>
					{request.packageName === 'amsmath'
						? m.math_package_prompt_add()
						: request.packageName === 'booktabs'
							? m.table_package_prompt_add()
							: request.packageName === 'arydshln'
								? m.arydshln_package_prompt_add()
								: request.packageName === 'xcolor'
									? m.textcolor_package_prompt_add()
									: request.packageName === 'geometry'
										? m.page_margins_package_prompt_add()
										: m.diagram_package_prompt_add()}
				</button>
				{#if request.packageName !== 'geometry' && request.packageName !== 'arydshln'}
					<button class="btn hover:preset-tonal" data-dialog-action type="button" onclick={() => choose('insert-without-package')}>
						{request.packageName === 'amsmath'
							? m.math_package_prompt_without_package()
							: request.packageName === 'booktabs'
								? m.table_package_prompt_without_package()
								: request.packageName === 'xcolor'
									? m.textcolor_package_prompt_without_package()
									: m.diagram_package_prompt_without_package()}
					</button>
				{/if}
				<button class="btn hover:preset-tonal" data-dialog-action type="button" onclick={() => choose('cancel')}>
					{m.diagram_package_prompt_cancel()}
				</button>
			</div>
			{#if !request.canAdd}
				<p class="text-surface-500 mt-3 text-xs" role="status">
					{request.packageName === 'amsmath'
						? m.math_package_prompt_no_preamble()
						: request.packageName === 'booktabs'
							? m.table_package_prompt_no_preamble()
							: request.packageName === 'arydshln'
								? m.arydshln_package_prompt_no_preamble()
								: request.packageName === 'xcolor'
									? m.textcolor_package_prompt_no_preamble()
									: request.packageName === 'geometry'
										? m.page_margins_package_prompt_no_preamble()
										: m.diagram_package_prompt_no_preamble()}
				</p>
			{/if}
		</div>
	</div>
{/if}
