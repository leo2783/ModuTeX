// Original recent-document service within the existing AGPL host boundary.
// Absolute paths remain main-only; renderer commands use host-issued IDs.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecentDocument } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };

type Kind = 'file' | 'folder';
interface StoredRecent { id: string; selected: string; kind: Kind; openedAt: number }
const MAXIMUM = 20;
const MAX_BYTES = 256 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function publicEntry(entry: StoredRecent): RecentDocument {
	return Object.freeze({ id: entry.id, label: path.basename(entry.kind === 'file' ? path.dirname(entry.selected) : entry.selected) || '工作區',
		entryPath: entry.kind === 'file' ? path.basename(entry.selected) : null, openedAt: entry.openedAt });
}
function key(selected: string): string { return process.platform === 'win32' ? selected.toLowerCase() : selected; }

/** One process-wide instance shared by all windows. No renderer-supplied path. */
export class FrontendRecent {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly file: string) { if (!path.isAbsolute(file)) throw new Error('BAD_RECENT_STORE'); }
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.queue.then(operation);
		this.queue = pending.catch(() => {});
		return pending;
	}
	private async read(): Promise<StoredRecent[]> {
		let handle: fs.FileHandle | undefined;
		try {
			const stat = await fs.lstat(this.file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('RECENT_CORRUPT');
			handle = await fs.open(this.file, 'r');
			const opened = await handle.stat();
			if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_BYTES) throw new Error('RECENT_CORRUPT');
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_BYTES) throw new Error('RECENT_CORRUPT');
			const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
			if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAXIMUM) throw new Error('RECENT_CORRUPT');
			const ids = new Set<string>(), paths = new Set<string>();
			for (const entry of value.entries) {
				if (!entry || typeof entry.id !== 'string' || !uuid.test(entry.id) || typeof entry.selected !== 'string' ||
					entry.selected.length > 4096 || entry.selected.includes('\0') || !path.isAbsolute(entry.selected) ||
					(entry.kind !== 'file' && entry.kind !== 'folder') || !Number.isSafeInteger(entry.openedAt) || entry.openedAt < 0 ||
					(entry.kind === 'file' && path.extname(entry.selected).toLowerCase() !== '.tex') ||
					ids.has(entry.id) || paths.has(key(entry.selected))) throw new Error('RECENT_CORRUPT');
				ids.add(entry.id); paths.add(key(entry.selected));
			}
			return value.entries;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw new Error('RECENT_CORRUPT', { cause: error });
		} finally { await handle?.close(); }
	}
	private async write(entries: StoredRecent[]): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		const temporary = this.file + '.' + randomUUID() + '.tmp';
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(temporary, 'wx', 0o600);
			await handle.writeFile(JSON.stringify({ version: 1, entries }) + '\n', 'utf8');
			await handle.sync(); await handle.close(); handle = undefined;
			// Windows readers/scanners may briefly deny replacement. Preserve the
			// old file and retry only sharing-related errors, with a bounded delay.
			for (let attempt = 0; ; ++attempt) {
				try { await fs.rename(temporary, this.file); break; }
				catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt >= 9) throw error;
					await delay(10 * (attempt + 1));
				}
			}
		} finally { await handle?.close(); await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
	}
	list(): Promise<readonly RecentDocument[]> { return this.serial(async () => (await this.read()).map(publicEntry)); }
	remember(selected: string, kind: Kind): Promise<RecentDocument> {
		return this.serial(async () => {
			if (typeof selected !== 'string' || selected.length > 4096 || selected.includes('\0') || !path.isAbsolute(selected) ||
				(kind !== 'file' && kind !== 'folder')) throw new Error('BAD_SELECTION');
			const real = await fs.realpath(selected), stat = await fs.stat(real);
			if (kind === 'file' ? !stat.isFile() || path.extname(real).toLowerCase() !== '.tex' : !stat.isDirectory()) throw new Error('BAD_SELECTION');
			const entries = await this.read(), existing = entries.find((entry) => key(entry.selected) === key(real));
			const entry = { id: existing?.id ?? randomUUID(), selected: real, kind, openedAt: Date.now() };
			await this.write([entry, ...entries.filter((other) => key(other.selected) !== key(real))].slice(0, MAXIMUM));
			return publicEntry(entry);
		});
	}
	resolve(id: string): Promise<{ readonly selected: string; readonly kind: Kind }> {
		return this.serial(async () => {
			if (typeof id !== 'string' || !uuid.test(id)) throw new Error('RECENT_NOT_FOUND');
			const entry = (await this.read()).find((candidate) => candidate.id === id);
			if (!entry) throw new Error('RECENT_NOT_FOUND');
			return { selected: entry.selected, kind: entry.kind };
		});
	}
	remove(id: string): Promise<void> {
		return this.serial(async () => {
			if (typeof id !== 'string' || !uuid.test(id)) throw new Error('RECENT_NOT_FOUND');
			const entries = await this.read();
			if (!entries.some((entry) => entry.id === id)) throw new Error('RECENT_NOT_FOUND');
			await this.write(entries.filter((entry) => entry.id !== id));
		});
	}
}
