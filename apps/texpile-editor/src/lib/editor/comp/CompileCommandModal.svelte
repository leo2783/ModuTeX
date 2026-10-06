<script lang="ts">
	// The compile-command modal: a format switch, the selected lane's own settings, the shell
	// command, and the per-folder output-path overrides. Persisting is the caller's job.
	//
	// Format comes first and decides everything under it. Auto is a LANE CHOICE, not a third mode:
	// it reads the main file's extension and then renders exactly what that lane would render, so a
	// .typ main under Auto gets the Typst block and its command, editable, same as picking Typst.
	import { Switch } from '@skeletonlabs/skeleton-svelte';
	import { X, Play } from '@lucide/svelte';
	import LatexCompileSettings from '$lib/editor/comp/LatexCompileSettings.svelte';
	import TypstCompileSettings from '$lib/editor/comp/TypstCompileSettings.svelte';
	import CompileOutputPaths from '$lib/editor/comp/CompileOutputPaths.svelte';
	import { mainFile, type CompileFormat } from '$lib/workspace/workspaceStore';
	import { settings, updateSettings, DEFAULT_COMPILE_COMMAND } from '$lib/settings';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		open: boolean;
		command: string;
		engine: 'tectonic' | 'system';
		/** the explicit format switch; CompileSettings owns swapping drafts when it changes */
		format: CompileFormat;
		onSelectFormat: (f: CompileFormat) => void;
		outputs: { pdf: string; log: string };
		advancedOpen: boolean;
		onSave: (thenRun: boolean) => void;
		onUseDefault: () => void;
		onRun: () => void;
	}
	let {
		open = $bindable(),
		command = $bindable(),
		engine = $bindable(),
		format,
		onSelectFormat,
		outputs = $bindable(),
		advancedOpen = $bindable(),
		onSave,
		onUseDefault,
		onRun
	}: Props = $props();

	// The concrete lane the switch selects: the STORED format decides, with auto reading the main
	// file's extension. Nothing is inferred from the command string.
	const lane = $derived(format === 'auto' ? (/\.typ$/i.test($mainFile ?? '') ? 'typst' : 'latex') : format);
	const isTypst = $derived(lane === 'typst');
	const managed = $derived(!isTypst && engine === 'tectonic');

	// The lane's built-in mode is running instead of the shell command: LaTeX's live mode (the
	// pipeline ignores the setting for Typst) or Typst's preview. The command is still the folder's
	// and is kept - it just is not what Compile runs, so showing it as editable would lie.
	const superseded = $derived(isTypst ? $settings.typstLiveMode !== false : $settings.draftMode);

	// LaTeX and Typst are product names, so they are not translated; Auto is
	const FORMATS = [
		{ id: 'auto', label: () => m.wsview_format_auto() },
		{ id: 'latex', label: () => 'LaTeX' },
		{ id: 'typst', label: () => 'Typst' }
	] as const;

	// the segmented-control classes Preferences' theme picker uses, so an exclusive choice looks the
	// same wherever it appears
	const SEGMENT = 'bg-surface-200-800 rounded-base flex shrink-0 gap-1 p-0.5';
	// `compact` keeps the engine row inside max-w-lg: three engine names are far longer than the
	// theme picker's System/Light/Dark, and at full size they push the latexmk checkbox off the row
	const seg = (active: boolean, compact = false) =>
		`rounded-base ${compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1 text-sm'} ${
			active ? 'bg-surface-50-950 font-medium shadow-sm' : 'text-surface-600-400 hover:text-surface-950-50'
		}`;
</script>

{#if open}
	<div
		class="fixed inset-0 z-1300 flex items-center justify-center app-scrim bg-black/40 p-4"
		role="presentation"
		onmousedown={(e) => e.target === e.currentTarget && (open = false)}
	>
		<!-- max-h-full + scroll, not a taller window: this dialog grows with what it is showing (the
		     engine row, live mode's note, the advanced output paths) and a short window clipped its
		     buttons off both ends, with no way to reach them. The scrim's p-4 is the margin it stops
		     at. Every modal card in the app carries this pair for the same reason. -->
		<div class="card bg-surface-50-950 border-surface-300-700 max-h-full w-full max-w-lg overflow-y-auto border p-5 shadow-2xl">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-base font-semibold">{m.wsview_compile_modal_title()}</h2>
				<button class="btn-icon btn-icon-xs hover:preset-tonal" onclick={() => (open = false)} aria-label={m.wsview_close_aria()}>
					<X class="size-4" />
				</button>
			</div>
			<!-- (main-file selection lives in the first-compile confirm modal and the file
			     tree's "Set as main file" - not here; this modal is only about the command) -->

			<!-- Which typesetter, first: it decides what every control under it means. -->
			<div class="border-surface-200-800 mb-3 flex items-center justify-between gap-4 border-b pb-3">
				<span class="text-sm font-medium">{m.wsview_format_label()}</span>
				<div class={SEGMENT}>
					{#each FORMATS as f (f.id)}
						<button type="button" class={seg(format === f.id)} onclick={() => onSelectFormat(f.id)}>
							{f.label()}
						</button>
					{/each}
				</div>
			</div>
			{#if format === 'auto'}
				<p class="text-surface-500 mb-2 text-xs">{m.wsview_auto_format_note()}</p>
			{/if}

			<!-- the selected lane's own settings; under Auto this is whichever lane the main file
			     resolves to, so the block below always describes the compiler that will actually run -->
			{#if isTypst}
				<TypstCompileSettings {superseded} />
			{:else}
				<LatexCompileSettings bind:command bind:compileEngine={engine} {superseded} segment={SEGMENT} {seg} />
			{/if}

			{#if !superseded && !managed}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="input w-full font-mono text-sm"
					bind:value={command}
					placeholder={DEFAULT_COMPILE_COMMAND}
					spellcheck="false"
					autofocus
					onkeydown={(e) => {
						if (e.key === 'Enter' && !(command.includes('{main}') && !$mainFile)) onSave(true);
						else if (e.key === 'Escape') open = false;
					}}
				/>
				<div class="mt-4 flex items-center justify-between gap-4">
					<span class="text-sm">{m.wsview_completion_marker_label()}</span>
					<Switch checked={$settings.compileSentinel} onCheckedChange={(d) => updateSettings({ compileSentinel: d.checked })}>
						<Switch.Control><Switch.Thumb /></Switch.Control>
						<Switch.HiddenInput />
					</Switch>
				</div>
				<p class="text-surface-500 mt-1 text-xs">
					{m.wsview_completion_marker_desc()}
				</p>

				<CompileOutputPaths bind:outputs bind:open={advancedOpen} />
			{/if}

			<div class="mt-4 flex items-center justify-between gap-3">
				<span class="text-surface-500 text-xs">
					{#if !$mainFile}{m.wsview_pick_main_file_to_run()}{/if}
				</span>
				<div class="flex gap-2">
					<button class="btn btn-xs hover:preset-tonal" onclick={() => (open = false)}>{m.wsview_cancel_label()}</button>
					{#if superseded}
						<!-- one button either way: onRun goes through runCompile, which routes to the draft
						     engine or the Typst preview by the same conditions that hid the command above -->
						<button
							class="btn btn-xs preset-filled-primary-500 gap-1.5"
							onclick={() => {
								open = false;
								onRun();
							}}
							disabled={!$mainFile}
						>
							<Play class="size-4" />
							{m.wsview_run_preview()}
						</button>
					{:else}
						<button class="btn btn-xs hover:preset-tonal" onclick={() => onSave(false)}>{m.wsview_save_label()}</button>
						<button
							class="btn btn-xs preset-tonal-primary gap-1.5"
							onclick={onUseDefault}
							disabled={DEFAULT_COMPILE_COMMAND.includes('{main}') && !$mainFile}
							title={m.wsview_use_default_title()}
						>
							<Play class="size-4" />
							{m.wsview_use_default()}
						</button>
						<button
							class="btn btn-xs preset-filled-primary-500 gap-1.5"
							onclick={() => onSave(true)}
							disabled={managed ? !$mainFile : command.includes('{main}') && !$mainFile}
						>
							<Play class="size-4" />
							{m.wsview_save_and_run()}
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
