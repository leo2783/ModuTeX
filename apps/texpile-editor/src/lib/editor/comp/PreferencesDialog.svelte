<script lang="ts">
	import { X, Languages } from '@lucide/svelte';
	import { Switch } from '@skeletonlabs/skeleton-svelte';
	import { themeChoice, setTheme, type ThemeChoice } from '$lib/theme';
	import { settings, updateSettings, updateSettingsLive, applyUiLocale, setMcpEnabled, type AppSettings } from '$lib/settings';
	import { setSpellcheckEnabled } from '$lib/editor/extensions/spellcheck/spellcheckConfig';
	import { toolsInGroup } from '$lib/workspace/toolchainCatalog';
	import { preferencesTab } from '$lib/stores/dialogStore';
	import McpSetupModal from './McpSetupModal.svelte';
	// dark wordmark for light backgrounds, white one for dark mode - the pair StartView uses
	import logoOnLight from '$lib/assets/logo/Logo-dark.svg';
	import logoOnDark from '$lib/assets/logo/Logo-light.svg';
	import { m } from '$lib/paraglide/messages';

	// Draft mode reads the current file from disk, so autosave remains effectively forced on.
	const autosaveForced = $derived($settings.draftMode);
	import { LOCALE_META } from '$lib/localeMeta';
	import { toaster } from '$lib/modals/toaster-svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	// ---- AI assistant access (MCP) ----
	interface McpStatus {
		running: boolean;
		port: number | null;
		error: string | null;
	}
	let mcp = $state<McpStatus | null>(null);

	// `texpileNative` is a non-user-visible preload compatibility API. Renaming it would break
	// existing renderer/main IPC without changing any identity shown in Preferences.
	const nativeMcp = () => (window as unknown as { texpileNative?: { mcpStatus?: () => Promise<McpStatus> } }).texpileNative;

	async function refreshMcp() {
		mcp = (await nativeMcp()?.mcpStatus?.()) ?? null;
	}
	// the port only exists once main has actually bound, so read it back after the flip
	async function onMcpToggle(v: boolean) {
		await setMcpEnabled(v);
		await refreshMcp();
	}
	// re-read whenever the dialog opens: another window may have toggled it, or the port may have
	// been taken since the last look
	$effect(() => {
		if (open) void refreshMcp();
	});

	/** the instructions modal, stacked above this dialog */
	let setupOpen = $state(false);

	// One category on screen at a time, rather than every setting in one scroll. The list had grown
	// past the point where "wrap long lines" and "editor width" could be told apart at a glance -
	// which editor, and which of them, was only answerable by reading the hint under each.
	type Category = 'appearance' | 'editor' | 'toolchain' | 'startup' | 'ai';
	let category = $state<Category>('appearance');
	const categories: { id: Category; label: string }[] = [
		{ id: 'appearance', label: m.prefs_appearance() },
		// Editing, Source editor and Visual editor were three tabs holding three, two and two rows.
		// They were split so that "wrap long lines" and "editor width" could be told apart - which
		// editor, and which of them - and a heading inside one tab answers that just as well as a
		// sidebar entry did, without making the reader guess which of three tabs a setting is in.
		{ id: 'editor', label: m.prefs_group_editor() },
		// LaTeX, Typst and Version control used to be three tabs. Every one of them was the same
		// thing - a list of external programs and whether they were found - so three sidebar entries
		// bought three clicks to answer one question ("is my machine set up"), and the two settings
		// that made LaTeX look like more than a probe list were duplicates of switches in the
		// compile-command dialog.
		{ id: 'toolchain', label: m.prefs_group_toolchain() },
		{ id: 'startup', label: m.prefs_group_startup() },
		{ id: 'ai', label: m.prefs_group_ai() }
	];

	// Nothing in the Toolchain panel is bundled, so the only honest thing it can show is what was
	// actually found. Probed on demand rather than on mount: it spawns ten processes, and most
	// users never open the category.
	let tinymist = $state<TinymistInfo | null | 'unchecked'>('unchecked');
	let probes = $state<ToolProbe[]>([]);
	let probing = $state(false);
	/** the probe itself could not run - an old main process, or no desktop bridge at all */
	let probeFailed = $state(false);
	async function probeToolchain() {
		probing = true;
		probeFailed = false;
		try {
			const bridge = window.texpileTypst;
			if (!bridge?.probeToolchain) throw new Error('no toolchain bridge');
			// in parallel: latexindent alone can take a second, and tinymist resolves separately
			// because it reports more (embedded Typst version, and which location won)
			const [tools, tm] = await Promise.all([bridge.probeToolchain(), bridge.resolve()]);
			probes = tools;
			tinymist = tm;
		} catch {
			// A FAILED probe is not the same as "nothing is installed", and reporting it as such is
			// how a stale main process made a full TeX Live install look absent. Say we don't know.
			probeFailed = true;
			probes = [];
			tinymist = null;
		} finally {
			probing = false;
		}
	}
	const probeFor = (id: string) => probes.find((p) => p.id === id);

	$effect(() => {
		if (open && category === 'toolchain' && tinymist === 'unchecked' && !probing) void probeToolchain();
	});

	// Opened to answer a particular question (the compile modal's "your compiler is missing"): land
	// on that tab, then clear the request. Cleared only when it was SET, or the store write would
	// re-run this effect forever.
	$effect(() => {
		if (!open) return;
		const want = $preferencesTab;
		if (!want) return;
		if (categories.some((c) => c.id === want)) category = want as Category;
		preferencesTab.set(null);
	});

	/** every row is the same shape: name and explanation on the left, the control on the right */
	const ROW = 'border-surface-200-800 flex items-start justify-between gap-6 border-b py-4 last:border-b-0';

	/**
	 * Rows that sit under a section heading, stepped in so they read as belonging to it.
	 *
	 * Padding on the LEFT only. The controls are right-aligned inside each row, so indenting both
	 * edges would walk the switches and selects inward per section and break the single column they
	 * currently form down the whole panel - the thing that makes the list scannable at all.
	 */
	const SUB = 'pl-4';

	const themes: { value: ThemeChoice; label: string }[] = [
		{ value: 'system', label: m.prefs_theme_system() },
		{ value: 'light', label: m.prefs_theme_light() },
		{ value: 'dark', label: m.prefs_theme_dark() }
	];

	// source-editor keybindings; Vim and Emacs are names, so they are not translated
	const keymaps: { value: AppSettings['editorKeymap']; label: string }[] = [
		{ value: 'default', label: m.prefs_keybindings_default() },
		{ value: 'vim', label: 'Vim' },
		{ value: 'emacs', label: 'Emacs' }
	];

	// image resize snaps to multiples of this fraction of \textwidth
	const resizeSteps: { value: number; label: string }[] = [
		{ value: 0.1, label: '10%' },
		{ value: 0.25, label: '25%' },
		{ value: 0.5, label: '50%' }
	];

	// <option> only renders plain text, so the machine-translated tag is appended into the label itself
	const uiLocales: { value: AppSettings['uiLocale']; label: string }[] = (
		Object.entries(LOCALE_META) as [AppSettings['uiLocale'], (typeof LOCALE_META)[AppSettings['uiLocale']]][]
	).map(([value, meta]) => ({
		value,
		label: meta.machineTranslated ? `${meta.label} ${m.prefs_machine_translated_tag({}, { locale: value })}` : meta.label
	}));

	function onLocaleChange(e: Event) {
		const uiLocale = (e.currentTarget as HTMLSelectElement).value as AppSettings['uiLocale'];
		updateSettings({ uiLocale });
		if (!LOCALE_META[uiLocale]?.machineTranslated) {
			applyUiLocale(uiLocale);
			return;
		}
		// warn every time (not just once) since switching to this language is a deliberate, infrequent action
		toaster.warning({
			title: m.mt_warning_title(),
			description: m.mt_warning_description(),
			duration: 6000,
			action: {
				label: m.mt_warning_report_action(),
				onClick: () => {
					const title = `Translation issue: ${LOCALE_META[uiLocale]?.label ?? uiLocale}`;
					window.open(`https://github.com/leo2783/latex/issues/new?title=${encodeURIComponent(title)}`, '_blank', 'noopener,noreferrer');
				}
			}
		});
		// give the toast a moment on screen before the locale-switch reload would otherwise wipe it
		setTimeout(() => applyUiLocale(uiLocale), 3000);
	}
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

{#snippet label(text: string, hint: string, disabled = false)}
	<div class="min-w-0">
		<div class="text-sm font-medium {disabled ? 'text-surface-400' : ''}">{text}</div>
		{#if hint}<p class="text-surface-500 mt-1 text-xs leading-relaxed">{hint}</p>{/if}
	</div>
{/snippet}

<!-- The external programs ModuTeX's features depend on: one row each, saying only found / not found
     (the purpose sits in the tooltip). Anything more - versions, install commands - belongs in the
     docs, which the header links no matter what.
     One panel for all of them, grouped by what they serve. They were three sidebar tabs; a reader
     asking "is my machine set up" had to visit all three and could not see the answer at once. -->
{#snippet toolchainHeader()}
	<div class="border-surface-200-800 flex items-center justify-between gap-3 border-b pt-1 pb-3">
		<p class="text-surface-500 text-xs">
			{m.prefs_toolchain_intro()}
			<!-- always shown, not only when something is missing: one place to go, stated up front -->
			{m.prefs_toolchain_docs_hint()}
			<a class="anchor" href="https://github.com/leo2783/latex/blob/main/docs/INSTALLATION.md" target="_blank" rel="noopener noreferrer"
				>{m.prefs_toolchain_install_guide()}</a
			>
		</p>
		<button class="btn preset-tonal shrink-0 text-xs" onclick={probeToolchain} disabled={probing}>
			{m.prefs_toolchain_recheck()}
		</button>
	</div>
	{#if probeFailed}
		<p class="text-warning-700-300 pt-3 text-xs">{m.prefs_toolchain_probe_failed()}</p>
	{/if}
{/snippet}

{#snippet sectionHeading(text: string)}
	<h3 class="text-surface-600-300 pt-4 pb-1 text-xs font-semibold tracking-wide uppercase">{text}</h3>
{/snippet}

{#snippet toolRows(group: 'latex' | 'typst' | 'general', heading: string)}
	{@render sectionHeading(heading)}
	<!-- two columns for the LaTeX crowd: one column of name-plus-verdict rows was half whitespace.
	     A group with a single tool (tinymist, git) keeps the full width, so its version line does
	     not truncate for a column that isn't there. The version rides along truncated when needed
	     (hover for the full line); the tool's purpose is the row tooltip -->
	<div class="{SUB} grid gap-x-6 {toolsInGroup(group).length > 1 ? 'grid-cols-2' : 'grid-cols-1'}">
		{#each toolsInGroup(group) as tool (tool.id)}
			{@const probe = probeFor(tool.id)}
			<!-- tinymist resolves through its own path (configured / PATH / managed), so its row reads
			     that result rather than the generic probe -->
			{@const found = tool.id === 'tinymist' ? tinymist !== null && tinymist !== 'unchecked' : !!probe?.found && probe.usable !== false}
			{@const detail =
				tool.id === 'tinymist'
					? tinymist && tinymist !== 'unchecked'
						? `${tinymist.version} (Typst ${tinymist.typstVersion}, ${tinymist.source})`
						: undefined
					: probe?.detail}
			<div class="border-surface-200-800 flex min-w-0 items-baseline gap-2 border-b py-2" title={tool.purpose}>
				<span class="shrink-0 font-mono text-sm font-medium">{tool.name}</span>
				{#if probing || probeFailed}
					<span class="text-surface-400 text-xs">…</span>
				{:else}
					<span class="shrink-0 text-xs {found ? 'text-success-600-400' : 'text-surface-400'}">
						{found ? m.prefs_toolchain_found() : m.prefs_toolchain_missing()}
					</span>
					{#if found && detail}
						<span class="text-surface-400 min-w-0 truncate font-mono text-xs" title={detail}>{detail}</span>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
{/snippet}

{#snippet toggleRow(text: string, hint: string, checked: boolean, onChange: (v: boolean) => void, disabled = false, title = '')}
	<div class={ROW} {title}>
		{@render label(text, hint, disabled)}
		<Switch {checked} {disabled} onCheckedChange={(d) => onChange(d.checked)}>
			<Switch.Control><Switch.Thumb /></Switch.Control>
			<Switch.HiddenInput />
		</Switch>
	</div>
{/snippet}

{#snippet selectRow(
	text: string,
	hint: string,
	value: string | number,
	options: { value: string | number; label: string }[],
	onChange: (v: string) => void,
	width = 'w-32'
)}
	<div class={ROW}>
		{@render label(text, hint)}
		<select class="select {width} shrink-0 text-sm" {value} onchange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>
			{#each options as o (o.value)}
				<option value={o.value}>{o.label}</option>
			{/each}
		</select>
	</div>
{/snippet}

{#if open}
	<div
		class="app-scrim fixed inset-0 z-1300 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
		onmousedown={(e) => e.target === e.currentTarget && (open = false)}
	>
		<div
			class="card bg-surface-50-950 border-surface-300-700 flex h-[34rem] max-h-full w-full max-w-3xl overflow-hidden border p-0 shadow-2xl"
		>
			<!-- category list. Plain buttons rather than a tree: there is one level, and a disclosure
			     arrow on something that never expands is a promise the UI does not keep. -->
			<nav class="border-surface-300-700 bg-surface-100-900 w-44 shrink-0 overflow-y-auto border-r p-2">
				<!-- the column's top edge was dead space, and this is the one dialog with a column to
				     spare. Height matched to the category rows so it reads as a heading over them
				     rather than a banner. -->
				<div class="mb-2 px-3 pt-2 pb-3">
					<img src={logoOnLight} alt="ModuTeX" class="h-6 w-auto dark:hidden" />
					<img src={logoOnDark} alt="ModuTeX" class="hidden h-6 w-auto dark:block" />
				</div>
				{#each categories as c (c.id)}
					<button
						class="mb-0.5 block w-full rounded px-3 py-1.5 text-left text-sm {category === c.id
							? 'bg-primary-500/15 text-primary-700 dark:text-primary-300 font-medium'
							: 'hover:bg-surface-200-800'}"
						onclick={() => (category = c.id)}
					>
						{c.label}
					</button>
				{/each}
			</nav>

			<div class="flex min-w-0 flex-1 flex-col">
				<div class="border-surface-200-800 flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3">
					<h2 class="text-base font-semibold">{categories.find((c) => c.id === category)?.label ?? m.prefs_title()}</h2>
					<button class="btn-icon btn-icon-xs hover:preset-tonal" aria-label={m.prefs_close_aria()} onclick={() => (open = false)}
						><X class="size-4" /></button
					>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto px-5">
					{#if category === 'appearance'}
						<div class={ROW}>
							{@render label(m.prefs_theme(), m.prefs_appearance_hint())}
							<div class="bg-surface-200-800 rounded-base flex shrink-0 gap-1 p-0.5">
								{#each themes as t (t.value)}
									<button
										class="rounded-base px-3 py-1 text-sm {$themeChoice === t.value
											? 'bg-surface-50-950 font-medium shadow-sm'
											: 'text-surface-600-400 hover:text-surface-950-50'}"
										onclick={() => setTheme(t.value)}
									>
										{t.label}
									</button>
								{/each}
							</div>
						</div>
						<div class={ROW}>
							<!-- the one setting a user may need to find while the UI is in a language they
							     cannot read, so it carries an icon the others do not -->
							<div class="flex min-w-0 items-center gap-2">
								<Languages class="text-surface-500 size-4 shrink-0" />
								{@render label(m.prefs_language(), '')}
							</div>
							<select class="select w-32 shrink-0 text-sm" value={$settings.uiLocale} onchange={onLocaleChange}>
								{#each uiLocales as l (l.value)}
									<option value={l.value}>{l.label}</option>
								{/each}
							</select>
						</div>
						<!-- the whole of what a "PDF preview" tab held: one switch, and one about how the
						     document LOOKS, which is the question this tab already answers -->
						{@render toggleRow(m.prefs_dark_pdf_pages(), m.prefs_dark_pdf_pages_note(), $settings.pdfDarkPages, (v) =>
							updateSettings({ pdfDarkPages: v })
						)}
					{:else if category === 'editor'}
						<!-- the settings that belong to neither editor in particular lead, unheaded; the two
						     that are ABOUT one editor sit under its name below -->
						{@render toggleRow(
							m.prefs_autosave(),
							$settings.draftMode ? m.prefs_autosave_note_live() : m.prefs_autosave_note_off(),
							autosaveForced || $settings.autosave,
							(v) => updateSettings({ autosave: v }),
							autosaveForced,
							autosaveForced ? m.prefs_autosave_hint_forced() : ''
						)}
						{@render toggleRow(m.prefs_spellcheck(), '', $settings.spellcheck, (v) => setSpellcheckEnabled(v))}
						{@render selectRow(m.prefs_keybindings(), m.prefs_keybindings_note(), $settings.editorKeymap ?? 'default', keymaps, (v) =>
							updateSettings({ editorKeymap: v as AppSettings['editorKeymap'] })
						)}
						{@render sectionHeading(m.prefs_group_source())}
						<div class={SUB}>
							{@render toggleRow(m.prefs_source_line_wrap(), m.prefs_source_line_wrap_note(), $settings.sourceLineWrap !== false, (v) =>
								updateSettings({ sourceLineWrap: v })
							)}
							{@render toggleRow(m.prefs_math_preview(), m.prefs_math_preview_note(), $settings.mathPreview !== false, (v) =>
								updateSettings({ mathPreview: v })
							)}
						</div>
						{@render sectionHeading(m.prefs_group_visual())}
						<div class={SUB}>
							<div class={ROW}>
								{@render label(m.prefs_visual_width(), m.prefs_visual_width_note())}
								<div class="w-48 shrink-0">
									<div class="text-surface-500 mb-1 text-right text-xs tabular-nums">{$settings.visualMaxWidth ?? 768}px</div>
									<!-- oninput, not onchange: a width slider is only useful if the column moves under
									     the cursor. updateSettingsLive applies each value, writing only the settled one. -->
									<input
										class="w-full accent-current"
										type="range"
										min="560"
										max="1600"
										step="16"
										value={$settings.visualMaxWidth ?? 768}
										oninput={(e) => updateSettingsLive({ visualMaxWidth: Number((e.currentTarget as HTMLInputElement).value) })}
										aria-label={m.prefs_visual_width()}
									/>
								</div>
							</div>
							{@render selectRow(
								m.prefs_image_resize_step(),
								m.prefs_image_resize_step_note(),
								$settings.figureResizeStep,
								resizeSteps,
								(v) => updateSettings({ figureResizeStep: Number(v) }),
								'w-24'
							)}
						</div>
					{:else if category === 'toolchain'}
						<!-- Nothing here is a preference; it is all "what did we find on this machine".
						     The switches that used to sit above the LaTeX list - live mode, the compile
						     completion marker - were second copies of switches in the compile-command dialog,
						     which is where you go to decide how this project builds. One control, one home.
						     Typst's preview switch was never duplicated here for the same reason. -->
						{@render toolchainHeader()}
						{@render toolRows('latex', m.prefs_group_latex())}
						{@render toolRows('typst', m.prefs_group_typst())}
						<!-- No path box for tinymist, and none for the eight above it either. Where a program
						     lives is the operating system's answer to give: every installer puts it on PATH,
						     and fixShellPath() in main.ts already recovers the login-shell PATH a GUI launch
						     misses. A second copy of $PATH kept in app settings is one more place for it to be
						     wrong, and the row above already says whether the OS's answer worked. -->
						{@render toolRows('general', m.prefs_group_vcs())}
					{:else if category === 'startup'}
						{@render toggleRow(m.prefs_reopen_last_folder(), '', $settings.reopenLastFolder, (v) =>
							updateSettings({ reopenLastFolder: v })
						)}
					{:else if category === 'ai'}
						<div class={ROW}>
							<!-- persisted through the main process, not updateSettings: flipping this also has to
							     start or stop the loopback server, and main owns it -->
							{@render label(m.prefs_mcp(), m.prefs_mcp_note())}
							<Switch checked={$settings.mcpEnabled === true} onCheckedChange={(d) => void onMcpToggle(d.checked)}>
								<Switch.Control><Switch.Thumb /></Switch.Control>
								<Switch.HiddenInput />
							</Switch>
						</div>
						{#if $settings.mcpEnabled === true && mcp}
							<div class="border-surface-200-800 flex items-center justify-between gap-3 border-b py-3">
								{#if mcp.running && mcp.port}
									<span class="text-surface-500 text-xs">{m.prefs_mcp_status({ addr: `127.0.0.1:${mcp.port}` })}</span>
									<!-- the command lives in its own modal: it is long, and read once -->
									<button class="btn btn-xs preset-tonal shrink-0 text-xs" onclick={() => (setupOpen = true)}>{m.prefs_mcp_show()}</button>
								{:else}
									<span class="text-error-600 text-xs">{m.prefs_mcp_error({ error: mcp.error ?? '' })}</span>
								{/if}
							</div>
							<!-- A SECOND permission, listed under the first because it is meaningless without it,
							     but deliberately not implied by it: everything else this server exposes reads
							     state or moves the window, while a compile command is a shell command line. -->
							{@render toggleRow(
								m.prefs_mcp_compile_command(),
								m.prefs_mcp_compile_command_note(),
								$settings.mcpAllowCompileCommand === true,
								(v) => updateSettings({ mcpAllowCompileCommand: v })
							)}
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>

	<!-- outside the settings scroller so it is not clipped by it, and only while Preferences is
	     open, so closing Preferences takes the instructions with it -->
	<McpSetupModal bind:open={setupOpen} port={mcp?.port ?? null} />
{/if}
