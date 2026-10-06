<script lang="ts">
	import { Popover, Portal } from '@skeletonlabs/skeleton-svelte';
	import { Baseline, AlertTriangle } from '@lucide/svelte';
	import { getContext, onDestroy } from 'svelte';
	import { editorViewStore, templateFeaturesStore } from '$lib/stores/editorStore';
	import { schema as texSchema } from '$lib/schema/schema';
	import type { Schema } from 'prosemirror-model';
	import { TextSelection } from 'prosemirror-state';
	import { TEXT_COLOR_PACKAGE_CONTEXT, type TextColorPackageRequester } from '$lib/workspace/text-color-package-context';
	import { m } from '$lib/paraglide/messages';

	// markSchema must be the schema of the mounted editor - marks from a foreign Schema object
	// must never enter a document (the typst toolbar passes typSchema)
	const contextPackageRequester = getContext<TextColorPackageRequester | undefined>(TEXT_COLOR_PACKAGE_CONTEXT);
	let {
		activeTextColor = null,
		markSchema = texSchema,
		packageRequester = contextPackageRequester
	}: { activeTextColor?: string | null; markSchema?: Schema; packageRequester?: TextColorPackageRequester } = $props();

	let open = $state(false);
	let pendingPackageRequest: AbortController | null = null;
	onDestroy(() => pendingPackageRequest?.abort());

	const textColorDisabled = $derived($templateFeaturesStore?.textColor === false);

	const textColors = [
		{ name: m.tbar_color_default(), value: 'default' },
		{ name: m.tbar_color_black(), value: 'black' },
		{ name: m.tbar_color_red(), value: 'red' },
		{ name: m.tbar_color_blue(), value: 'blue' },
		{ name: m.tbar_color_green(), value: 'green' },
		{ name: m.tbar_color_yellow(), value: 'yellow' },
		{ name: m.tbar_color_cyan(), value: 'cyan' },
		{ name: m.tbar_color_magenta(), value: 'magenta' },
		{ name: m.tbar_color_white(), value: 'white' }
	] as const;

	async function setTextColor(color: string) {
		const view = $editorViewStore;
		if (!view || view.isDestroyed || !view.state || !view.dispatch) return;
		const state = view.state;
		const selection = state.selection;
		if (!selection.empty && !(selection instanceof TextSelection)) return;
		const { from, to } = selection;
		const selectedText = state.doc.textBetween(from, to, '\n', '\uFFFC');
		const isCurrent = () => {
			if (view.isDestroyed || $editorViewStore !== view || view.state.doc !== state.doc) return false;
			const live = view.state.selection;
			return live.from === from && live.to === to && view.state.doc.textBetween(from, to, '\n', '\uFFFC') === selectedText;
		};
		const textColorMark = markSchema.marks.textcolor;
		if (!textColorMark || !isCurrent()) return;

		// Typst shares the color mark name but serializes it to Typst `#text`, not LaTeX;
		// only the LaTeX schema needs an xcolor package decision.
		if (color !== 'default' && markSchema === texSchema) {
			if (!packageRequester) return;
			pendingPackageRequest?.abort();
			const controller = new AbortController();
			pendingPackageRequest = controller;
			try {
				const lease = await packageRequester.ensureXcolor(controller.signal, isCurrent);
				if (!lease || controller.signal.aborted || !lease.isCurrent() || !isCurrent()) return;
			} finally {
				if (pendingPackageRequest === controller) pendingPackageRequest = null;
			}
		}

		if (!isCurrent()) return;
		const mark = color === 'default' ? null : textColorMark.create({ color });
		const tr = selection.empty
			? mark
				? state.tr.addStoredMark(mark)
				: state.tr.removeStoredMark(textColorMark)
			: mark
				? state.tr.addMark(from, to, mark)
				: state.tr.removeMark(from, to, textColorMark);
		view.dispatch(tr);
		view.focus();
		open = false;
	}
</script>

<Popover
	{open}
	onOpenChange={(e) => (open = e.open)}
	positioning={{ placement: 'bottom-start', offset: { mainAxis: 4 } }}
	autoFocus={false}
>
	<Popover.Trigger class="toolbarButton rounded p-1 hover:bg-surface-200-800">
		<button aria-label={m.tbar_text_color_aria()} title={m.tbar_text_color_aria()} class="relative flex items-center">
			<!-- nudged down 1.5px, lucide's A glyph rides high; matches the underline correction -->
			<Baseline class="h-5 w-5 translate-y-[1.5px] text-surface-800-200" />
			<!-- active-color bar is absolute so it doesn't add height and lift the icon off center -->
			<span
				class="absolute inset-x-0 -bottom-1 h-[3px] rounded-full"
				style="background-color: {activeTextColor ? activeTextColor : 'transparent'};"
			></span>
		</button>
	</Popover.Trigger>

	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content
				class="card bg-surface-50-950 border-surface-300-700 min-w-[140px] border p-1 shadow-lg"
				onmousedown={(event) => event.preventDefault()}
			>
				{#if textColorDisabled}
					<div class="text-warning-600 dark:text-warning-400 border-surface-300-700 flex items-start gap-2 border-b px-3 py-2 text-xs">
						<AlertTriangle class="mt-0.5 h-4 w-4 flex-shrink-0" />
						<span>{m.tbar_text_color_disabled_warning()}</span>
					</div>
				{/if}
				{#each textColors as { name, value } (value)}
					<button
						type="button"
						aria-label={name}
						class="hover:preset-tonal-primary flex w-full items-center gap-2 rounded px-3 py-2 text-left"
						onclick={() => setTextColor(value)}
					>
						{#if value === 'default'}
							<span class="relative inline-block h-3 w-3 rounded-full border border-surface-300-700 bg-surface-100-900">
								<span class="absolute inset-0 flex items-center justify-center text-xs text-red-500">✕</span>
							</span>
						{:else}
							<span class="inline-block h-3 w-3 rounded-full border border-surface-300-700" style="background-color: {value};"></span>
						{/if}
						<span class="text-sm">{name}</span>
					</button>
				{/each}
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>
