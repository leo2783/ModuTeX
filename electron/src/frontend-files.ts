// Original integration module within the existing AGPL Electron host boundary.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { FileEntry, FileRef, ReadReceipt, WorkspaceInfo, WriteReceipt } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };

export const SOURCE_BYTES_LIMIT = 5 * 1024 * 1024;
export const PDF_BYTES_LIMIT = 32 * 1024 * 1024;
const TREE_ENTRY_LIMIT = 4096;
const TREE_DEPTH_LIMIT = 16;
// Process-local destination ownership shared by all frontend windows, not a disk CAS.
const fileWrites = new Map<string, string>();
const compilationRoots = new Set<string>();
const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

interface DirectoryCleanupAuthority {
	readonly root: string;
	readonly rootDevice: bigint;
	readonly rootInode: bigint;
	readonly parent: string;
	readonly parentDevice: bigint;
	readonly parentInode: bigint;
}

/** Path identity kept independently of the workspace's live publication authority. */
interface TemporaryCleanupAuthority extends DirectoryCleanupAuthority {
	readonly path: string;
	readonly fileDevice: bigint;
	readonly fileInode: bigint;
}

function sameNode(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function matchesNode(stat: { dev: bigint; ino: bigint }, device: bigint, inode: bigint): boolean {
	return stat.dev === device && stat.ino === inode;
}

/** Verify every path component, including the held root and temporary parent. */
async function directoryStillMatches(authority: DirectoryCleanupAuthority): Promise<boolean> {
	if (!path.isAbsolute(authority.root) || !path.isAbsolute(authority.parent) ||
		!contained(authority.root, authority.parent)) return false;
	try {
		const parsed = path.parse(authority.root);
		if (!parsed.root) return false;
		let cursor = parsed.root;
		let stat = await fs.lstat(cursor, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
		for (const segment of authority.root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
			cursor = path.join(cursor, segment);
			stat = await fs.lstat(cursor, { bigint: true });
			if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
		}
		if (!matchesNode(stat, authority.rootDevice, authority.rootInode)) return false;

		const relative = path.relative(authority.root, authority.parent);
		if (relative && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))) return false;
		let parentStat = stat;
		cursor = authority.root;
		if (relative) {
			for (const segment of relative.split(path.sep)) {
				if (!segment || segment === '.' || segment === '..') return false;
				cursor = path.join(cursor, segment);
				parentStat = await fs.lstat(cursor, { bigint: true });
				if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return false;
			}
		}
		if (!matchesNode(parentStat, authority.parentDevice, authority.parentInode)) return false;

		const rootEntry = await fs.lstat(authority.root, { bigint: true });
		return !rootEntry.isSymbolicLink() && rootEntry.isDirectory() &&
			matchesNode(rootEntry, authority.rootDevice, authority.rootInode);
	} catch {
		return false;
	}
}

async function temporaryStillMatches(authority: TemporaryCleanupAuthority): Promise<boolean> {
	const name = path.basename(authority.path);
	if (!path.isAbsolute(authority.path) || path.dirname(authority.path) !== authority.parent ||
		!name.startsWith('.modutex-save-') || !name.endsWith('.tmp')) return false;
	try {
		// Recheck both the directory chain and the entry so observed replacements are retained.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (!(await directoryStillMatches(authority))) return false;
			const stat = await fs.lstat(authority.path, { bigint: true });
			if (stat.isSymbolicLink() || !stat.isFile() ||
				!matchesNode(stat, authority.fileDevice, authority.fileInode)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function unlinkTemporaryIfOwned(authority: TemporaryCleanupAuthority): Promise<void> {
	try {
		if (!(await temporaryStillMatches(authority))) return;
		await fs.unlink(authority.path);
	} catch {
		// Retain an orphan when its identity or location cannot be verified.
	}
}

/** Owned by one main-frame session; callers never supply absolute filesystem paths. */
export class FrontendFiles {
	private current: { root: string; device: bigint; inode: bigint; info: WorkspaceInfo } | null = null;
	private writing = false;
	private opening: object | null = null;
	private authority: object = {};

	async open(selected: string, kind: 'file' | 'folder'): Promise<WorkspaceInfo> {
		if (!path.isAbsolute(selected)) throw new Error('BAD_SELECTION');
		const opening = {};
		this.authority = {};
		this.opening = opening;
		try {
		const real = await fs.realpath(selected);
		const stat = await fs.stat(real);
		if (kind === 'file' ? !stat.isFile() || path.extname(real).toLowerCase() !== '.tex' : !stat.isDirectory()) {
			throw new Error('BAD_SELECTION');
		}
		const root = kind === 'file' ? path.dirname(real) : real;
		const entryPath = kind === 'file' ? path.basename(real) : null;
		if (entryPath) (await import('@modutex/frontend-contracts')).relativePath(entryPath);
		const info = Object.freeze({ id: randomUUID(), label: path.basename(root) || root, entryPath });
		const rootStat = await fs.stat(root, { bigint: true });
		if (!rootStat.isDirectory()) throw new Error('BAD_SELECTION');
		// Close or a newer open revokes this operation before it publishes authority.
		if (this.opening !== opening) throw new Error('STALE_WORKSPACE');
		this.opening = null;
		this.current = { root, device: rootStat.dev, inode: rootStat.ino, info };
		return info;
		} finally {
			// A failed open must not leave BUSY forever or revoke a newer pending open.
			if (this.opening === opening) this.opening = null;
		}
	}

	close(id?: string): void {
		if (id !== undefined) this.session(id);
		this.authority = {};
		this.opening = null;
		this.current = null;
	}

	/** Main-only authority; never exported through preload. */
	compileOwner() {
		const selected = this.current;
		if (!selected) throw new Error('STALE_WORKSPACE');
		return { root: selected.root, assertCurrent: () => this.assertCurrent(selected) };
	}

	/** Includes the empty workspace and pending dialog/open lifetime. Main-only. */
	saveAsOwner(id: string | null): () => void {
		if (this.opening) throw new Error('BUSY');
		const selected = this.current, authority = this.authority;
		if (id === null ? selected !== null : selected?.info.id !== id) throw new Error('STALE_WORKSPACE');
		return () => {
			if (this.authority !== authority || this.current !== selected) throw new Error('STALE_WORKSPACE');
		};
	}

	/** Main-only exclusion from initial revision read through engine cleanup and PDF capture. */
	reserveCompilation(id: string): () => void {
		const session = this.session(id);
		const root = normalized(session.root);
		if ([...compilationRoots].some((other) => contained(root, other) || contained(other, root)) ||
			[...fileWrites.values()].some((destination) => contained(root, destination))) throw new Error('BUSY');
		compilationRoots.add(root);
		let released = false;
		return () => { if (!released) { released = true; compilationRoots.delete(root); } };
	}

	private session(id: unknown) {
		if (typeof id !== 'string' || !this.current || this.current.info.id !== id) throw new Error('STALE_WORKSPACE');
		return this.current;
	}

	private assertCurrent(session: NonNullable<FrontendFiles['current']>): void {
		if (this.current !== session) throw new Error('STALE_WORKSPACE');
	}

	private async assertRoot(session: NonNullable<FrontendFiles['current']>): Promise<void> {
		const stat = await fs.lstat(session.root, { bigint: true });
		if (stat.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
		if (!stat.isDirectory() || stat.dev !== session.device || stat.ino !== session.inode) throw new Error('STALE_WORKSPACE');
		this.assertCurrent(session);
	}

	private async resolve(session: NonNullable<FrontendFiles['current']>, relative: unknown): Promise<string> {
		await this.assertRoot(session);
		const safe = (await import('@modutex/frontend-contracts')).relativePath(relative);
		const candidate = path.join(session.root, ...safe.split('/'));
		if (!contained(session.root, candidate)) throw new Error('OUTSIDE_WORKSPACE');
		let cursor = session.root;
		if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
		for (const segment of safe.split('/')) {
			cursor = path.join(cursor, segment);
			if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
		}
		const real = await fs.realpath(candidate);
		if (!contained(session.root, real)) throw new Error('OUTSIDE_WORKSPACE');
		this.assertCurrent(session);
		return real;
	}

	private async destination(session: NonNullable<FrontendFiles['current']>, relative: string): Promise<string> {
		const safe = (await import('@modutex/frontend-contracts')).relativePath(relative);
		const parts = safe.split('/'); const name = parts.pop()!;
		const parent = parts.length ? await this.resolve(session, parts.join('/')) : (await this.assertRoot(session), session.root);
		if (!(await fs.stat(parent)).isDirectory()) throw new Error('BAD_FILE');
		return path.join(parent, name);
	}

	/** Only main's native dialog supplies selected. Publish new authority after a real save. */
	async saveAs(selected: string, value: unknown, assertCaller: () => void = () => {}) {
		const authority = this.authority;
		const request = (await import('@modutex/frontend-contracts')).parseSaveAsRequest(value, SOURCE_BYTES_LIMIT);
		if (this.authority !== authority) throw new Error('STALE_WORKSPACE');
		const assertOwner = this.saveAsOwner(request.workspaceId);
		const assertActive = () => { assertCaller(); assertOwner(); };
		assertActive();
		if (!path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== '.tex') throw new Error('BAD_SELECTION');
		if (this.writing) throw new Error('BUSY');
		this.writing = true;
		const target = new FrontendFiles();
		try {
			const parent = path.dirname(selected);
			// Refuse linked path components, including directory junctions selected in the dialog.
			let cursor = path.parse(parent).root;
			for (const part of parent.slice(cursor.length).split(path.sep).filter(Boolean)) {
				cursor = path.join(cursor, part);
				if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
			}
			const info = await target.open(parent, 'folder');
			const name = (await import('@modutex/frontend-contracts')).relativePath(path.basename(selected));
			let expectedRevision: string | null = null;
			try { expectedRevision = (await target.read({ workspaceId: info.id, path: name })).revision; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			assertActive();
			const write = await target.writeGuarded({ ...request, workspaceId: info.id, path: name, expectedRevision }, assertActive);
			assertActive();
			const workspace = Object.freeze({ ...info, entryPath: name });
			this.authority = {};
			this.current = { ...target.current!, info: workspace };
			return { workspace, write };
		} finally { target.close(); this.writing = false; }
	}

	async read(value: unknown): Promise<ReadReceipt> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_FILE');
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(value).length !== 2 || !('value' in (descriptors.workspaceId ?? {})) || !('value' in (descriptors.path ?? {}))) {
			throw new Error('BAD_FILE');
		}
		const ref = value as FileRef;
		const session = this.session(ref.workspaceId);
		const real = await this.resolve(session, ref.path);
		const extension = path.extname(real).toLowerCase();
		if (extension !== '.tex' && extension !== '.pdf') throw new Error('FILE_TYPE');
		const limit = extension === '.pdf' ? PDF_BYTES_LIMIT : SOURCE_BYTES_LIMIT;
		const handle = await fs.open(real, 'r');
		try {
			const before = await handle.stat({ bigint: true });
			if (!before.isFile() || before.size > BigInt(limit)) throw new Error('FILE_TOO_LARGE');
			const data = new Uint8Array(Number(before.size));
			let offset = 0;
			while (offset < data.byteLength) {
				const result = await handle.read(data, offset, data.byteLength - offset, offset);
				if (result.bytesRead === 0) throw new Error('FILE_CHANGED');
				offset += result.bytesRead;
			}
			const after = await handle.stat({ bigint: true });
			const currentPath = await this.resolve(session, ref.path);
			const disk = await fs.stat(currentPath, { bigint: true });
			if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
				disk.dev !== after.dev || disk.ino !== after.ino || disk.size !== after.size || disk.mtimeNs !== after.mtimeNs) {
				throw new Error('FILE_CHANGED');
			}
			this.assertCurrent(session);
			return { workspaceId: session.info.id, path: ref.path, bytes: data,
				revision: 'sha256:' + createHash('sha256').update(data).digest('hex') };
		} finally {
			await handle.close();
		}
	}

	/** Atomic replacement after two revision checks. Not an OS-level compare-and-swap. */
	async write(value: unknown): Promise<WriteReceipt> {
		return this.writeGuarded(value, () => {});
	}

	private async writeGuarded(value: unknown, assertOwner: () => void): Promise<WriteReceipt> {
		const request = (await import('@modutex/frontend-contracts')).parseWriteRequest(value, SOURCE_BYTES_LIMIT);
		const session = this.session(request.workspaceId);
		if (path.extname(request.path).toLowerCase() !== '.tex') throw new Error('FILE_TYPE');
		if (this.writing) throw new Error('BUSY');
		this.writing = true;
		let temporary: TemporaryCleanupAuthority | null = null;
		let writeKey: string | null = null;
		try {
			const ref = { workspaceId: request.workspaceId, path: request.path };
			const destination = request.expectedRevision === null ? await this.destination(session, request.path) : await this.resolve(session, request.path);
			const parentPath = path.dirname(destination);
			const parent = await fs.lstat(parentPath, { bigint: true });
			if (parent.isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
			if (!parent.isDirectory()) throw new Error('BAD_FILE');
			const directoryAuthority: DirectoryCleanupAuthority = {
				root: session.root, rootDevice: session.device, rootInode: session.inode,
				parent: parentPath, parentDevice: parent.dev, parentInode: parent.ino
			};
			if (!(await directoryStillMatches(directoryAuthority))) throw new Error('STALE_WORKSPACE');
			const name = process.platform === 'win32' ? path.basename(destination).toLowerCase() : path.basename(destination);
			const key = `${parent.dev}:${parent.ino}:${name}`;
			this.assertCurrent(session);
			if (fileWrites.has(key) || [...compilationRoots].some((root) => contained(root, normalized(destination)))) throw new Error('BUSY');
			fileWrites.set(key, normalized(destination)); writeKey = key;
			const original = request.expectedRevision === null ? null : await this.read(ref);
			if (original && original.revision !== request.expectedRevision) throw new Error('FILE_CONFLICT');
			const identity = original ? await fs.stat(destination, { bigint: true }) : null;
			const temporaryPath = path.join(parentPath, '.modutex-save-' + randomUUID() + '.tmp');
			const handle = await fs.open(temporaryPath, 'wx', identity ? Number(identity.mode) & 0o777 : 0o600);
			try {
				const opened = await handle.stat({ bigint: true });
				const named = await fs.lstat(temporaryPath, { bigint: true });
				const ownership: TemporaryCleanupAuthority = {
					...directoryAuthority, path: temporaryPath, fileDevice: opened.dev, fileInode: opened.ino
				};
				if (!opened.isFile() || named.isSymbolicLink() || !named.isFile() || !sameNode(opened, named) ||
					!(await temporaryStillMatches(ownership))) throw new Error('TEMP_CHANGED');
				temporary = ownership;
				await handle.writeFile(request.bytes);
				await handle.sync();
			}
			finally { await handle.close(); }
			if (identity) {
				const latest = await this.read(ref);
				const current = await fs.stat(await this.resolve(session, request.path), { bigint: true });
				if (latest.revision !== request.expectedRevision || current.dev !== identity.dev || current.ino !== identity.ino ||
					current.mtimeNs !== identity.mtimeNs || current.ctimeNs !== identity.ctimeNs) throw new Error('FILE_CONFLICT');
				const temp = temporary;
				if (!temp || !(await temporaryStillMatches(temp))) throw new Error('TEMP_CHANGED');
				this.assertCurrent(session);
				assertOwner();
				await fs.rename(temp.path, destination); temporary = null;
			} else {
				await this.assertRoot(session);
				const currentDestination = await this.destination(session, request.path);
				const currentParent = await fs.lstat(path.dirname(currentDestination), { bigint: true });
				if (currentParent.isSymbolicLink() || !currentParent.isDirectory() ||
					parent.dev !== currentParent.dev || parent.ino !== currentParent.ino) throw new Error('STALE_WORKSPACE');
				const temp = temporary;
				if (!temp || !(await temporaryStillMatches(temp))) throw new Error('TEMP_CHANGED');
				this.assertCurrent(session);
				assertOwner();
				// Link publishes complete bytes exclusively; it cannot replace an existing file/symlink.
				try { await fs.link(temp.path, destination); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('FILE_CONFLICT'); throw error; }
			}
			return { workspaceId: request.workspaceId, path: request.path, documentId: request.documentId,
				documentVersion: request.documentVersion, revision: 'sha256:' + createHash('sha256').update(request.bytes).digest('hex') };
		} finally {
			try {
				// Cleanup authority is based on held path identities, not the revoked live session.
				if (temporary) await unlinkTemporaryIfOwned(temporary);
			} finally {
				this.writing = false;
				if (writeKey !== null) fileWrites.delete(writeKey);
			}
		}
	}

	async list(id: unknown): Promise<readonly FileEntry[]> {
		const session = this.session(id);
		await this.assertRoot(session);
		const entries: FileEntry[] = [];
		let inspected = 0;
		const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
			if (depth > TREE_DEPTH_LIMIT) throw new Error('TREE_TOO_DEEP');
			const real = await fs.realpath(directory);
			if (!contained(session.root, real) || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('LINK_NOT_ALLOWED');
			const dir = await fs.opendir(real);
			for await (const entry of dir) {
				this.assertCurrent(session);
				if (++inspected > TREE_ENTRY_LIMIT) throw new Error('TREE_TOO_LARGE');
				if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
				const relative = prefix ? prefix + '/' + entry.name : entry.name;
				const child = await this.resolve(session, relative);
				if (entry.isDirectory()) {
					entries.push({ path: relative, kind: 'directory' });
					await walk(child, relative, depth + 1);
				} else if (entry.isFile() && ['.tex', '.pdf'].includes(path.extname(entry.name).toLowerCase())) {
					entries.push({ path: relative, kind: 'file' });
				}
			}
		};
		await walk(session.root, '', 0);
		await this.assertRoot(session);
		this.assertCurrent(session);
		return entries.sort((a, b) => a.path.localeCompare(b.path));
	}
}
