// Review comments as workspace state: the log, the threads resolved against the open file, and the
// actions the panel and the editor call.
//
// Kept out of WorkspaceView the way the other pipelines are - the view is already long, and none of
// this needs anything from it but the workspace root and a way to open a file.
import { CommentStore, relativeTo } from '$lib/comments/store.svelte';
import {
	buildAnchor,
	prepareLoose,
	resolveAnchor,
	resolveAnchorLoose,
	resolveAnchorLooseIn,
	type CommentAnchor,
	type LooseHaystack
} from '$lib/comments/anchor';
import {
	deleteEvent,
	deleteMessageEvent,
	editEvent,
	moveEvent,
	openEvent,
	placeEvent,
	replyEvent,
	resolveEvent,
	type CommentEvent,
	type CommentMessage,
	type CommentThread
} from '$lib/comments/log';
import { resolveAuthor, forgetAuthor } from '$lib/comments/author';
import type { CommentRange } from '$lib/editor/extensions/comments';

interface Deps {
	/** absolute workspace root, or null before a folder is open */
	root: () => string | null;
	/** the Preferences name; blank falls back to git */
	preferredAuthor: () => string;
	/** open a file and put the caret on a line (1-based) */
	openFileAt: (absPath: string, line: number) => void;
	/**
	 * Reveal a thread in the visual editor, if that is where the reader is and the thread is drawn
	 * there. False means "not from here" and the line jump is used instead.
	 */
	revealInVisual?: (id: string) => boolean;
	/**
	 * Hand a locally-made event to the session, if there is one.
	 *
	 * Called for everything this side originates and nothing it receives, so an event cannot loop:
	 * ingest() never publishes.
	 */
	publish?: (event: CommentEvent) => void;
}

export class CommentsController {
	readonly store = new CommentStore();
	/** the thread the reader is looking at, highlighted in both the panel and the editor */
	selected = $state<string | null>(null);
	/** where each thread on the ACTIVE file sits now; what the editor decorates */
	ranges = $state<CommentRange[]>([]);
	/** threads on the active file whose quote is gone from it */
	orphaned = $state<Set<string>>(new Set());
	/**
	 * Threads placed in the FILE but not drawable in the current view - the visual editor reports
	 * them after each placement pass. Distinct from orphaned on purpose: an orphan lost its text,
	 * these merely have no rendered text to sit on, and switching to source brings them back.
	 * Empty whenever the source editor is the view; it draws everything it can resolve.
	 */
	notVisible = $state<Set<string>>(new Set());
	/**
	 * A selection the reader has asked to comment on, before they have written anything.
	 *
	 * Held here rather than written straight to the log, because an empty thread on disk is a thread
	 * every other reader has to scroll past. The panel shows a composer for it and only the first
	 * message turns it into a real thread.
	 *
	 * Two shapes: source-mode offsets into `text` (the anchor is built at commit), or a ready-made
	 * anchor from the visual editor, whose positions mean nothing here.
	 */
	pending = $state<{ quote: string; from?: number; to?: number; anchor?: CommentAnchor } | null>(null);

	/** workspace-relative path of the file `ranges` was computed against */
	private file: string | null = null;
	private text = '';
	/** what we MEASURED on the open file, as opposed to what the log remembers about the others */
	private activeLost = new Set<string>();
	private activeHidden = new Set<string>();
	/** the reader is in the visual editor; see setVisualMode for why the hidden badge depends on it */
	private visual = false;
	/** a thread we are opening a different file for; selected once that file re-anchors */
	private pendingOpen: string | null = null;

	constructor(private readonly deps: Deps) {}

	get threads(): CommentThread[] {
		return this.store.threads;
	}
	get activeFile(): string | null {
		return this.file;
	}

	async load(root: string | null): Promise<void> {
		forgetAuthor();
		this.selected = null;
		this.pendingOpen = null;
		this.pending = null;
		this.activeHidden = new Set();
		this.activeLost = new Set();
		this.notVisible = new Set();
		await this.store.load(root);
	}

	/**
	 * Re-resolve every thread on this file against its current text.
	 *
	 * Called when a file opens and when its text is replaced from outside - NOT on every keystroke.
	 * While the editor is live, CodeMirror maps the decorations through each transaction, which is
	 * exact; re-searching on top of that would fight it and could snap a range somewhere else
	 * mid-edit.
	 */
	reanchor(absPath: string | null, text: string): void {
		const root = this.deps.root();
		this.file = absPath && root ? relativeTo(root, absPath) : null;
		this.text = text;
		this.resolve();
	}

	/**
	 * Re-read the log after someone else wrote it - a `git pull`, a second window, an agent.
	 *
	 * Keeps the selection, unlike load(): this is the same project, just with more in it, and having
	 * the panel jump away because a colleague's comment arrived would be its own bug.
	 */
	async refresh(): Promise<void> {
		// A guest holds the session's log in memory against a sentinel root - re-reading would find
		// no file and clear it. Their updates arrive as events over the wire; disk is the host's.
		if (!this.store.writable) return;
		await this.store.reload();
		this.resolve();
	}

	/**
	 * Everything the panel should badge as detached: what we just measured on the open file, plus
	 * what the log remembers about every other file.
	 *
	 * The live answer WINS for the open file. A recorded status is only ever the last thing some
	 * Texpile saw; for the file in front of the reader we have the text itself, so the recording is
	 * the weaker evidence and must not survive next to it.
	 */
	private applyOrphans(): void {
		const merged = new Set(this.activeLost);
		for (const t of this.store.threads) {
			if (t.file === this.file) continue; // measured above, not remembered
			if (t.detached) merged.add(t.id);
		}
		this.orphaned = merged;
		// nothing is "not in this view" while the view is source; see setVisualMode
		const hidden = new Set<string>();
		if (this.visual) {
			for (const id of this.activeHidden) hidden.add(id);
			for (const t of this.store.threads) {
				if (t.file === this.file) continue; // measured above, not remembered
				if (t.hidden) hidden.add(t.id);
			}
		}
		this.notVisible = hidden;
	}

	/**
	 * Which editor the reader is looking at, because "not in this view" is a claim about the view.
	 *
	 * In source mode NOTHING is hidden - the source editor draws every thread it can resolve - so the
	 * badge and its "switch to source mode to see it" note are simply false there, for the open file
	 * and for the remembered ones alike. Gating on the mode is what stops the panel telling a reader
	 * already in source to go to source.
	 *
	 * Leaving visual also drops what this window measured, and deliberately records NOTHING: source
	 * has not discovered those threads became drawable, it has stopped looking, and writing
	 * `hidden: false` would overwrite a true observation with the absence of one.
	 */
	setVisualMode(visual: boolean): void {
		if (this.visual === visual) return;
		this.visual = visual;
		if (!visual) this.activeHidden = new Set();
		this.applyOrphans();
	}

	/** recompute the active file's ranges from the current log and text */
	private resolve(): void {
		if (!this.file) {
			this.ranges = [];
			this.activeLost = new Set();
			this.applyOrphans();
			return;
		}
		const text = this.text;
		const ranges: CommentRange[] = [];
		const lost = new Set<string>();
		// normalized once for the whole file, and only if something actually misses the fast path
		let hay: LooseHaystack | null = null;
		for (const t of this.store.forFile(this.file)) {
			// loose second: an anchor authored in the visual editor is rendered-dialect, and only the
			// normalized search can carry it back onto source with its wraps, escapes and ligatures
			let hit = resolveAnchor(text, t.anchor);
			if (!hit) {
				hay ??= prepareLoose(text);
				hit = resolveAnchorLooseIn(hay, t.anchor);
			}
			if (hit) ranges.push({ id: t.id, from: hit.from, to: hit.to, resolved: t.resolved });
			else lost.add(t.id);
		}
		this.ranges = ranges;
		this.activeLost = lost;
		this.applyOrphans();
		void this.recordDetached(this.file, lost);
		if (this.pendingOpen) {
			const target = this.pendingOpen;
			this.pendingOpen = null;
			this.selected = target;
			this.scrollTo(target);
		}
	}

	/**
	 * Write back what we just measured, for the threads whose recorded status was wrong or missing.
	 *
	 * ONLY the differences. Two reasons, and the second is not optional: appending on every pass
	 * would grow a committed file every time anyone opened a folder, and - because appending
	 * reassigns `store.threads`, which resolve() reads - it would re-enter resolve() and append
	 * again, forever. Writing only deltas makes the second pass find nothing to say and stop.
	 */
	private async recordDetached(file: string, lost: Set<string>): Promise<void> {
		if (!this.store.writable) return;
		const stale = this.store.forFile(file).filter((t) => asFlag(t.detached) !== lost.has(t.id));
		if (stale.length === 0) return;
		const by = await this.author();
		const at = new Date().toISOString();
		await this.commit(...stale.map((t) => placeEvent({ thread: t.id, detached: lost.has(t.id), by, at })));
	}

	/**
	 * The visual editor reporting which threads it could not draw, for the document it just placed.
	 *
	 * Same delta discipline as recordDetached, and the same reason. `file` is passed rather than read
	 * from `this` because the report can land a beat after a file switch.
	 */
	async recordHidden(file: string, lost: Set<string>): Promise<void> {
		this.activeHidden = file === this.file ? lost : new Set();
		this.applyOrphans();
		if (!this.store.writable) return;
		const stale = this.store.forFile(file).filter((t) => asFlag(t.hidden) !== lost.has(t.id));
		if (stale.length === 0) return;
		const by = await this.author();
		const at = new Date().toISOString();
		await this.commit(...stale.map((t) => placeEvent({ thread: t.id, hidden: lost.has(t.id), by, at })));
	}

	/** the reader selected text and asked to comment; the panel takes it from here */
	beginAdd(from: number, to: number): void {
		if (!this.file || to <= from) return;
		this.pending = { from, to, quote: this.text.slice(from, to) };
		this.selected = null;
	}

	/**
	 * The visual editor's version of beginAdd: it hands over a finished anchor because its own
	 * positions mean nothing to anyone else. The anchor is used verbatim at commit - never rebuilt
	 * against `text`, which is the source dialect the selection was not made in.
	 */
	beginAddAnchored(anchor: CommentAnchor | null): void {
		if (!this.file || !anchor) return;
		this.pending = { quote: anchor.quote, anchor };
		this.selected = null;
	}

	cancelAdd(): void {
		this.pending = null;
	}

	/** turn the pending selection into a thread; no-op if there is nothing to write */
	async commitAdd(body: string): Promise<void> {
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		if (p.anchor) await this.addAnchored(p.anchor, body);
		else if (p.from !== undefined && p.to !== undefined) await this.add(p.from, p.to, body);
	}

	/** start a thread on a selection in the open file */
	async add(from: number, to: number, body: string): Promise<void> {
		if (to <= from) return;
		const id = await this.writeOpen(buildAnchor(this.text, from, to), body);
		// straight into the range list rather than a re-anchor: the offsets are already exact, and
		// re-searching for text the user just selected could land on an earlier copy of it
		if (id) {
			this.ranges = [...this.ranges, { id, from, to, resolved: false }];
			this.selected = id;
		}
	}

	/** start a thread from a visual-editor anchor. No range push: these offsets are not source
	 * offsets, and the visual side re-resolves off the thread list changing anyway. */
	async addAnchored(anchor: CommentAnchor, body: string): Promise<void> {
		const id = await this.writeOpen(anchor, body);
		if (id) this.selected = id;
	}

	/** write the open event; returns the new thread's id, or null if there was nothing to write */
	private async writeOpen(anchor: CommentAnchor, body: string): Promise<string | null> {
		const root = this.deps.root();
		if (!root || !this.file || !body.trim()) return null;
		const id = crypto.randomUUID();
		await this.commit(
			openEvent({
				id,
				file: this.file,
				by: await this.author(),
				body: body.trim(),
				anchor,
				at: new Date().toISOString()
			})
		);
		return id;
	}

	async reply(thread: CommentThread, body: string): Promise<void> {
		if (!body.trim()) return;
		await this.commit(
			replyEvent({ id: crypto.randomUUID(), thread: thread.id, by: await this.author(), body: body.trim(), at: new Date().toISOString() })
		);
	}

	async setResolved(thread: CommentThread, resolved: boolean): Promise<void> {
		await this.commit(resolveEvent({ thread: thread.id, by: await this.author(), resolved, at: new Date().toISOString() }));
		this.ranges = this.ranges.map((r) => (r.id === thread.id ? { ...r, resolved } : r));
	}

	/** rewrite one message. Not restricted to your own: the log is a file anyone can edit anyway */
	async editMessage(message: CommentMessage, body: string): Promise<void> {
		if (!body.trim() || body.trim() === message.body) return;
		await this.commit(editEvent({ message: message.id, body: body.trim(), by: await this.author(), at: new Date().toISOString() }));
	}

	/** drop one message; the fold drops the thread with it if that was the last of it */
	async removeMessage(thread: CommentThread, message: CommentMessage): Promise<void> {
		await this.commit(deleteMessageEvent({ message: message.id, by: await this.author(), at: new Date().toISOString() }));
		if (thread.messages.length <= 1) {
			this.ranges = this.ranges.filter((r) => r.id !== thread.id);
			if (this.selected === thread.id) this.selected = null;
		}
	}

	async remove(thread: CommentThread): Promise<void> {
		await this.commit(deleteEvent({ thread: thread.id, by: await this.author(), at: new Date().toISOString() }));
		this.ranges = this.ranges.filter((r) => r.id !== thread.id);
		if (this.selected === thread.id) this.selected = null;
	}

	/** reveal a thread: scroll to it here, or open the file it is on and scroll once it lands */
	open(thread: CommentThread): void {
		this.selected = thread.id;
		if (thread.file === this.file) {
			this.scrollTo(thread.id);
			return;
		}
		const root = this.deps.root();
		if (!root) return;
		this.pendingOpen = thread.id;
		this.deps.openFileAt(`${root}/${thread.file}`, 1);
	}

	/** everything this side originates: state, disk if there is any, then the session */
	private async commit(...events: CommentEvent[]): Promise<void> {
		await this.store.append(...events);
		for (const e of events) this.deps.publish?.(e);
	}

	/**
	 * An event from someone else in the session.
	 *
	 * Never publishes - that is what stops a rebroadcast bouncing forever - and never re-anchors the
	 * whole file. A full reanchor would re-search against `text`, which is only refreshed when a file
	 * opens, so anything typed since would push every OTHER thread onto stale offsets and throw away
	 * the exact mapping CodeMirror has been keeping. Only the range this event is about is touched.
	 */
	async ingest(event: CommentEvent): Promise<void> {
		await this.store.append(event);
		if (event.t === 'open' && event.file === this.file) {
			const hit = resolveAnchor(this.text, event.anchor) ?? resolveAnchorLoose(this.text, event.anchor);
			if (hit) this.ranges = [...this.ranges, { id: event.id, from: hit.from, to: hit.to, resolved: false }];
			else this.orphaned = new Set([...this.orphaned, event.id]);
		} else if (event.t === 'resolve') {
			this.ranges = this.ranges.map((r) => (r.id === event.thread ? { ...r, resolved: event.resolved } : r));
		} else if (event.t === 'delete') {
			this.ranges = this.ranges.filter((r) => r.id !== event.thread);
			if (this.selected === event.thread) this.selected = null;
		}
	}

	/**
	 * A file or directory was renamed/moved in the tree: its threads follow, via a `move` event.
	 *
	 * An event rather than a rewrite of the open lines, because the log is append-only - that is
	 * what lets git merge it - and because undo replays the rename backwards, which then simply
	 * appends the reverse move. Only written when a thread is actually affected, so renaming files
	 * nobody commented on does not grow the log. External renames (vim, git mv) cannot be seen from
	 * here; those threads orphan, which the panel already explains.
	 */
	async fileMoved(fromAbs: string, toAbs: string): Promise<void> {
		const root = this.deps.root();
		if (!root) return;
		const from = relativeTo(root, fromAbs);
		const to = relativeTo(root, toAbs);
		if (from === to) return;
		const affected = this.store.threads.some((t) => t.file === from || t.file.startsWith(from + '/'));
		if (!affected) return;
		await this.commit(moveEvent({ from, to, by: await this.author(), at: new Date().toISOString() }));
	}

	/** a guest's catch-up: the host's whole log, served over the blob channel on join */
	adopt(text: string, absPath: string | null, docText: string): void {
		this.store.adoptLog(text);
		this.reanchor(absPath, docText);
	}

	private scrollTo(id: string): void {
		// The visual editor first, when that is where the reader is: it has already placed this thread
		// on the exact characters it covers, whereas the line jump below has to push a source line back
		// through the block map, which is block-granular - so a comment on the last clause of a long
		// paragraph landed at the top of the paragraph. Falls through when the reader is in source, or
		// when this thread is one the visual view could not draw.
		if (this.deps.revealInVisual?.(id)) return;
		const hit = this.ranges.find((r) => r.id === id);
		// an orphaned thread has nowhere to scroll to; the panel says so rather than jumping to line 1
		if (hit) this.deps.openFileAt(`${this.deps.root()}/${this.file}`, lineOf(this.text, hit.from));
	}

	private author(): Promise<string> {
		return resolveAuthor(this.deps.root(), this.deps.preferredAuthor());
	}
}

/**
 * An unrecorded status read as "fine", which is what makes browsing a project free.
 *
 * The panel only ever asks `if (t.detached)`, so "nobody has looked" and "looked, nothing wrong"
 * produce the same row. Telling them apart on disk would therefore buy nothing and cost a line per
 * thread the first time anyone opens each file - a committed log gaining hundreds of entries that
 * all say nothing is wrong. So only the interesting answer is written: `true` when the text has
 * gone, and `false` only to CORRECT a recorded `true` that is no longer so.
 */
const asFlag = (v: boolean | undefined): boolean => v === true;

/** 1-based line containing `offset` */
function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
	return line;
}
