<script lang="ts">
	import type { BlockCommand } from './blockInsertItems';
	import { filterBlockCommands } from './blockInsertItems';
	import { m } from '$lib/paraglide/messages';

	interface MenuState {
		open: boolean;
		top: number;
		left: number;
		query: string;
		active: number;
		pending: boolean;
		error: string;
	}

	let {
		state: menuState,
		commands,
		onSelect,
		onClose
	}: {
		state: MenuState;
		commands: BlockCommand[];
		onSelect: (command: BlockCommand) => void | Promise<void>;
		onClose: () => void;
	} = $props();
	let input = $state<HTMLInputElement>();
	const matches = $derived(filterBlockCommands(commands, menuState.query));

	$effect(() => {
		if (menuState.open && !menuState.pending) queueMicrotask(() => input?.focus());
	});

	$effect(() => {
		if (menuState.active >= matches.length) menuState.active = Math.max(0, matches.length - 1);
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		if (menuState.pending) return;
		if (event.key === 'ArrowDown' && matches.length) {
			event.preventDefault();
			menuState.active = (menuState.active + 1) % matches.length;
		} else if (event.key === 'ArrowUp' && matches.length) {
			event.preventDefault();
			menuState.active = (menuState.active - 1 + matches.length) % matches.length;
		} else if (event.key === 'Enter' && matches[menuState.active]) {
			event.preventDefault();
			void onSelect(matches[menuState.active]);
		}
	}
</script>

{#if menuState.open}
	<div
		class="card bg-surface-50-950 border-surface-300-700 fixed z-50 w-64 border p-1 shadow-lg"
		style="top: {menuState.top}px; left: {menuState.left}px"
		role="dialog"
		aria-label={m.blockhandle_insert_header()}
		aria-busy={menuState.pending}
	>
		<input
			bind:this={input}
			value={menuState.query}
			oninput={(event) => {
				if (menuState.pending) return;
				menuState.query = event.currentTarget.value;
				menuState.active = 0;
				menuState.error = '';
			}}
			onkeydown={onKeydown}
			class="border-surface-300-700 bg-surface-50-950 mb-1 w-full rounded border px-2 py-1.5 text-sm outline-none focus:border-blue-500 read-only:cursor-wait read-only:opacity-70"
			placeholder={m.searchbar_placeholder()}
			aria-controls="slash-menu-options"
			aria-activedescendant={matches[menuState.active] ? `slash-command-${matches[menuState.active].id}` : undefined}
			readonly={menuState.pending}
			aria-readonly={menuState.pending}
		/>
		{#if menuState.pending}
			<p class="text-surface-500 px-2 py-2 text-sm" role="status">{m.blockhandle_insert_header()}…</p>
		{:else if menuState.error}
			<p class="text-error-500 px-2 py-2 text-sm" role="alert">{menuState.error}</p>
		{/if}
		<div id="slash-menu-options" role="listbox" class="max-h-64 overflow-y-auto">
			{#each matches as command, index (command.id)}
				<button
					id={`slash-command-${command.id}`}
					type="button"
					role="option"
					aria-selected={index === menuState.active}
					tabindex="-1"
					disabled={menuState.pending}
					class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm disabled:cursor-wait disabled:opacity-70"
					class:preset-tonal={index === menuState.active}
					onmouseenter={() => (menuState.active = index)}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => void onSelect(command)}
				>
					<command.icon class="text-surface-500 size-4 shrink-0" />
					<span>{command.label()}</span>
				</button>
			{:else}
				<p class="text-surface-500 px-2 py-3 text-sm">{m.palette_empty()}</p>
			{/each}
		</div>
	</div>
{/if}
