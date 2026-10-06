<script lang="ts">
	// The LaTeX lane of the compile-command modal: live mode, and the engine/latexmk quick setup.
	//
	// Everything here is a TeX concept with no Typst counterpart, which is why it is a component
	// rather than a branch - the modal picks a lane and renders it, and Auto picks the same lane the
	// compiler will (the main file's extension), so an auto folder gets exactly these controls.
	import { Switch } from '@skeletonlabs/skeleton-svelte';
	import * as cc from '$lib/workspace/compileCommand';
	import { settings, updateSettings } from '$lib/settings';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** the draft command; the engine chips rewrite it in place */
		command: string;
		compileEngine?: 'tectonic' | 'system';
		/** live mode is on, so the command below is not what Compile runs */
		superseded: boolean;
		/** the segmented-control classes, shared with the modal's format switch */
		segment: string;
		seg: (active: boolean, compact?: boolean) => string;
	}
	let { command = $bindable(), compileEngine = $bindable('system'), superseded, segment, seg }: Props = $props();

	// chip highlight state, reflected live from the draft (null engine = unrecognized)
	const engine = $derived(cc.detectEngine(command));
	const latexmk = $derived(cc.usesLatexmk(command));
	const ENGINES = ['pdflatex', 'lualatex', 'xelatex'] as const;

	function applyEngine(e: cc.Engine) {
		command = cc.buildCompileCommand(e, cc.usesLatexmk(command), command);
	}
	function applyLatexmk(on: boolean) {
		command = cc.buildCompileCommand(cc.detectEngine(command) ?? 'pdflatex', on, command);
	}
</script>

<div class="workbench-compile-settings">
	<!-- Live mode IS the incremental lualatex pipeline. The setting is global and stays whatever it
     was, ready for the next LaTeX folder. -->
	<div class="mb-1 flex items-center justify-between gap-4">
		<span class="text-sm">{m.wsview_live_mode_label()} <span class="text-surface-500">{m.wsview_experimental_label()}</span></span>
		<Switch checked={$settings.draftMode} onCheckedChange={(d) => updateSettings({ draftMode: d.checked })}>
			<Switch.Control><Switch.Thumb /></Switch.Control>
			<Switch.HiddenInput />
		</Switch>
	</div>

	{#if superseded}
		<p class="text-surface-500 mt-1 mb-1 text-xs">
			{m.wsview_livemode_desc_pre()} <strong>lualatex</strong>
			{m.wsview_livemode_desc_post()}
		</p>
		<div class="border-surface-300-700 text-surface-500 mt-3 rounded border border-dashed px-3 py-2 text-xs">
			{m.wsview_compile_disabled_live()}
			<code class="bg-surface-200-800 ml-1 rounded px-1 opacity-70">lualatex (built-in)</code>
		</div>
	{:else}
		<div class="my-3 flex items-center justify-between gap-3">
			<span class="text-sm font-medium">{m.managed_compile_engine()}</span>
			<div class={segment}>
				<button
					type="button"
					class={seg(compileEngine === 'tectonic', true)}
					aria-pressed={compileEngine === 'tectonic'}
					onclick={() => (compileEngine = 'tectonic')}>{m.managed_compile_managed()}</button
				>
				<button
					type="button"
					class={seg(compileEngine === 'system', true)}
					aria-pressed={compileEngine === 'system'}
					onclick={() => (compileEngine = 'system')}>{m.managed_compile_system()}</button
				>
			</div>
		</div>
		{#if compileEngine === 'tectonic'}
			<p class="text-surface-500 my-2 text-xs">{m.managed_compile_description()}</p>
		{:else}
			<p class="text-surface-600-300 mt-2 mb-3 text-sm">
				{m.wsview_compile_desc_pre()} <code class="bg-surface-200-800 rounded px-1">{'{main}'}</code>
				{m.wsview_compile_desc_post()}
			</p>

			<!-- quick setup: chips reflect the command when recognizable, and regenerate it on click -->
			<div class="mb-3 flex items-center justify-between gap-3">
				<span class="flex min-w-0 items-baseline gap-2 text-sm font-medium">
					{m.wsview_engine_label()}
					<!-- no segment is raised when the engine is unrecognized, so say why -->
					{#if engine === null && command.trim()}
						<span class="text-surface-400 truncate text-xs italic">{m.wsview_custom_label()}</span>
					{/if}
				</span>
				<div class="flex shrink-0 items-center gap-3">
					<div class={segment}>
						{#each ENGINES as eng (eng)}
							<button
								type="button"
								class="{seg(engine === eng, true)} workbench-setting-choice"
								aria-pressed={engine === eng}
								onclick={() => applyEngine(eng)}
							>
								{eng}
							</button>
						{/each}
					</div>
					<label class="text-surface-600-300 inline-flex items-center gap-1.5 text-xs">
						<input
							type="checkbox"
							class="checkbox workbench-setting-checkbox"
							checked={latexmk}
							onchange={(e) => applyLatexmk(e.currentTarget.checked)}
						/>
						{m.wsview_use_latexmk_label()}
					</label>
				</div>
			</div>
		{/if}
	{/if}
</div>
