import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { assertDiagramRelativePath, DIAGRAM_OUTPUT_LIMIT } from './diagram-security';
import { diagramDirectory, verifyDirectoryUnchanged, diagramBundleStatus, readDiagram } from './diagram-service';

type Receipt = { v: 1; sourceSha256: string; svgSha256: string; pdfSha256: string };
/** Internal outcome only; IPC exposes no receipt/raw cause on a failed union. */
export class DiagramPublicationCommittedError extends Error {
	readonly committed = true;
	constructor(
		readonly receipt: Receipt,
		cause: unknown
	) {
		super('WRITE_FAILED', { cause });
		this.name = 'DiagramPublicationCommittedError';
	}
}
/** Cancellation was observed, but rollback marker I/O failed: no old-pair guarantee. */
export class DiagramPublicationIndeterminateError extends Error {
	readonly indeterminate = true;
	constructor(
		readonly receipt: Receipt,
		cause: unknown
	) {
		super('WRITE_FAILED', { cause });
		this.name = 'DiagramPublicationIndeterminateError';
	}
}
export interface DiagramPublicationLifecycle {
	commitGuard?(): void;
	onCommitted?(): void;
	/** Narrow native/test FS seam; production defaults to the real unlink. */
	unlinkFile?: typeof unlink;
	rollbackMarkerWrite?: (file: string, content: Uint8Array) => Promise<void>;
	rollbackMarkerRename?: typeof rename;
}
type Journal = { v: 1; id: string; phase: 'prepared' | 'committed'; old: (string | null)[] };
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const locks = new Map<string, Promise<void>>();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function withDiagramPublicationLock<T>(root: string, source: string, run: () => Promise<T>): Promise<T> {
	const context = await diagramDirectory(root, true);
	const safe = assertDiagramRelativePath(source, ['mmd', 'drawio']);
	const key = path.join(context.directory, path.basename(safe).replace(/\.(mmd|drawio)$/, ''));
	const prior = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = prior.then(() => pending);
	locks.set(key, tail);
	await prior;
	try {
		return await run();
	} finally {
		release();
		if (locks.get(key) === tail) locks.delete(key);
	}
}
async function bytes(file: string, limit: number): Promise<Buffer | null> {
	try {
		const metadata = await lstat(file);
		if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > limit) throw new Error('WRITE_FAILED');
		const handle = await open(file, 'r');
		try {
			const start = await handle.stat();
			if (!start.isFile() || start.size > limit) throw new Error('WRITE_FAILED');
			const result = await handle.readFile();
			const end = await handle.stat();
			if (result.length > limit || start.size !== end.size || start.mtimeMs !== end.mtimeMs || result.length !== end.size)
				throw new Error('WRITE_FAILED');
			return result;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
async function exclusive(file: string, content: Uint8Array): Promise<void> {
	const handle = await open(file, 'wx', 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function remove(file: string, unlinkFile = unlink): Promise<void> {
	try {
		await unlinkFile(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}
function files(directory: string, source: string, id: string) {
	const stem = path.basename(assertDiagramRelativePath(source, ['mmd', 'drawio'])).replace(/\.(mmd|drawio)$/, '');
	const targets = ['svg', 'pdf', 'receipt.json'].map((extension) =>
		path.join(directory, extension === 'receipt.json' ? `.${stem}.${extension}` : `${stem}.${extension}`)
	);
	return {
		journal: path.join(directory, `.${stem}.publication.json`),
		targets,
		stages: targets.map((_target, i) => path.join(directory, `.${stem}.${id}.${i}.stage`)),
		backups: targets.map((_target, i) => path.join(directory, `.${stem}.${id}.${i}.backup`))
	};
}
function parseJournal(raw: Buffer): Journal {
	const value = JSON.parse(raw.toString('utf8')) as Journal;
	if (
		!value ||
		Object.keys(value).sort().join() !== 'id,old,phase,v' ||
		value.v !== 1 ||
		!UUID.test(value.id) ||
		!['prepared', 'committed'].includes(value.phase) ||
		!Array.isArray(value.old) ||
		value.old.length !== 3 ||
		value.old.some((hash) => hash !== null && (typeof hash !== 'string' || !SHA.test(hash)))
	)
		throw new Error('WRITE_FAILED');
	return value;
}
function parseReceipt(raw: Buffer): Receipt {
	const value = JSON.parse(raw.toString('utf8')) as Receipt;
	if (
		!value ||
		Object.keys(value).sort().join() !== 'pdfSha256,sourceSha256,svgSha256,v' ||
		value.v !== 1 ||
		![value.sourceSha256, value.svgSha256, value.pdfSha256].every((hash) => typeof hash === 'string' && SHA.test(hash))
	)
		throw new Error('WRITE_FAILED');
	return value;
}
/** Caller holds the bundle lock. Restart recovery rolls back prepared, cleans committed. */
export async function recoverDiagramPublication(root: string, source: string, unlinkFile = unlink): Promise<void> {
	const context = await diagramDirectory(root, true);
	const initial = files(context.directory, source, '');
	const raw = await bytes(initial.journal, 4096);
	if (!raw) return;
	let journal = parseJournal(raw);
	const f = files(context.directory, source, journal.id);
	const journalStage = `${f.journal}.${journal.id}.stage`;
	// A completed prepared marker left by a failed rollback rename records the
	// rollback intent. A partial/corrupt marker is NOT permission to discard backups.
	const staged = await bytes(journalStage, 4096);
	if (staged) {
		const pending = parseJournal(staged);
		if (pending.id !== journal.id || JSON.stringify(pending.old) !== JSON.stringify(journal.old)) throw new Error('WRITE_FAILED');
		if (journal.phase === 'committed' && pending.phase === 'prepared') {
			await verifyDirectoryUnchanged(context);
			await rename(journalStage, f.journal);
			journal = pending;
		}
	}
	if (journal.phase === 'prepared') {
		// Verify every backup before touching any existing output. Missing/corrupt backup
		// leaves the journal and last-good material intact for explicit recovery failure.
		const backups = await Promise.all(f.backups.map((backup, i) => bytes(backup, i === 2 ? 4096 : DIAGRAM_OUTPUT_LIMIT)));
		for (let i = 0; i < 3; i++)
			if (journal.old[i] !== null && (!backups[i] || digest(backups[i]!) !== journal.old[i])) throw new Error('WRITE_FAILED');
		for (let i = 0; i < 3; i++) {
			await verifyDirectoryUnchanged(context);
			await bytes(f.targets[i], i === 2 ? 4096 : DIAGRAM_OUTPUT_LIMIT); // reject symlink target
			if (journal.old[i] === null) await remove(f.targets[i]);
			else {
				await remove(f.stages[i]);
				await exclusive(f.stages[i], backups[i]!);
				await rename(f.stages[i], f.targets[i]);
			}
		}
		// Once every last-good target is restored, recovery is cleanup-only. Mark it
		// before deleting any backup so interrupted cleanup can safely resume.
		const cleanupStage = `${f.journal}.${randomUUID()}.stage`;
		try {
			await verifyDirectoryUnchanged(context);
			await exclusive(cleanupStage, Buffer.from(JSON.stringify({ ...journal, phase: 'committed' })));
			await rename(cleanupStage, f.journal);
		} finally {
			await remove(cleanupStage);
		}
	}
	for (const temporary of [...f.stages, ...f.backups]) await remove(temporary, unlinkFile);
	// Only issue marker-stage I/O when it actually exists; normal unlink ordering
	// remains stages/backups/journal-last for the commit-point fault tests.
	if (staged) await remove(journalStage, unlinkFile);
	await remove(f.journal, unlinkFile);
}
export async function publishedDiagramStatus(root: string, source: string) {
	return withDiagramPublicationLock(root, source, async () => {
		await recoverDiagramPublication(root, source);
		const result = await diagramBundleStatus(root, source);
		if (result.state === 'missing' || result.state === 'error') return result;
		const context = await diagramDirectory(root, false);
		const receiptBytes = await bytes(files(context.directory, source, '').targets[2], 4096);
		let matches = false;
		if (receiptBytes) {
			const receipt = parseReceipt(receiptBytes);
			matches =
				receipt.sourceSha256 === result.source.sha256 && receipt.svgSha256 === result.svg.sha256 && receipt.pdfSha256 === result.pdf.sha256;
		}
		return { ...result, state: matches ? ('ready' as const) : ('stale' as const), ready: matches, stale: !matches };
	});
}
/** Real staging/journal/backups. Three renames are recoverable, NOT cross-file atomic. */
export async function publishDiagramPair(
	root: string,
	source: string,
	sourceSha256: string,
	svg: string,
	pdf: Uint8Array,
	checkpoint: () => Promise<void>,
	renameFile = rename,
	lifecycle: DiagramPublicationLifecycle = {}
): Promise<Receipt> {
	return withDiagramPublicationLock(root, source, async () => {
		await recoverDiagramPublication(root, source);
		const context = await diagramDirectory(root, true);
		const publicationId = randomUUID();
		const f = files(context.directory, source, publicationId);
		const svgBytes = Buffer.from(svg, 'utf8');
		if (
			!svgBytes.length ||
			!pdf.length ||
			svgBytes.length > DIAGRAM_OUTPUT_LIMIT ||
			pdf.length > DIAGRAM_OUTPUT_LIMIT ||
			!SHA.test(sourceSha256)
		)
			throw new Error('WRITE_FAILED');
		const receipt: Receipt = { v: 1, sourceSha256, svgSha256: digest(svgBytes), pdfSha256: digest(pdf) };
		const values = [svgBytes, Buffer.from(pdf), Buffer.from(JSON.stringify(receipt))];
		let prepared = false;
		let committed = false;
		let rollbackMarkerFailed = false;
		let failure: unknown;
		const journalStage = `${f.journal}.${publicationId}.stage`;
		try {
			const old = await Promise.all(f.targets.map((target, i) => bytes(target, i === 2 ? 4096 : DIAGRAM_OUTPUT_LIMIT)));
			for (let i = 0; i < 3; i++) {
				await exclusive(f.stages[i], values[i]);
				if (old[i]) await exclusive(f.backups[i], old[i]!);
			}
			const journal: Journal = {
				v: 1,
				id: publicationId,
				phase: 'prepared',
				old: old.map((value) => (value ? digest(value) : null))
			};
			const check = async () => {
				await checkpoint();
				await verifyDirectoryUnchanged(context);
				if ((await readDiagram(root, source)).sha256 !== sourceSha256) throw new Error('SOURCE_CHANGED');
				await checkpoint();
			};
			await check();
			await exclusive(journalStage, Buffer.from(JSON.stringify(journal)));
			await renameFile(journalStage, f.journal);
			prepared = true;
			for (let i = 0; i < 3; i++) {
				await check();
				await bytes(f.targets[i], i === 2 ? 4096 : DIAGRAM_OUTPUT_LIMIT);
				await renameFile(f.stages[i], f.targets[i]);
			}
			await check();
			journal.phase = 'committed';
			await exclusive(journalStage, Buffer.from(JSON.stringify(journal)));
			await check();
			await renameFile(journalStage, f.journal);
			try {
				await check();
				// Synchronous native lease/signal check and phase transition: no await
				// may separate this guard from the live operation's commit point.
				lifecycle.commitGuard?.();
			} catch (error) {
				journal.phase = 'prepared';
				try {
					await (lifecycle.rollbackMarkerWrite ?? exclusive)(journalStage, Buffer.from(JSON.stringify(journal)));
					await (lifecycle.rollbackMarkerRename ?? rename)(journalStage, f.journal);
				} catch (markerError) {
					rollbackMarkerFailed = true;
					throw new DiagramPublicationIndeterminateError(receipt, new AggregateError([error, markerError], 'WRITE_FAILED'));
				}
				throw error;
			}
			committed = true;
			lifecycle.onCommitted?.();
			await recoverDiagramPublication(root, source, lifecycle.unlinkFile);
			return receipt;
		} catch (error) {
			failure = committed ? new DiagramPublicationCommittedError(receipt, error) : error;
			if (prepared && !committed && !rollbackMarkerFailed) {
				try {
					await recoverDiagramPublication(root, source);
				} catch (recoveryError) {
					failure = new AggregateError([error, recoveryError], 'WRITE_FAILED');
					throw failure;
				}
			}
			throw failure;
		} finally {
			const cleanupErrors: unknown[] = [];
			// A committed journalStage was already renamed. Nothing remains here;
			// journal removal must stay the final cleanup I/O, not precede a late await.
			const temporaries = committed || rollbackMarkerFailed ? [] : prepared ? [journalStage] : [journalStage, ...f.stages, ...f.backups];
			for (const temporary of temporaries) {
				try {
					await remove(temporary);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'WRITE_FAILED');
		}
	});
}
