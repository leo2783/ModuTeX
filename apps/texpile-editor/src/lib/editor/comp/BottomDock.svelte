<script lang="ts">
	// The bottom dock: a Terminal/Problems tab strip over the shell instances. Owns the multi-
	// terminal state (VS Code-style: one shown, the rest kept mounted so their shells persist).
	// The parent owns only the dock's height/visibility (they drive its grid layout).
	import ProblemsPanel from './ProblemsPanel.svelte';
	import CommentsPanel from './CommentsPanel.svelte';
	import type { CommentMessage, CommentThread } from '$lib/comments/log';
	import { compileLog } from '$lib/stores/compileLogStore';
	import { m } from '$lib/paraglide/messages';
	import { SquareTerminal, ChevronDown, Check, Trash2, Plus, X, FoldHorizontal, UnfoldHorizontal } from '@lucide/svelte';

	type TermRef =
		| { run: (cmd: string, onDone?: (output: string) => void) => void; focus: () => void; refit: () => void; interrupt: () => void }
		| undefined;

	let {
		cwd,
		view = $bindable<'terminal' | 'problems' | 'comments'>('terminal'),
		pdfPaneOpen = false,
		shrink = false,
		terminalEnabled = true,
		onToggleShrink,
		onClose,
		onProblemJump,
		comments = [],
		commentFile = null,
		commentsOrphaned = new Set<string>(),
		commentsNotVisible = new Set<string>(),
		commentFilesPresent = null,
		commentSelected = null,
		onCommentOpen = () => {},
		onCommentReply = () => {},
		onCommentResolve = () => {},
		onCommentDelete = () => {},
		onCommentEditMessage = () => {},
		onCommentDeleteMessage = () => {},
		commentPending = null,
		onCommentSubmitPending = () => {},
		onCommentCancelPending = () => {}
	}: {
		cwd: string;
		view?: 'terminal' | 'problems' | 'comments';
		pdfPaneOpen?: boolean;
		shrink?: boolean;
		/** false for guests: no shells, the dock is a Problems panel only. */
		terminalEnabled?: boolean;
		onToggleShrink: () => void;
		onClose: () => void;
		onProblemJump: (file: string, line: number, selectText?: string) => void;
		/** review threads for the whole workspace; see CommentsPanel */
		comments?: CommentThread[];
		commentFile?: string | null;
		commentsOrphaned?: Set<string>;
		commentsNotVisible?: Set<string>;
		commentFilesPresent?: Set<string> | null;
		commentSelected?: string | null;
		onCommentOpen?: (thread: CommentThread) => void;
		onCommentReply?: (thread: CommentThread, body: string) => void;
		onCommentResolve?: (thread: CommentThread, resolved: boolean) => void;
		onCommentDelete?: (thread: CommentThread) => void;
		onCommentEditMessage?: (message: CommentMessage, body: string) => void;
		onCommentDeleteMessage?: (thread: CommentThread, message: CommentMessage) => void;
		commentPending?: { quote: string } | null;
		onCommentSubmitPending?: (body: string) => void;
		onCommentCancelPending?: () => void;
	} = $props();

	const openComments = $derived(comments.filter((c) => !c.resolved).length);

	let terminals = $state<{ id: number; title: string }[]>([]);
	let activeTermId = $state<number | null>(null);
	let menuOpen = $state(false);
	let seq = 0;
	const refs: Record<number, TermRef> = {};
	const activeRef = (): TermRef => (activeTermId != null ? refs[activeTermId] : undefined);

	// Compile gets a shell of its own. It used to run on whichever tab happened to be selected,
	// which is only safe if that tab is sitting at a prompt: with Claude Code, vim, less, an ssh
	// session or a REPL in front, the compile command was typed into THAT program's stdin instead.
	// There is no reliable way to ask a pty whether a foreground process is reading input, so the
	// fix is to never borrow the user's shell in the first place.
	let compileTermId = $state<number | null>(null);

	// The tab NUMBER is counted separately from the shell id. Ids are unique across every shell,
	// the compile one included, so titling by id meant that once compile had taken id 1 the user's
	// first terminal came out called "Terminal 2". This counter only ever advances for shells the
	// user can see as numbered tabs.
	let termNo = 0;
	const userTerm = (id: number) => ({ id, title: m.wsview_terminal_numbered({ id: ++termNo }) });

	function ensure() {
		if (terminals.length === 0) {
			const t = userTerm(++seq);
			terminals = [t];
			activeTermId = t.id;
		}
	}
	function add() {
		const t = userTerm(++seq);
		terminals = [...terminals, t];
		activeTermId = t.id;
		menuOpen = false;
		setTimeout(() => activeRef()?.focus(), 50);
	}
	function select(id: number) {
		activeTermId = id;
		menuOpen = false;
		setTimeout(() => {
			activeRef()?.refit();
			activeRef()?.focus();
		}, 0);
	}
	function kill(id: number) {
		terminals = terminals.filter((t) => t.id !== id);
		refs[id] = undefined;
		if (compileTermId === id) compileTermId = null; // the next compile makes a fresh one
		if (activeTermId === id) activeTermId = terminals.at(-1)?.id ?? null;
		if (terminals.length === 0) onClose();
		else setTimeout(() => activeRef()?.refit(), 0);
	}

	// Terminal drags in @xterm/* + css, so it loads when the dock first mounts, not at boot
	let TerminalComp = $state<typeof import('./Terminal.svelte').default | null>(null);

	// No shell is created here. The dock mounts for several reasons that are not "the user wants a
	// terminal": a compile opens it to show output, and so does jumping to Problems. Creating one on
	// mount meant a plain Compile put a shell named Terminal 1 next to the Compile tab, which the
	// user never asked for and then has to close. Whoever opens the dock ON PURPOSE calls
	// ensureTerminal() instead.
	// Mount-time read on purpose: a dock is host (shells) or guest (problems-only) for life.
	// svelte-ignore state_referenced_locally
	if (terminalEnabled) {
		import('./Terminal.svelte').then(
			(mod) => (TerminalComp = mod.default),
			(e) => console.error('Failed to load terminal chunk:', e)
		);
	} else view = 'problems';

	// ---- parent API (via bind:this) ----
	/** the compile shell, created on demand and reused; never one the user is working in */
	function ensureCompileTerm(): number | null {
		if (!terminalEnabled) return null;
		if (compileTermId != null && terminals.some((t) => t.id === compileTermId)) return compileTermId;
		const id = ++seq;
		terminals = [...terminals, { id, title: m.wsview_terminal_compile() }];
		compileTermId = id;
		return id;
	}

	/** run a command on the dedicated compile shell, retrying until it has spawned. */
	export function runCommand(cmd: string, onDone?: (output: string) => void, tries = 0): void {
		const id = ensureCompileTerm();
		if (id == null) return; // guest dock: no shells at all
		// Runs in the background: whatever tab the user is on stays selected. Compiling should not
		// yank them out of a shell they are working in - errors surface in Problems either way, and
		// the Compile tab is right there if they want the raw output.
		//
		// The exception is having nothing selected at all (first compile before any shell existed),
		// where showing the compile shell steals nothing.
		if (activeTermId == null) {
			activeTermId = id;
			setTimeout(() => refs[id]?.refit(), 0);
		}
		const ref = refs[id];
		if (ref) {
			ref.run(cmd, onDone);
			return;
		}
		if (tries < 40) setTimeout(() => runCommand(cmd, onDone, tries + 1), 25); // ~1s for first mount
	}
	/** drop every shell (folder changed: they are all in the old cwd) and respawn one, but only if
	 *  the user actually had one. A dock holding nothing but the compile shell goes back to empty
	 *  rather than gaining a terminal off the back of a folder switch. Numbering restarts with the
	 *  new folder. */
	export function reset(): void {
		if (terminals.length === 0) return;
		const hadUserShell = terminals.some((t) => t.id !== compileTermId);
		compileTermId = null;
		termNo = 0;
		if (!hadUserShell) {
			terminals = [];
			activeTermId = null;
			return;
		}
		const t = userTerm(++seq);
		terminals = [t];
		activeTermId = t.id;
		setTimeout(() => activeRef()?.refit(), 0);
	}
	export function refit(): void {
		activeRef()?.refit();
	}
	export function focusActive(): void {
		activeRef()?.focus();
	}
	export function addTerminal(): void {
		add();
	}
	/** the user opened the terminal on purpose: give them a shell if they have none yet */
	export function ensureTerminal(): void {
		if (terminalEnabled) ensure();
	}
	/** Ctrl-C the running command (compile stop). Targets the compile shell, not the selected tab:
	 *  Stop must kill the compile even if the user has since switched to their own terminal, and
	 *  must never Ctrl-C whatever they are running there. */
	export function interrupt(): void {
		const ref = compileTermId != null ? refs[compileTermId] : undefined;
		(ref ?? activeRef())?.interrupt();
	}
</script>

<div class="@container bg-surface-100-900 text-surface-600-300 flex h-8 shrink-0 items-center gap-2 px-2 text-xs">
	<!-- The tabs scroll and the actions never shrink. Both sides used to be shrinkable, so a narrow
	     dock squeezed each group below its content and the two drew on top of each other - which is
	     what a dock beside an open PDF preview does routinely. toolbar-hscroll hides the bar; there
	     is no room for one in an h-8 strip, and the format toolbar already scrolls this way.

	     Scrolling is the LAST resort though: a tab that has scrolled out of view is a tab nobody
	     knows exists, and Comments was going first. So the strip is a @container and the terminal
	     name below drops out before the tabs are squeezed - see there. -->
	<div class="toolbar-hscroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
		{#if terminalEnabled}
			<button
				class="shrink-0 rounded px-2 py-1 whitespace-nowrap {view === 'terminal' ? 'preset-tonal' : 'hover:preset-tonal'}"
				onclick={() => {
					view = 'terminal';
					ensure(); // a fresh shell if the last one was killed, so the pane is never empty
				}}
			>
				{m.wsview_terminal_label()}
			</button>
		{/if}
		<button
			class="flex shrink-0 items-center gap-1 rounded px-2 py-1 whitespace-nowrap {view === 'problems'
				? 'preset-tonal'
				: 'hover:preset-tonal'}"
			onclick={() => (view = 'problems')}
		>
			{m.wsview_problems_label()}
			{#if $compileLog && $compileLog.errors.length > 0}
				<span class="text-error-500 font-semibold">{$compileLog.errors.length}</span>
			{:else if $compileLog && $compileLog.warnings.length > 0}
				<span class="text-warning-600-400 font-semibold">{$compileLog.warnings.length}</span>
			{/if}
		</button>
		<!-- always present, not only once a thread exists: a tab that appears when there is something
			     in it is a tab nobody finds in the document they actually want to comment on -->
		<button
			class="flex shrink-0 items-center gap-1 rounded px-2 py-1 whitespace-nowrap {view === 'comments'
				? 'preset-tonal'
				: 'hover:preset-tonal'}"
			onclick={() => (view = 'comments')}
		>
			{m.wsview_comments_label()}
			{#if openComments > 0}
				<span class="text-primary-500 font-semibold">{openComments}</span>
			{/if}
		</button>
	</div>
	<div class="flex shrink-0 items-center gap-0.5">
		{#if view === 'terminal'}
			<div class="relative">
				<button class="hover:preset-tonal flex max-w-40 items-center gap-1.5 rounded px-2 py-1" onclick={() => (menuOpen = !menuOpen)}>
					<SquareTerminal class="size-3.5 shrink-0" />
					<!-- The first thing to go when the dock narrows, and the right thing: it is the only
					     label up here that is redundant. The icon still says terminal, the chevron still
					     opens the list, and that list names every shell with a tick on the active one -
					     whereas a tab that has scrolled away tells you nothing. 30rem is the width where
					     all three tabs plus the full action row stop fitting, with slack for the longer
					     German and Chinese labels. -->
					<span class="truncate font-medium @max-[30rem]:hidden"
						>{terminals.find((t) => t.id === activeTermId)?.title ?? m.wsview_terminal_label()}</span
					>
					<ChevronDown class="size-3 shrink-0" />
				</button>
				{#if menuOpen}
					<button class="fixed inset-0 z-40 cursor-default" aria-label={m.wsview_close_menu_aria()} onclick={() => (menuOpen = false)}
					></button>
					<div
						class="bg-surface-50-950 border-surface-300-700 absolute right-0 bottom-full z-50 mb-1 min-w-52 overflow-hidden rounded border py-1 shadow-lg"
					>
						{#each terminals as t (t.id)}
							<div class="hover:preset-tonal-surface flex items-center">
								<button class="flex flex-1 items-center gap-2 px-2.5 py-1.5 text-left" onclick={() => select(t.id)}>
									<Check class="size-3.5 {t.id === activeTermId ? '' : 'invisible'}" />
									<span class="truncate">{t.title}</span>
								</button>
								<button
									class="hover:preset-tonal-error mr-1 rounded p-1"
									title={m.wsview_kill_terminal()}
									aria-label={m.wsview_kill_terminal()}
									onclick={() => kill(t.id)}
								>
									<Trash2 class="size-3.5" />
								</button>
							</div>
						{/each}
						<!-- the rule and its margin separate this from the terminal list above; with no terminals
						     there is nothing to separate it from and they just read as a gap at the top -->
						<button
							class="hover:preset-tonal-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left {terminals.length
								? 'border-surface-200-800 mt-1 border-t'
								: ''}"
							onclick={add}
						>
							<Plus class="size-3.5" />
							{m.wsview_new_terminal()}
						</button>
					</div>
				{/if}
			</div>
			<button class="hover:preset-tonal rounded p-1" title={m.wsview_new_terminal()} aria-label={m.wsview_new_terminal()} onclick={add}>
				<Plus class="size-3.5" />
			</button>
			<button
				class="hover:preset-tonal-error rounded p-1"
				title={m.wsview_kill_terminal()}
				aria-label={m.wsview_kill_terminal()}
				onclick={() => activeTermId != null && kill(activeTermId)}
			>
				<Trash2 class="size-3.5" />
			</button>
		{/if}
		{#if pdfPaneOpen}
			<button
				class="hover:preset-tonal rounded p-1"
				title={shrink ? m.wsview_expand_panel_title() : m.wsview_shrink_panel_title()}
				aria-label={shrink ? m.wsview_expand_panel_aria() : m.wsview_shrink_panel_aria()}
				onclick={onToggleShrink}
			>
				{#if shrink}<UnfoldHorizontal class="size-3.5" />{:else}<FoldHorizontal class="size-3.5" />{/if}
			</button>
		{/if}
		<button class="hover:preset-tonal rounded p-1" title={m.wsview_hide_panel()} aria-label={m.wsview_hide_panel()} onclick={onClose}>
			<X class="size-3.5" />
		</button>
	</div>
</div>
<!-- all terminals stay mounted (shells persist); only the active one is shown -->
<div class="relative min-h-0 flex-1">
	{#if view === 'problems'}
		<div class="bg-surface-50-950 absolute inset-0 z-10 overflow-hidden">
			<ProblemsPanel root={cwd} onJump={onProblemJump} />
		</div>
	{:else if view === 'comments'}
		<div class="bg-surface-50-950 absolute inset-0 z-10 overflow-hidden">
			<CommentsPanel
				threads={comments}
				activeFile={commentFile}
				orphaned={commentsOrphaned}
				notVisible={commentsNotVisible}
				filesPresent={commentFilesPresent}
				selected={commentSelected}
				onOpen={onCommentOpen}
				onReply={onCommentReply}
				onResolve={onCommentResolve}
				onDelete={onCommentDelete}
				onEditMessage={onCommentEditMessage}
				onDeleteMessage={onCommentDeleteMessage}
				pending={commentPending}
				onSubmitPending={onCommentSubmitPending}
				onCancelPending={onCommentCancelPending}
			/>
		</div>
	{/if}
	{#if TerminalComp}
		{#each terminals as t (t.id)}
			<div class="absolute inset-0" style={t.id === activeTermId ? '' : 'display: none'}>
				<TerminalComp bind:this={refs[t.id]} {cwd} />
			</div>
		{/each}
	{/if}
	{#if terminalEnabled && view === 'terminal' && terminals.length === 0}
		<!-- the dock reopens without shells (a compile or a Problems jump is what left it visible) -->
		<div class="absolute inset-0 flex items-center justify-center">
			<button class="btn btn-xs preset-tonal flex items-center gap-1.5 text-xs" onclick={add}>
				<Plus class="size-3.5" />
				{m.wsview_new_terminal()}
			</button>
		</div>
	{/if}
</div>
