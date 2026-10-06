<script lang="ts">
	import { Popover, Portal } from '@skeletonlabs/skeleton-svelte';
	import { Check, Pilcrow } from '@lucide/svelte';
	import type { ParagraphIndent } from '$lib/editor/helperCommands';

	interface Props {
		value: ParagraphIndent;
		onSelect: (value: ParagraphIndent) => void;
		disabled?: boolean;
	}

	let { value, onSelect, disabled = false }: Props = $props();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let optionButtons = $state<HTMLButtonElement[]>([]);

	const options: Array<{ value: ParagraphIndent; label: string }> = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'indent', label: 'Indent' },
		{ value: 'noindent', label: 'No indent' }
	];
	const current = $derived(options.find((option) => option.value === value) ?? options[0]);

	function choose(indent: ParagraphIndent) {
		if (disabled) return;
		onSelect(indent);
		open = false;
		queueMicrotask(() => trigger?.focus());
	}

	function focusOption(index: number) {
		queueMicrotask(() => optionButtons[index]?.focus());
	}

	function onTriggerKeydown(event: KeyboardEvent) {
		if (disabled || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
		event.preventDefault();
		open = true;
		const currentIndex = Math.max(
			0,
			options.findIndex((option) => option.value === value)
		);
		focusOption(event.key === 'ArrowDown' ? currentIndex : (currentIndex + options.length - 1) % options.length);
	}

	function onOptionKeydown(event: KeyboardEvent, index: number) {
		if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			queueMicrotask(() => trigger?.focus());
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			focusOption((index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			choose(options[index].value);
		}
	}
</script>

<Popover {open} onOpenChange={(event) => (open = event.open)} positioning={{ placement: 'bottom-start', offset: { mainAxis: 4 } }}>
	<Popover.Trigger>
		<button
			bind:this={trigger}
			type="button"
			class="hover:preset-tonal flex h-8 items-center gap-1.5 rounded px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
			aria-label="Paragraph indent"
			aria-haspopup="menu"
			title={disabled ? 'Paragraph indent is available in a paragraph' : 'Paragraph indent'}
			{disabled}
			onkeydown={onTriggerKeydown}
		>
			<Pilcrow class="size-4" />
			<span>{current.label}</span>
		</button>
	</Popover.Trigger>
	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content
				class="card bg-surface-50-950 border-surface-300-700 min-w-44 border p-1 shadow-lg"
				role="menu"
				aria-label="Paragraph indent"
			>
				<div class="text-surface-500 px-2 py-1 text-[10px] font-semibold tracking-wider uppercase">Paragraph indent</div>
				{#each options as option, index (option.value)}
					<button
						bind:this={optionButtons[index]}
						type="button"
						role="menuitemradio"
						class="hover:preset-tonal flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
						class:preset-tonal-primary={value === option.value}
						aria-checked={value === option.value}
						onclick={() => choose(option.value)}
						onkeydown={(event) => onOptionKeydown(event, index)}
					>
						<span class="min-w-0 flex-1">{option.label}</span>
						{#if value === option.value}<Check class="size-4 shrink-0" />{/if}
					</button>
				{/each}
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>
