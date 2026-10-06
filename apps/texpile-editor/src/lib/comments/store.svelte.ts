// The workspace's comment log: read it, fold it, append to it.
//
// Lives at .texpile/comments.jsonl. That path is invisible in the file tree - fs-service's skipDir
// drops every dot-directory from the walk - so it needs no ignore-list entry. It is NOT invisible
// to the watcher: fs-watch exempts .texpile from the same rule precisely so a log arriving by
// `git pull` reaches reload() while the folder is open.
//
// This is the first thing Texpile writes into a user's project. Everything else kept per folder -
// main file, compile command - is localStorage keyed by root path, because it is personal. Comments
// are the opposite: they exist to be read by someone else, so they belong in the project and in the
// commit.
import { readTextFile, writeTextFile } from '$lib/workspace/fileSystem';
import { ensureTexpileIgnore, texpilePath } from '$lib/workspace/texpileDir';
import { foldLog, parseLog, serializeLog, type CommentEvent, type CommentThread } from './log';

export class CommentStore {
	/** every thread in the workspace, in the order they were opened */
	threads = $state<CommentThread[]>([]);
	/** the workspace this log belongs to; null before the first load */
	root = $state<string | null>(null);
	loading = $state(false);

	/** the log verbatim, so appending never has to re-serialize anything it did not parse */
	private events: CommentEvent[] = [];

	/** null for a guest, whose root is a sentinel rather than a path - see texpilePath */
	private path(root: string): string | null {
		return texpilePath(root, 'comments.jsonl');
	}

	/** point the store at a workspace and read its log; a missing file is an empty log, not an error */
	async load(root: string | null): Promise<void> {
		this.root = root;
		this.events = [];
		this.threads = [];
		const path = root ? this.path(root) : null;
		if (!path) return;
		this.loading = true;
		try {
			const text = await readTextFile(path);
			this.events = parseLog(text);
			this.threads = foldLog(this.events);
		} catch {
			// no log yet is the normal state for a project nobody has commented on
		} finally {
			this.loading = false;
		}
	}

	/** re-read from disk, for a pull or another window; CommentsController.refresh drives it */
	reload(): Promise<void> {
		return this.load(this.root);
	}

	/**
	 * Append events, and write the log back if this workspace has one.
	 *
	 * The state always advances; only the write is conditional. That is what lets a guest hold the
	 * session's comments in memory with no disk at all - their root is a sentinel, not a path, and
	 * the file lives on the host.
	 *
	 * Read-modify-write rather than a true append, because the fs bridge only offers whole-file
	 * writes. Two Texpile windows on one folder could therefore lose an event; a real O_APPEND
	 * needs its own IPC and is the fix if that ever matters. Concurrent authors on different
	 * machines are already handled - that is what the log format is for.
	 */
	async append(...events: CommentEvent[]): Promise<void> {
		if (events.length === 0) return;
		this.events = [...this.events, ...events];
		this.threads = foldLog(this.events);
		const path = this.root ? this.path(this.root) : null;
		if (!path) return;
		await this.ensureIgnore();
		await writeTextFile(path, serializeLog(this.events));
	}

	/** seeded if absent, never over one the user has edited; shared with the config writer */
	private async ensureIgnore(): Promise<void> {
		if (this.root) await ensureTexpileIgnore(this.root);
	}

	/** replace everything from a log served over the wire; a guest's catch-up on join */
	adoptLog(text: string): void {
		this.events = parseLog(text);
		this.threads = foldLog(this.events);
	}

	/** the log as it would be written, for the host to serve to a joining guest */
	serialize(): string {
		return serializeLog(this.events);
	}

	/** false when this workspace has nowhere to keep a log - a guest session, or no folder open */
	get writable(): boolean {
		return this.root !== null && this.path(this.root) !== null;
	}

	/** threads on one file, workspace-relative path */
	forFile(file: string): CommentThread[] {
		return this.threads.filter((t) => t.file === file);
	}
}

/** workspace-relative, posix separators: the log travels between machines and OSes */
export function relativeTo(root: string, path: string): string {
	const r = root.replace(/[\\/]+$/, '').replace(/\\/g, '/');
	const p = path.replace(/\\/g, '/');
	return p.startsWith(r + '/') ? p.slice(r.length + 1) : p;
}
