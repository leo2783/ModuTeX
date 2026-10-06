<script lang="ts">
	import { Popover, Portal } from '@skeletonlabs/skeleton-svelte';
	import { SquareRadical, ChevronDown } from '@lucide/svelte';
	import { tick } from 'svelte';
	import { createMathField } from '$lib/editor/extensions/mathlivebridge/mlcommands';
	import { editorViewStore } from '$lib/stores/editorStore';
	import Kbd from '$lib/components/Kbd.svelte';
	import { m } from '$lib/paraglide/messages';

	let open = $state(false);
	let preserveMathfieldFocus = $state(false);

	// label is a function, not a string: this list is built once at init, before the persisted
	// locale is applied, so the text has to be read at render time
	const mathOptions = [
		{
			id: 'inline',
			label: () => m.mathpal_inline_math(),
			shortcut: 'Mod+M',
			command: createMathField(false)
		},
		{
			id: 'block',
			label: () => m.mathpal_block_math(),
			shortcut: 'Mod+Shift+M',
			command: createMathField(true)
		}
	];

	function handlePrimaryInsert() {
		const view = $editorViewStore;
		if (!view || view.isDestroyed) return;
		open = false;
		createMathField(true)(view.state, view.dispatch);
	}

	async function handleInsert(option: (typeof mathOptions)[0]) {
		const view = $editorViewStore;
		if (!view || view.isDestroyed) return;
		// Zag normally restores focus to the trigger on a later animation frame. The selected
		// MathLive NodeView owns focus after insertion, so suppress only that close-time restore.
		preserveMathfieldFocus = true;
		open = false;
		try {
			await tick();
			if (view.isDestroyed || $editorViewStore !== view) return;
			option.command(view.state, view.dispatch);
		} finally {
			preserveMathfieldFocus = false;
		}
	}
</script>

<Popover
	{open}
	onOpenChange={(e) => (open = e.open)}
	positioning={{ placement: 'bottom-start', offset: { mainAxis: 4 } }}
	autoFocus={false}
	restoreFocus={!preserveMathfieldFocus}
>
	<div class="toolbarButton flex items-center rounded hover:bg-surface-200-800">
		<button
			type="button"
			aria-label={m.mathpal_insert_math_aria()}
			title={m.mathpal_block_math()}
			class="flex items-center p-1"
			onclick={handlePrimaryInsert}
		>
			<SquareRadical class="h-5 w-5 text-surface-800-200" />
		</button>
		<Popover.Trigger
			type="button"
			aria-label={m.toolbar_more_actions_aria()}
			title={m.toolbar_more_actions_aria()}
			class="flex items-center rounded p-1"
		>
			<ChevronDown class="text-surface-500 size-3 shrink-0" />
		</Popover.Trigger>
	</div>

	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content class="card bg-surface-50-950 border-surface-300-700 min-w-[180px] border p-1 shadow-lg">
				{#each mathOptions as option}
					<button
						type="button"
						class="hover:preset-tonal-primary flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left"
						onclick={() => handleInsert(option)}
					>
						<span class="text-sm">{option.label()}</span>
						<Kbd keys={option.shortcut} />
					</button>
				{/each}
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>
