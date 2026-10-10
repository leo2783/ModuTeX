import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch as watchPath, type FSWatcher } from 'node:fs';
import type { FileEvent } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };

const TREE_ENTRY_LIMIT = 4096;
const TREE_DEPTH_LIMIT = 16;
const MAX_WATCHERS = TREE_ENTRY_LIMIT + 1;
const MAX_PENDING_EVENTS = TREE_ENTRY_LIMIT / 2;
const ROOT_AUDIT_MS = 5000;
const LOST_NOTIFICATION_RECONCILE_MS = 60_000;
const SCAN_DEBOUNCE_MS = 35;
const EVENT_DEBOUNCE_MS = 25;
const RETRY_SCAN = Symbol('retry-watch-scan');

export type FrontendWatchFailure =
	| 'TREE_TOO_DEEP'
	| 'TREE_TOO_LARGE'
	| 'STALE_WORKSPACE'
	| 'LINK_NOT_ALLOWED'
	| 'FILE_OPERATION_FAILED';

export interface FrontendWatchDependencies {
	readonly root: string;
	readonly workspaceId: string;
	readonly assertCurrent: () => void;
	readonly emit: (event: FileEvent) => void;
	readonly onError: (error: FrontendWatchFailure) => void;
}

interface NodeIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface DirectoryIdentity extends NodeIdentity {
	readonly path: string;
}

interface FileSignature extends NodeIdentity {
	readonly size: bigint;
	readonly mode: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

interface DirectoryNode extends DirectoryIdentity {
	readonly relative: string;
	readonly depth: number;
}

interface WatchedDirectory extends DirectoryIdentity {
	readonly watcher: FSWatcher;
}

interface TreeSnapshot {
	readonly directories: Map<string, DirectoryIdentity>;
	readonly files: Map<string, FileSignature>;
}

function normalized(value: string): string {
	const result = path.resolve(value);
	return process.platform === 'win32' ? result.toLowerCase() : result;
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' &&
		!relative.startsWith('..' + path.sep));
}

function sameNode(left: NodeIdentity, right: NodeIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function systemCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === 'string' ? code : null;
}

function missingDuringScan(error: unknown): boolean {
	return systemCode(error) === 'ENOENT' || systemCode(error) === 'ENOTDIR';
}

function watchFailure(error: unknown): FrontendWatchFailure {
	if (error instanceof Error && [
		'TREE_TOO_DEEP', 'TREE_TOO_LARGE', 'STALE_WORKSPACE', 'LINK_NOT_ALLOWED', 'FILE_OPERATION_FAILED'
	].includes(error.message)) return error.message as FrontendWatchFailure;
	if (['ENOSPC', 'EMFILE', 'ENFILE'].includes(systemCode(error) ?? '')) return 'TREE_TOO_LARGE';
	return 'FILE_OPERATION_FAILED';
}

function signature(stat: {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mode: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}): FileSignature {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mode: stat.mode,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs
	};
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
		left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** A per-subscription watcher; fs.watch filenames are never treated as paths. */
export class FrontendWatch {
	private readonly root: string;
	private readonly workspaceId: string;
	private readonly assertOwner: () => void;
	private readonly emit: (event: FileEvent) => void;
	private readonly onError: (error: FrontendWatchFailure) => void;
	private readonly watchers = new Map<string, WatchedDirectory>();
	private readonly pending = new Map<string, FileEvent['kind']>();
	private rootIdentities: readonly DirectoryIdentity[] | null = null;
	private validatePath: ((value: unknown) => string) | null = null;
	private snapshot = new Map<string, FileSignature>();
	private active = false;
	private startedOnce = false;
	private scanning = false;
	private auditing = false;
	private scanAgain = false;
	private retryCount = 0;
	private scanTimer: ReturnType<typeof setTimeout> | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private auditTimer: ReturnType<typeof setInterval> | null = null;
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;

	constructor(dependencies: FrontendWatchDependencies) {
		if (!path.isAbsolute(dependencies.root)) throw new Error('STALE_WORKSPACE');
		this.root = path.resolve(dependencies.root);
		this.workspaceId = dependencies.workspaceId;
		this.assertOwner = dependencies.assertCurrent;
		this.emit = dependencies.emit;
		this.onError = dependencies.onError;
	}

	async start(): Promise<void> {
		if (this.startedOnce) throw new Error('BUSY');
		this.startedOnce = true;
		this.active = true;
		try {
			this.assertLive();
			this.validatePath = (await import('@modutex/frontend-contracts')).relativePath;
			this.assertLive();
			this.rootIdentities = await this.captureRoot();
			this.assertLive();
			this.auditTimer = setInterval(() => { void this.auditOwnedDirectories(); }, ROOT_AUDIT_MS);
			this.reconcileTimer = setInterval(() => {
				// OS notifications are coalesced and normally drive scans. This bounded full
				// reconciliation is only the fallback for notifications lost by the OS.
				this.scheduleScan(0);
			}, LOST_NOTIFICATION_RECONCILE_MS);
			(this.auditTimer as unknown as { unref?: () => void }).unref?.();
			(this.reconcileTimer as unknown as { unref?: () => void }).unref?.();

			this.scanning = true;
			let initial: TreeSnapshot;
			try {
				initial = await this.scanTree();
				this.assertLive();
			} finally {
				this.scanning = false;
			}
			this.reconcileWatchers(initial.directories);
			this.snapshot = initial.files;
			this.retryCount = 0;
			if (this.scanAgain) {
				this.scanAgain = false;
				this.scheduleScan(0);
			}
		} catch (error) {
			this.stop();
			throw new Error(watchFailure(error));
		}
	}

	stop(): void {
		if (!this.active && !this.watchers.size && !this.scanTimer && !this.flushTimer &&
			!this.auditTimer && !this.reconcileTimer) return;
		this.active = false;
		if (this.scanTimer) clearTimeout(this.scanTimer);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		if (this.auditTimer) clearInterval(this.auditTimer);
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.scanTimer = null;
		this.flushTimer = null;
		this.auditTimer = null;
		this.reconcileTimer = null;
		this.scanAgain = false;
		this.pending.clear();
		for (const watched of this.watchers.values()) watched.watcher.close();
		this.watchers.clear();
	}

	private assertLive(): void {
		if (!this.active) throw new Error('STALE_WORKSPACE');
		this.assertOwner();
	}

	/** Recheck ownership on both fulfillment and rejection of every awaited host operation. */
	private async owned<T>(operation: Promise<T>): Promise<T> {
		let value: T;
		try {
			value = await operation;
		} catch (error) {
			this.assertLive();
			throw error;
		}
		this.assertLive();
		return value;
	}

	private async captureRoot(): Promise<readonly DirectoryIdentity[]> {
		if (!path.isAbsolute(this.root)) throw new Error('STALE_WORKSPACE');
		const parsed = path.parse(this.root);
		if (!parsed.root) throw new Error('STALE_WORKSPACE');
		let cursor = parsed.root;
		const identities: DirectoryIdentity[] = [];
		try {
			let stat = await this.owned(fs.lstat(cursor, { bigint: true }));
			if (stat.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
			if (!stat.isDirectory()) throw new Error('STALE_WORKSPACE');
			identities.push({ path: cursor, dev: stat.dev, ino: stat.ino });
			for (const segment of this.root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
				cursor = path.join(cursor, segment);
				stat = await this.owned(fs.lstat(cursor, { bigint: true }));
				if (stat.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
				if (!stat.isDirectory()) throw new Error('STALE_WORKSPACE');
				identities.push({ path: cursor, dev: stat.dev, ino: stat.ino });
			}
			const real = await this.owned(fs.realpath(this.root));
			if (normalized(real) !== normalized(this.root)) throw new Error('LINK_NOT_ALLOWED');
			return identities;
		} catch (error) {
			if (error instanceof Error && [
				'LINK_NOT_ALLOWED', 'STALE_WORKSPACE', 'TREE_TOO_DEEP', 'TREE_TOO_LARGE', 'FILE_OPERATION_FAILED'
			].includes(error.message)) throw error;
			if (missingDuringScan(error)) throw new Error('STALE_WORKSPACE');
			throw error;
		}
	}

	private async verifyRoot(): Promise<DirectoryIdentity> {
		this.assertLive();
		if (!this.rootIdentities?.length) throw new Error('STALE_WORKSPACE');
		let current: DirectoryIdentity | null = null;
		for (const expected of this.rootIdentities) {
			const stat = await this.owned(fs.lstat(expected.path, { bigint: true }));
			if (stat.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
			if (!stat.isDirectory() || !sameNode(stat, expected)) throw new Error('STALE_WORKSPACE');
			current = { path: expected.path, dev: stat.dev, ino: stat.ino };
		}
		const real = await this.owned(fs.realpath(this.root));
		if (normalized(real) !== normalized(this.root)) throw new Error('LINK_NOT_ALLOWED');
		return current!;
	}

	private async inspectDirectory(node: DirectoryNode): Promise<DirectoryIdentity> {
		const stat = await this.owned(fs.lstat(node.path, { bigint: true }));
		if (stat.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
		if (!stat.isDirectory() || !sameNode(stat, node)) throw RETRY_SCAN;
		const real = await this.owned(fs.realpath(node.path));
		if (!contained(this.root, real) || normalized(real) !== normalized(node.path)) {
			throw new Error('LINK_NOT_ALLOWED');
		}
		return { path: node.path, dev: stat.dev, ino: stat.ino };
	}

	private absoluteFor(relative: string): string {
		return relative ? path.join(this.root, ...relative.split('/')) : this.root;
	}

	private async scanTree(): Promise<TreeSnapshot> {
		const root = await this.verifyRoot();
		this.assertLive();
		const directories = new Map<string, DirectoryIdentity>();
		const files = new Map<string, FileSignature>();
		const pending: DirectoryNode[] = [{ ...root, relative: '', depth: 0 }];
		let inspected = 0;

		while (pending.length) {
			this.assertLive();
			const node = pending.pop()!;
			const identity = await this.inspectDirectory(node);
			this.assertLive();
			directories.set(normalized(identity.path), identity);
			this.ensureWatcher(identity);

			const real = await this.owned(fs.realpath(identity.path));
			if (!contained(this.root, real) || normalized(real) !== normalized(identity.path)) {
				throw new Error('LINK_NOT_ALLOWED');
			}
			// A newly acquired resource must enter its finally before checking revocation.
			// owned(opendir()) can throw after fulfillment and lose the directory handle.
			const directory = await fs.opendir(real);
			try {
				this.assertLive();
				try {
					for await (const entry of directory) {
						this.assertLive();
						if (++inspected > TREE_ENTRY_LIMIT) throw new Error('TREE_TOO_LARGE');
						let relative: string;
						try {
							relative = this.validatePath!(node.relative ? `${node.relative}/${entry.name}` : entry.name);
						} catch {
							// Names the public file contract cannot represent are never watched.
							continue;
						}
						const candidate = this.absoluteFor(relative);
						if (!contained(this.root, candidate)) throw new Error('LINK_NOT_ALLOWED');
						const child = await this.owned(fs.lstat(candidate, { bigint: true }));
						if (child.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
						if (!child.isDirectory() && !child.isFile()) continue;
						const childReal = await this.owned(fs.realpath(candidate));
						if (!contained(this.root, childReal) || normalized(childReal) !== normalized(candidate)) {
							throw new Error('LINK_NOT_ALLOWED');
						}
						if (child.isDirectory()) {
							if (entry.name === '.git' || entry.name === 'node_modules') continue;
							const depth = node.depth + 1;
							if (depth > TREE_DEPTH_LIMIT) throw new Error('TREE_TOO_DEEP');
							pending.push({
								path: candidate,
								dev: child.dev,
								ino: child.ino,
								relative,
								depth
							});
						} else if (['.tex', '.pdf'].includes(path.extname(entry.name).toLowerCase())) {
							files.set(relative, signature(child));
						}
					}
				} catch (error) {
					this.assertLive();
					throw error;
				}
			} finally {
				try { await directory.close(); }
				catch (error) {
					if (systemCode(error) !== 'ERR_DIR_CLOSED') throw error;
				}
				this.assertLive();
			}

			const after = await this.owned(fs.lstat(identity.path, { bigint: true }));
			if (after.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
			if (!after.isDirectory() || !sameNode(after, identity)) throw RETRY_SCAN;
		}

		await this.verifyRoot();
		this.assertLive();
		return { directories, files };
	}

	private ensureWatcher(identity: DirectoryIdentity): void {
		const key = normalized(identity.path);
		const existing = this.watchers.get(key);
		if (existing && sameNode(existing, identity)) return;
		if (existing) this.removeWatcher(key, existing);
		if (this.watchers.size >= MAX_WATCHERS) throw new Error('TREE_TOO_LARGE');

		let watched!: WatchedDirectory;
		try {
			const watcher = watchPath(identity.path, { persistent: false }, () => {
				if (this.active && this.watchers.get(key) === watched) this.scheduleScan();
			});
			watched = { ...identity, watcher };
			this.watchers.set(key, watched);
			watcher.on('error', (error) => this.watcherError(key, watched, error));
		} catch (error) {
			if (['ENOSPC', 'EMFILE', 'ENFILE'].includes(systemCode(error) ?? '')) throw new Error('TREE_TOO_LARGE');
			throw error;
		}
	}

	private watcherError(key: string, watched: WatchedDirectory, error: Error): void {
		if (!this.active || this.watchers.get(key) !== watched) return;
		const code = systemCode(error);
		if (code === 'ENOSPC' || code === 'EMFILE' || code === 'ENFILE') {
			this.fail('TREE_TOO_LARGE');
			return;
		}
		this.removeWatcher(key, watched);
		if (code === 'ENOENT' || code === 'ENOTDIR') this.scheduleScan(0);
		else this.fail('FILE_OPERATION_FAILED');
	}

	private removeWatcher(key: string, watched: WatchedDirectory): void {
		if (this.watchers.get(key) !== watched) return;
		this.watchers.delete(key);
		watched.watcher.close();
	}

	private reconcileWatchers(directories: Map<string, DirectoryIdentity>): void {
		for (const [key, watched] of this.watchers) {
			const current = directories.get(key);
			if (!current || !sameNode(watched, current)) this.removeWatcher(key, watched);
		}
	}

	private scheduleScan(delay = SCAN_DEBOUNCE_MS): void {
		if (!this.active) return;
		if (this.scanning) {
			this.scanAgain = true;
			return;
		}
		if (this.scanTimer) return;
		this.scanTimer = setTimeout(() => {
			this.scanTimer = null;
			void this.rescan();
		}, delay);
	}

	private async rescan(): Promise<void> {
		if (!this.active) return;
		if (this.scanning) {
			this.scanAgain = true;
			return;
		}
		this.scanning = true;
		try {
			const tree = await this.scanTree();
			this.assertLive();
			this.reconcileWatchers(tree.directories);
			const previous = this.snapshot;
			this.snapshot = tree.files;
			this.retryCount = 0;
			const paths = [...new Set([...previous.keys(), ...tree.files.keys()])].sort();
			for (const filePath of paths) {
				const before = previous.get(filePath);
				const after = tree.files.get(filePath);
				if (!before && after) this.queueEvent(filePath, 'changed');
				else if (before && !after) this.queueEvent(filePath, 'removed');
				else if (before && after && !sameSignature(before, after)) this.queueEvent(filePath, 'changed');
				if (!this.active) return;
			}
		} catch (error) {
			if (!this.active) return;
			if (error === RETRY_SCAN || missingDuringScan(error)) {
				if (++this.retryCount > 4) this.fail('FILE_OPERATION_FAILED');
				else this.scanAgain = true;
			} else {
				this.fail(watchFailure(error));
			}
		} finally {
			this.scanning = false;
			if (this.active && this.scanAgain) {
				this.scanAgain = false;
				this.scheduleScan();
			}
		}
	}

	private queueEvent(filePath: string, kind: FileEvent['kind']): void {
		if (!this.active) return;
		if (!this.pending.has(filePath) && this.pending.size >= MAX_PENDING_EVENTS) {
			// Never silently discard an event on overflow. Terminate and report the existing
			// recoverable tree-size contract error to this subscription's owner.
			this.fail('TREE_TOO_LARGE');
			return;
		}
		this.pending.set(filePath, kind);
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null;
				void this.flushPending();
			}, EVENT_DEBOUNCE_MS);
		}
	}

	private async flushPending(): Promise<void> {
		if (!this.active || !this.pending.size) return;
		try {
			await this.verifyRoot();
			this.assertLive();
		} catch (error) {
			this.fail(watchFailure(error));
			return;
		}
		if (!this.active) return;
		const events = [...this.pending.entries()].sort(([left], [right]) => left.localeCompare(right));
		this.pending.clear();
		for (const [filePath, kind] of events) {
			if (!this.active) return;
			try {
				this.assertLive();
				this.emit(Object.freeze({ workspaceId: this.workspaceId, path: filePath, kind }));
			} catch (error) {
				this.fail(watchFailure(error));
				return;
			}
		}
	}

	private async auditOwnedDirectories(): Promise<void> {
		if (!this.active || this.auditing) return;
		this.auditing = true;
		try {
			await this.verifyRoot();
			for (const [key, watched] of [...this.watchers]) {
				this.assertLive();
				if (this.watchers.get(key) !== watched) continue;
				const stat = await this.owned(fs.lstat(watched.path, { bigint: true }));
				if (stat.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
				if (!stat.isDirectory()) {
					this.scheduleScan(0);
					return;
				}
				if (!sameNode(stat, watched)) {
					this.scheduleScan(0);
					return;
				}
				const real = await this.owned(fs.realpath(watched.path));
				if (!contained(this.root, real) || normalized(real) !== normalized(watched.path)) {
					throw new Error('LINK_NOT_ALLOWED');
				}
			}
		} catch (error) {
			if (!this.active) return;
			if (missingDuringScan(error)) this.scheduleScan(0);
			else this.fail(watchFailure(error));
		} finally {
			this.auditing = false;
		}
	}

	private fail(error: FrontendWatchFailure): void {
		if (!this.active) return;
		this.stop();
		try { this.onError(error); }
		catch { /* failure delivery cannot retain or revive native watchers */ }
	}
}
