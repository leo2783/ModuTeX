<script lang="ts">
	// The Comments tab in the bottom dock: every review thread in the workspace, newest activity
	// first, with replies inline.
	//
	// This is the "overview" half of a review panel - the flat list you scan and jump from. The
	// in-context half is the gutter dot and the highlight in the editor. Splitting them that way is
	// what lets comments exist at all in a layout that already spends its width on the preview: a
	// list wants horizontal room, which the dock has and a 230px rail beside the editor does not.
	import { MessageSquare, Check, Trash2, Unlink, Pencil, EyeOff, FileX } from '@lucide/svelte';
	import InitialAvatar from './InitialAvatar.svelte';
	import type { CommentMessage, CommentThread } from '$lib/comments/log';
	import { m } from '$lib/paraglide/messages';

	let {
		threads,
		activeFile = null,
		orphaned = new Set<string>(),
		notVisible = new Set<string>(),
		filesPresent = null,
		selected = null,
		pending = null,
		onOpen,
		onReply,
		onResolve,
		onDelete,
		onEditMessage = () => {},
		onDeleteMessage = () => {},
		onSubmitPending = () => {},
		onCancelPending = () => {}
	}: {
		threads: CommentThread[];
		/** workspace-relative path of the open file, for the "this file only" filter */
		activeFile?: string | null;
		/** threads on the ACTIVE file whose quote no longer appears in it; unknown for other files */
		orphaned?: Set<string>;
		/** placed in the file but not drawable in the CURRENT view (visual mode, quote is markup);
		 * distinct from orphaned - switching to source brings these back */
		notVisible?: Set<string>;
		/** every workspace-relative file path that exists, or null for "unknown, draw no badges".
		 * Threads deliberately SURVIVE their file's deletion (undo brings both back), so the panel
		 * has to say the file is gone rather than present a dead link. */
		filesPresent?: Set<string> | null;
		selected?: string | null;
		/** a selection waiting for its first message; not a thread until one is written */
		pending?: { quote: string } | null;
		onOpen: (thread: CommentThread) => void;
		onReply: (thread: CommentThread, body: string) => void;
		onResolve: (thread: CommentThread, resolved: boolean) => void;
		onDelete: (thread: CommentThread) => void;
		/** one message rather than the whole thread */
		onEditMessage?: (message: CommentMessage, body: string) => void;
		onDeleteMessage?: (thread: CommentThread, message: CommentMessage) => void;
		onSubmitPending?: (body: string) => void;
		onCancelPending?: () => void;
	} = $props();

	let thisFileOnly = $state(false);
	let showResolved = $state(false);
	let expanded = $state<string | null>(null);
	let draft = $state('');
	let newDraft = $state('');
	/** the message being rewritten in place, if any */
	let editing = $state<string | null>(null);
	let editDraft = $state('');
	let composer = $state<HTMLTextAreaElement | null>(null);
	let list = $state<HTMLDivElement | null>(null);

	/**
	 * Follow a selection made outside this panel - clicking a highlight in the editor.
	 *
	 * Keyed on `selected` CHANGING, not on it being set: reacting to the value itself would
	 * re-expand a thread the moment you collapsed it, since collapsing does not deselect.
	 */
	let lastSelected: string | null = null;
	$effect(() => {
		const id = selected;
		if (id === lastSelected) return;
		lastSelected = id;
		if (!id) return;
		expanded = id;
		draft = '';
		// after the row has expanded, or it scrolls to where the row used to end
		requestAnimationFrame(() => list?.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
	});

	// the reader asked for this from the editor, so the caret should already be here; nothing else
	// in the dock takes focus on its own
	$effect(() => {
		if (pending) composer?.focus();
	});

	const shown = $derived(
		threads
			.filter((t) => (showResolved || !t.resolved) && (!thisFileOnly || t.file === activeFile))
			// most recent activity first: a thread someone just replied to is the one you want
			.toSorted((a, b) => (last(b) ?? '').localeCompare(last(a) ?? ''))
	);
	const openCount = $derived(threads.filter((t) => !t.resolved).length);

	const last = (t: CommentThread) => t.messages.at(-1)?.at;

	/**
	 * A quote is a raw slice of source, so it arrives with its newlines and indentation intact and
	 * renders as a ragged multi-line block. Collapsed to one line it reads as a label, which is all
	 * it is here - the document is where you go to see it in context.
	 */
	const oneLine = (s: string, max = 90) => {
		const flat = s.replace(/\s+/g, ' ').trim();
		return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
	};

	function saveEdit(msg: CommentMessage) {
		const body = editDraft.trim();
		editing = null;
		if (body) onEditMessage(msg, body);
	}

	function submit(thread: CommentThread) {
		const body = draft.trim();
		if (!body) return;
		draft = '';
		onReply(thread, body);
	}

	function toggle(thread: CommentThread) {
		expanded = expanded === thread.id ? null : thread.id;
		draft = '';
		onOpen(thread);
	}
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
	<div class="border-surface-200-800 flex h-7 shrink-0 items-center gap-3 border-b px-2">
		<span class="text-surface-600-300">{m.comments_open_count({ count: openCount })}</span>
		<label class="text-surface-500-400 ml-auto flex cursor-pointer items-center gap-1.5">
			<input type="checkbox" class="checkbox scale-75" bind:checked={thisFileOnly} />
			{m.comments_this_file()}
		</label>
		<label class="text-surface-500-400 flex cursor-pointer items-center gap-1.5">
			<input type="checkbox" class="checkbox scale-75" bind:checked={showResolved} />
			{m.comments_show_resolved()}
		</label>
	</div>
	<div bind:this={list} class="min-h-0 flex-1 overflow-y-auto">
		{#if pending}
			<div class="border-surface-200-800 bg-surface-100-900/60 max-w-2xl space-y-2 border-b p-2">
				<span class="text-surface-500-400 block truncate font-mono" title={pending.quote}>{oneLine(pending.quote)}</span>
				<textarea
					bind:this={composer}
					class="textarea min-h-8 w-full text-xs"
					rows="2"
					placeholder={m.comments_reply_placeholder()}
					bind:value={newDraft}
					onkeydown={(e) => {
						if (e.key === 'Escape') {
							newDraft = '';
							onCancelPending();
						} else if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							if (!newDraft.trim()) return;
							onSubmitPending(newDraft.trim());
							newDraft = '';
						}
					}}></textarea>
				<div class="flex items-center gap-1">
					<button
						class="btn btn-xs preset-filled-primary-500"
						disabled={!newDraft.trim()}
						onclick={() => {
							onSubmitPending(newDraft.trim());
							newDraft = '';
						}}
					>
						{m.comments_add()}
					</button>
					<button
						class="btn btn-xs hover:preset-tonal"
						onclick={() => {
							newDraft = '';
							onCancelPending();
						}}
					>
						{m.comments_cancel()}
					</button>
				</div>
			</div>
		{/if}
		{#if shown.length === 0 && !pending}
			<div class="text-surface-500-400 flex flex-1 items-center gap-2 p-4">
				<MessageSquare class="size-4 shrink-0" />
				{threads.length === 0 ? m.comments_empty() : m.comments_empty_file()}
			</div>
		{:else}
			{#each shown as thread (thread.id)}
				{@const isOpen = expanded === thread.id}
				{@const fileGone = filesPresent !== null && !filesPresent.has(thread.file)}
				{@const lost = !fileGone && orphaned.has(thread.id)}
				{@const hidden = !fileGone && !lost && notVisible.has(thread.id)}
				<div
					data-thread={thread.id}
					class="border-surface-200-800/60 border-b last:border-b-0 {selected === thread.id ? 'bg-surface-200-800/40' : ''}"
				>
					<!-- the summary and the thread actions are SIBLINGS: a button cannot contain a button,
					     and Resolve/Delete belong on the header rather than under the reply box, where
					     they read as things you do to your reply -->
					<div class="hover:bg-surface-200-800/60 group flex items-start">
						<button
							class="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
							onclick={() => toggle(thread)}
							aria-expanded={isOpen}
						>
							{#if thread.resolved}
								<Check class="text-success-600-400 mt-0.5 size-3.5 shrink-0" />
							{:else if fileGone}
								<FileX class="text-warning-600-400 mt-0.5 size-3.5 shrink-0" />
							{:else if lost}
								<Unlink class="text-warning-600-400 mt-0.5 size-3.5 shrink-0" />
							{:else if hidden}
								<EyeOff class="text-surface-500-400 mt-0.5 size-3.5 shrink-0" />
							{:else}
								<MessageSquare class="text-primary-500 mt-0.5 size-3.5 shrink-0" />
							{/if}
							<span class="min-w-0 flex-1">
								<!-- the quote first: it is what tells you which comment this is, faster than the
								     body does, and it is the only part that ties the row to the document -->
								<span class="text-surface-500-400 block truncate font-mono" title={thread.anchor.quote}>{oneLine(thread.anchor.quote)}</span
								>
								<!-- the body preview goes when the thread opens: the messages below start with
								     this same text, and showing both made every thread look like it had a
								     duplicate first reply -->
								{#if !isOpen}
									<span class="block truncate" title={thread.messages[0]?.body}>{thread.messages[0]?.body}</span>
								{/if}
							</span>
							<!-- one centred cluster: the row is items-start (the quote block can be two lines),
							     so loose trailing spans each top-align on their own - and a 10px badge box is
							     shorter than the filename's line, which floated "Detached" above main.tex -->
							<span class="flex shrink-0 items-center gap-1.5">
								{#if thread.messages.length > 1 && !isOpen}
									<span class="badge preset-tonal-surface px-1 py-0 text-[10px]">{thread.messages.length}</span>
								{/if}
								{#if fileGone}
									<span class="badge preset-tonal-warning px-1 py-0 text-[10px]">{m.comments_file_gone_badge()}</span>
								{:else if lost}
									<span class="badge preset-tonal-warning px-1 py-0 text-[10px]">{m.comments_orphaned_badge()}</span>
								{:else if hidden}
									<!-- neutral, not warning: nothing is wrong, the comment just lives in markup the
									     visual editor renders rather than shows -->
									<span class="badge preset-tonal-surface px-1 py-0 text-[10px]">{m.comments_not_in_view_badge()}</span>
								{/if}
								<span class="text-surface-500-400 font-mono">{thread.file}</span>
							</span>
						</button>
						<!-- icon-only, and only on hover or while open: Resolve and Delete are one click from
						     destroying somebody's thread, so they should not sit lit up on every row -->
						<div class="flex shrink-0 items-center gap-0.5 py-1.5 pr-2 {isOpen ? '' : 'opacity-0 group-hover:opacity-100'}">
							<button
								class="hover:preset-tonal rounded p-1"
								title={thread.resolved ? m.comments_reopen() : m.comments_resolve()}
								aria-label={thread.resolved ? m.comments_reopen() : m.comments_resolve()}
								onclick={() => onResolve(thread, !thread.resolved)}
							>
								<Check class="size-3.5" />
							</button>
							<button
								class="hover:preset-tonal-error rounded p-1"
								title={m.comments_delete()}
								aria-label={m.comments_delete()}
								onclick={() => onDelete(thread)}
							>
								<Trash2 class="size-3.5" />
							</button>
						</div>
					</div>
					{#if isOpen}
						<!-- max-w: the dock is as wide as the editor, and a conversation set in a column
						     that wide is unreadable. Prose wants a measure, not the space available -->
						<div class="max-w-2xl space-y-2 px-2 pt-1 pb-3 pl-7">
							{#if fileGone}
								<p class="text-warning-600-400">{m.comments_file_gone()}</p>
							{:else if lost}
								<p class="text-warning-600-400">{m.comments_orphaned()}</p>
							{:else if hidden}
								<p class="text-surface-500-400">{m.comments_not_in_view()}</p>
							{/if}
							{#each thread.messages as msg (msg.id)}
								<div class="group/msg flex items-start gap-2 leading-snug">
									<InitialAvatar name={msg.by} class="mt-0.5 size-5 text-[10px]" />
									<div class="min-w-0 flex-1">
										<span class="text-surface-500-400 font-medium">{msg.by}</span>
										{#if msg.editedAt}
											<!-- so nobody is quoted saying something they later rewrote -->
											<span class="text-surface-500-400 italic">({m.comments_edited()})</span>
										{/if}
										{#if editing === msg.id}
											<textarea
												class="textarea mt-1 w-full resize-none py-1 text-xs"
												rows="2"
												bind:value={editDraft}
												onkeydown={(e) => {
													if (e.key === 'Escape') editing = null;
													else if (e.key === 'Enter' && !e.shiftKey) {
														e.preventDefault();
														saveEdit(msg);
													}
												}}></textarea>
											<div class="mt-1 flex items-center gap-1">
												<button class="btn btn-xs preset-filled-primary-500" disabled={!editDraft.trim()} onclick={() => saveEdit(msg)}>
													{m.comments_save()}
												</button>
												<button class="btn btn-xs hover:preset-tonal" onclick={() => (editing = null)}>{m.comments_cancel()}</button>
											</div>
										{:else}
											<p class="whitespace-pre-wrap">{msg.body}</p>
										{/if}
									</div>
									{#if editing !== msg.id}
										<div class="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/msg:opacity-100">
											<button
												class="hover:preset-tonal rounded p-1"
												title={m.comments_edit()}
												aria-label={m.comments_edit()}
												onclick={() => {
													editing = msg.id;
													editDraft = msg.body;
												}}
											>
												<Pencil class="size-3" />
											</button>
											<button
												class="hover:preset-tonal-error rounded p-1"
												title={m.comments_delete_message()}
												aria-label={m.comments_delete_message()}
												onclick={() => onDeleteMessage(thread, msg)}
											>
												<Trash2 class="size-3" />
											</button>
										</div>
									{/if}
								</div>
							{/each}
							<!-- One line at rest, growing only once there is something in it, and the Reply
							     button appears with the text. An empty box three rows tall under every thread
							     was most of what made this panel feel like a form. pl-7 lines it up with the
							     message bodies, past their avatars. -->
							<div class="space-y-1.5 pl-7">
								<textarea
									class="textarea w-full resize-none py-1 text-xs {draft.trim() ? 'min-h-14' : 'min-h-0 h-7'}"
									rows="1"
									placeholder={m.comments_reply_placeholder()}
									bind:value={draft}
									onkeydown={(e) => {
										// Enter sends, Shift+Enter breaks the line: a review reply is one or two
										// sentences, so reaching for a button every time is the wrong default
										if (e.key === 'Enter' && !e.shiftKey) {
											e.preventDefault();
											submit(thread);
										}
									}}></textarea>
								{#if draft.trim()}
									<button class="btn btn-xs preset-filled-primary-500" onclick={() => submit(thread)}>
										{m.comments_reply()}
									</button>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
