import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rename, writeFile, rm, readdir, utimes, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteDiagram, readDiagram } from '../src/diagram-service';
import {
	publishDiagramPair,
	publishedDiagramStatus,
	recoverDiagramPublication,
	withDiagramPublicationLock,
	DiagramPublicationCommittedError,
	DiagramPublicationIndeterminateError
} from '../src/diagram-publication';
const source = 'assets/diagrams/test-123e4567-e89b-42d3-a456-426614174000.drawio';
const owned: string[] = [];
afterEach(async () => {
	for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'modutex-publication-'));
	owned.push(root);
	await atomicWriteDiagram(root, source, '<mxGraphModel/>');
	return { root, hash: (await readDiagram(root, source)).sha256 };
}
// These tests exercise filesystem transaction bytes, not a substitute PDF producer.
const oldSvg = '<svg>last-good</svg>',
	newSvg = '<svg>next</svg>';
const oldPdf = Buffer.from('transaction-old-pdf-bytes'),
	newPdf = Buffer.from('transaction-new-pdf-bytes');
async function oldPair(root: string, hash: string) {
	await publishDiagramPair(root, source, hash, oldSvg, oldPdf, async () => {});
}
async function unchanged(root: string) {
	expect(await readFile(path.join(root, source.replace('.drawio', '.svg')), 'utf8')).toBe(oldSvg);
	expect(await readFile(path.join(root, source.replace('.drawio', '.pdf')))).toEqual(oldPdf);
}
describe('real filesystem publication and recovery', () => {
	it('publishes both outputs with hash receipt; same-mtime changes become stale', async () => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		expect((await publishedDiagramStatus(root, source)).state).toBe('ready');
		const current = await readDiagram(root, source);
		await atomicWriteDiagram(root, source, '<mxGraphModel modified="1"/>');
		await utimes(path.join(root, source), new Date(current.mtimeMs), new Date(current.mtimeMs));
		expect((await publishedDiagramStatus(root, source)).state).toBe('stale');
		await unchanged(root);
	});
	it.each([1, 2, 3, 4, 5])('rolls back each publication rename failure %i', async (failure) => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		let calls = 0;
		await expect(
			publishDiagramPair(
				root,
				source,
				hash,
				newSvg,
				newPdf,
				async () => {},
				async (a, b) => {
					if (++calls === failure) throw new Error('injected rename');
					await rename(a, b);
				}
			)
		).rejects.toThrow();
		await unchanged(root);
		expect((await publishedDiagramStatus(root, source)).state).toBe('ready');
	});
	it('source change and cancellation at checkpoints preserve old outputs', async () => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		let calls = 0;
		await expect(
			publishDiagramPair(root, source, hash, newSvg, newPdf, async () => {
				if (++calls === 5) await atomicWriteDiagram(root, source, 'changed');
			})
		).rejects.toThrow('SOURCE_CHANGED');
		await unchanged(root);
		const saved = await readDiagram(root, source);
		calls = 0;
		await expect(
			publishDiagramPair(root, source, saved.sha256, newSvg, newPdf, async () => {
				if (++calls === 5) throw new Error('RENDER_ABORTED');
			})
		).rejects.toThrow('RENDER_ABORTED');
		await unchanged(root);
	});
	it('final synchronous commit guard abort rolls back and never marks committed', async () => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		let committed = false;
		await expect(
			publishDiagramPair(root, source, hash, newSvg, newPdf, async () => {}, undefined, {
				commitGuard() {
					throw new Error('RENDER_ABORTED');
				},
				onCommitted() {
					committed = true;
				}
			})
		).rejects.toThrow('RENDER_ABORTED');
		expect(committed).toBe(false);
		await unchanged(root);
		expect((await publishedDiagramStatus(root, source)).state).toBe('ready');
	});
	it.each([1, 5, 7])('retains committed receipt/pair and restart cleanup after unlink fault %i', async (failure) => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		let calls = 0,
			committed = false,
			outcome: unknown;
		try {
			await publishDiagramPair(root, source, hash, newSvg, newPdf, async () => {}, undefined, {
				commitGuard() {
					expect(committed).toBe(false);
				},
				onCommitted() {
					committed = true;
				},
				async unlinkFile(file) {
					if (++calls === failure) throw new Error('injected committed unlink');
					await unlink(file);
				}
			});
		} catch (error) {
			outcome = error;
		}
		expect(committed).toBe(true);
		expect(outcome).toBeInstanceOf(DiagramPublicationCommittedError);
		const error = outcome as DiagramPublicationCommittedError;
		expect(error.committed).toBe(true);
		expect(error.message).toBe('WRITE_FAILED');
		expect((error.cause as Error).message).toBe('injected committed unlink');
		const directory = path.dirname(path.join(root, source)),
			stem = path.basename(source, '.drawio');
		expect(JSON.parse(await readFile(path.join(directory, `.${stem}.publication.json`), 'utf8')).phase).toBe('committed');
		expect(await readFile(path.join(directory, `${stem}.svg`), 'utf8')).toBe(newSvg);
		expect(await readFile(path.join(directory, `${stem}.pdf`))).toEqual(newPdf);
		expect(JSON.parse(await readFile(path.join(directory, `.${stem}.receipt.json`), 'utf8'))).toEqual(error.receipt);
		expect(error.receipt).toEqual({
			v: 1,
			sourceSha256: hash,
			svgSha256: createHash('sha256').update(newSvg).digest('hex'),
			pdfSha256: createHash('sha256').update(newPdf).digest('hex')
		});
		await withDiagramPublicationLock(root, source, () => recoverDiagramPublication(root, source));
		expect((await readdir(directory)).some((name) => /\.(backup|stage|publication\.json)$/.test(name))).toBe(false);
		expect((await publishedDiagramStatus(root, source)).state).toBe('ready');
		expect(await readFile(path.join(directory, `${stem}.pdf`))).toEqual(newPdf);
	});
	it.each(['write-before', 'write-partial', 'rename'] as const)('preserves rollback evidence after marker %s failure', async (mode) => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		let committed = false,
			outcome: unknown;
		try {
			await publishDiagramPair(root, source, hash, newSvg, newPdf, async () => {}, undefined, {
				commitGuard() {
					throw new Error('RENDER_ABORTED');
				},
				onCommitted() {
					committed = true;
				},
				async rollbackMarkerWrite(file, content) {
					if (mode === 'write-before') throw new Error('marker write failed');
					if (mode === 'write-partial') {
						await writeFile(file, '{"v":', { flag: 'wx' });
						throw new Error('marker partial write failed');
					}
					await writeFile(file, content, { flag: 'wx' });
				},
				async rollbackMarkerRename(a, b) {
					if (mode === 'rename') throw new Error('marker rename failed');
					await rename(a, b);
				}
			});
		} catch (error) {
			outcome = error;
		}
		expect(committed).toBe(false);
		expect(outcome).toBeInstanceOf(DiagramPublicationIndeterminateError);
		const error = outcome as DiagramPublicationIndeterminateError;
		expect(error.indeterminate).toBe(true);
		expect(error.message).toBe('WRITE_FAILED');
		expect((error.cause as AggregateError).errors[0].message).toBe('RENDER_ABORTED');
		const directory = path.dirname(path.join(root, source)),
			stem = path.basename(source, '.drawio');
		const journalPath = path.join(directory, `.${stem}.publication.json`);
		const journal = JSON.parse(await readFile(journalPath, 'utf8'));
		expect(journal.phase).toBe('committed');
		const names = await readdir(directory);
		expect(names.filter((n) => n.endsWith('.backup'))).toHaveLength(3);
		expect(await readFile(path.join(directory, `${stem}.svg`), 'utf8')).toBe(newSvg);
		expect(JSON.parse(await readFile(path.join(directory, `.${stem}.receipt.json`), 'utf8'))).toEqual(error.receipt);
		const markerPath = `${journalPath}.${journal.id}.stage`;
		if (mode === 'write-partial') {
			// Recovery refuses a corrupt intent marker, keeps every backup, and never
			// turns a cancelled/indeterminate publication into a fabricated old pair.
			await expect(withDiagramPublicationLock(root, source, () => recoverDiagramPublication(root, source))).rejects.toThrow();
			expect((await readdir(directory)).filter((n) => n.endsWith('.backup'))).toHaveLength(3);
			expect(JSON.parse(await readFile(journalPath, 'utf8')).phase).toBe('committed');
			// Model explicit repair from the retained transaction evidence, then retry
			// real recovery. This is NOT an automatic production repair capability.
			await writeFile(markerPath, JSON.stringify({ ...journal, phase: 'prepared' }));
		}
		await withDiagramPublicationLock(root, source, () => recoverDiagramPublication(root, source));
		if (mode === 'write-before') {
			// No rollback intent reached disk: the durable committed pair is retained.
			expect(await readFile(path.join(directory, `${stem}.pdf`))).toEqual(newPdf);
		} else {
			await unchanged(root);
		}
		expect((await publishedDiagramStatus(root, source)).state).toBe('ready');
		expect((await readdir(directory)).some((n) => /\.(stage|backup|publication\.json)$/.test(n))).toBe(false);
	});
	it('restart recovery restores prepared pair even after one live target replacement', async () => {
		const { root, hash } = await fixture();
		await oldPair(root, hash);
		// Capture an actual prepared journal/backups at the next rename. Fail rollback
		// by temporarily hiding a backup, then return it to model restart recovery.
		let moved: string | undefined;
		let calls = 0;
		await expect(
			publishDiagramPair(
				root,
				source,
				hash,
				newSvg,
				newPdf,
				async () => {},
				async (a, b) => {
					await rename(a, b);
					if (++calls === 2) {
						const directory = path.dirname(b);
						const backup = (await readdir(directory)).find((n) => n.endsWith('.0.backup'))!;
						moved = path.join(directory, backup);
						await rename(moved, moved + '.held');
						throw new Error('crash');
					}
				}
			)
		).rejects.toThrow('WRITE_FAILED');
		await rename(moved! + '.held', moved!);
		await withDiagramPublicationLock(root, source, () => recoverDiagramPublication(root, source));
		await unchanged(root);
		expect((await publishedDiagramStatus(root, source)).state).toBe('ready');
	});
});
