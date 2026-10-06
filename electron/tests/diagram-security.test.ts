import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DIAGRAM_OUTPUT_LIMIT,
	DRAWIO_SOURCE_LIMIT,
	MERMAID_SOURCE_LIMIT,
	assertDiagramRelativePath,
	diagramBundlePaths,
	resolveDiagramPath
} from '../src/diagram-security';
import { atomicWriteDiagram, diagramBundleStatus, readDiagram, readDiagramAsset } from '../src/diagram-service';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const MMD = `assets/diagrams/system-flow-${ID}.mmd`;
const DRAWIO = `assets/diagrams/system-flow-${ID}.drawio`;
const SVG = `assets/diagrams/system-flow-${ID}.svg`;
const PDF = `assets/diagrams/system-flow-${ID}.pdf`;

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix = 'modutex-sidecar-'): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function native(root: string, relativePath: string): string {
	return path.join(root, ...relativePath.split('/'));
}

function sha256(bytes: string | Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('diagram sidecar naming and lexical confinement', () => {
	it('derives one source, preview, and PDF stem from a validated slug, UUID, and type', () => {
		expect(diagramBundlePaths('system-flow', ID, 'mermaid')).toEqual({ source: MMD, svg: SVG, pdf: PDF });
		expect(diagramBundlePaths('system-flow', ID, 'drawio')).toEqual({ source: DRAWIO, svg: SVG, pdf: PDF });
	});

	it.each([
		['System-flow', ID, 'mermaid'],
		['system--flow', ID, 'mermaid'],
		['../system', ID, 'mermaid'],
		['x'.repeat(500), ID, 'mermaid'],
		['system', 'not-a-uuid', 'mermaid'],
		['system', ID, 'unknown']
	])('rejects unsafe naming input %#', (slug, id, type) => {
		expect(() => diagramBundlePaths(slug, id, type)).toThrow('INVALID_DIAGRAM_NAME');
	});

	it('accepts only canonical workspace-relative names with the expected extension', () => {
		expect(assertDiagramRelativePath(MMD, ['mmd'])).toBe(MMD);
		for (const candidate of [
			`assets/diagrams/../secret-${ID}.mmd`,
			`assets/diagrams/./system-${ID}.mmd`,
			`assets/diagrams//system-${ID}.mmd`,
			`/assets/diagrams/system-${ID}.mmd`,
			`C:/assets/diagrams/system-${ID}.mmd`,
			`assets\\diagrams\\system-${ID}.mmd`,
			`\\\\server\\share\\system-${ID}.mmd`,
			`assets/diagrams/System-${ID}.mmd`,
			`assets/diagrams/system-${ID}.exe`,
			`assets/diagrams/system-${ID}Xmmd`,
			`assets/diagrams/system-${ID}.pdf/extra`
		]) {
			expect(() => assertDiagramRelativePath(candidate)).toThrow('INVALID_PATH');
		}
		expect(() => assertDiagramRelativePath(PDF, ['mmd'])).toThrow('INVALID_PATH');
	});

	it('resolves lexically beneath an absolute workspace root without returning relative input', () => {
		const root = path.resolve('C:/workspace');
		expect(resolveDiagramPath(root, MMD, ['mmd'])).toBe(native(root, MMD));
		expect(() => resolveDiagramPath('relative', MMD)).toThrow('INVALID_ROOT');
	});
});

describe('canonical filesystem confinement', () => {
	it('rejects an assets directory junction before creating anything outside the workspace', async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot('modutex-sidecar-outside-');
		await symlink(outside, path.join(root, 'assets'), 'junction');

		await expect(atomicWriteDiagram(root, MMD, 'flowchart LR\nA-->B')).rejects.toThrow('INVALID_PATH');
		expect(await readdir(outside)).toEqual([]);
	});

	it('rejects a diagrams directory junction and an existing target reparse link', async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot('modutex-sidecar-outside-');
		await mkdir(path.join(root, 'assets'));
		await symlink(outside, path.join(root, 'assets', 'diagrams'), 'junction');
		await expect(atomicWriteDiagram(root, MMD, 'outside?')).rejects.toThrow('INVALID_PATH');
		expect(await readdir(outside)).toEqual([]);

		await rm(path.join(root, 'assets', 'diagrams'));
		await mkdir(path.join(root, 'assets', 'diagrams'));
		const outsideTarget = path.join(outside, 'target');
		await mkdir(outsideTarget);
		const outsideFile = path.join(outsideTarget, 'sentinel.mmd');
		await writeFile(outsideFile, 'do not replace');
		await symlink(outsideTarget, native(root, MMD), 'junction');
		await expect(atomicWriteDiagram(root, MMD, 'replacement')).rejects.toThrow('INVALID_PATH');
		await expect(readDiagram(root, MMD)).rejects.toThrow('INVALID_PATH');
		expect(await readFile(outsideFile, 'utf8')).toBe('do not replace');
	});

	it('does not create assets/diagrams while inspecting a missing bundle', async () => {
		const root = await temporaryRoot();
		const status = await diagramBundleStatus(root, MMD);
		expect(status.state).toBe('missing');
		await expect(lstat(path.join(root, 'assets'))).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

describe('atomic sidecar storage', () => {
	it('writes and replaces bytes through the production boundary with independent hashes and no temporary residue', async () => {
		const root = await temporaryRoot();
		const first = Buffer.from('flowchart LR\nA-->B\n', 'utf8');
		const second = Buffer.from('flowchart LR\nA-->C\n', 'utf8');

		expect(await atomicWriteDiagram(root, MMD, first)).toEqual({ sha256: sha256(first), size: first.byteLength });
		expect(await atomicWriteDiagram(root, MMD, second)).toEqual({ sha256: sha256(second), size: second.byteLength });
		expect(await readFile(native(root, MMD))).toEqual(second);
		expect((await readdir(path.dirname(native(root, MMD)))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
	});

	it.each([
		[MMD, MERMAID_SOURCE_LIMIT],
		[DRAWIO, DRAWIO_SOURCE_LIMIT],
		[SVG, DIAGRAM_OUTPUT_LIMIT],
		[PDF, DIAGRAM_OUTPUT_LIMIT]
	])('accepts the exact payload limit for %s', async (relativePath, limit) => {
		const root = await temporaryRoot();
		const bytes = Buffer.alloc(limit, 0x61);
		await expect(atomicWriteDiagram(root, relativePath, bytes)).resolves.toMatchObject({ size: limit });
		expect((await stat(native(root, relativePath))).size).toBe(limit);
	});

	it.each([
		[MMD, MERMAID_SOURCE_LIMIT],
		[DRAWIO, DRAWIO_SOURCE_LIMIT],
		[SVG, DIAGRAM_OUTPUT_LIMIT],
		[PDF, DIAGRAM_OUTPUT_LIMIT]
	])('rejects one byte over the payload limit for %s without changing last-known-good bytes', async (relativePath, limit) => {
		const root = await temporaryRoot();
		const lastKnownGood = Buffer.from('last-known-good');
		await atomicWriteDiagram(root, relativePath, lastKnownGood);
		await expect(atomicWriteDiagram(root, relativePath, Buffer.alloc(limit + 1))).rejects.toThrow('PAYLOAD_TOO_LARGE');
		expect(await readFile(native(root, relativePath))).toEqual(lastKnownGood);
		expect((await readdir(path.dirname(native(root, relativePath)))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
	});

	it('cleans its same-directory temporary file when the final rename fails', async () => {
		const root = await temporaryRoot();
		await mkdir(native(root, MMD), { recursive: true });
		await expect(atomicWriteDiagram(root, MMD, 'cannot replace a directory')).rejects.toThrow('DIAGRAM_WRITE_FAILED');
		expect((await stat(native(root, MMD))).isDirectory()).toBe(true);
		expect((await readdir(path.dirname(native(root, MMD)))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
	});

	it('returns scrubbed errors that do not disclose the workspace root', async () => {
		const root = await temporaryRoot();
		await mkdir(native(root, MMD), { recursive: true });
		try {
			await atomicWriteDiagram(root, MMD, 'fails');
			throw new Error('expected write failure');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe('DIAGRAM_WRITE_FAILED');
			expect((error as Error).message).not.toContain(root);
		}
	});
});

describe('bundle status and reopen behavior', () => {
	it('reports missing while retaining the last successful SVG/PDF metadata', async () => {
		const root = await temporaryRoot();
		const svg = Buffer.from('<svg viewBox="0 0 1 1"/>');
		const pdf = Buffer.from('%PDF-last-known-good');
		await atomicWriteDiagram(root, SVG, svg);
		await atomicWriteDiagram(root, PDF, pdf);

		const status = await diagramBundleStatus(root, MMD);
		expect(status).toMatchObject({ state: 'missing', missing: true, stale: false, ready: false, error: false });
		expect(status.source.exists).toBe(false);
		expect(status.svg).toMatchObject({ exists: true, size: svg.byteLength, sha256: sha256(svg) });
		expect(status.pdf).toMatchObject({ exists: true, size: pdf.byteLength, sha256: sha256(pdf) });
		expect(await readDiagramAsset(root, PDF, ['pdf'])).toEqual(pdf);
	});

	it('moves from stale to ready, then detects an externally edited source after reopen without deleting outputs', async () => {
		const root = await temporaryRoot();
		const sourceV1 = Buffer.from('flowchart LR\nA-->B');
		const sourceV2 = Buffer.from('flowchart LR\nA-->C');
		const svg = Buffer.from('<svg viewBox="0 0 1 1"/>');
		const pdf = Buffer.from('%PDF-last-known-good');
		await atomicWriteDiagram(root, MMD, sourceV1);
		expect((await diagramBundleStatus(root, MMD)).state).toBe('stale');

		await atomicWriteDiagram(root, SVG, svg);
		await atomicWriteDiagram(root, PDF, pdf);
		const old = new Date('2026-01-01T00:00:00.000Z');
		const rendered = new Date('2026-01-01T00:00:10.000Z');
		await utimes(native(root, MMD), old, old);
		await utimes(native(root, SVG), rendered, rendered);
		await utimes(native(root, PDF), rendered, rendered);

		const ready = await diagramBundleStatus(root, MMD);
		expect(ready).toMatchObject({ state: 'ready', missing: false, stale: false, ready: true, error: false });
		expect(ready.source.sha256).toBe(sha256(sourceV1));
		expect(ready.source.mtimeMs).toBe(old.getTime());
		expect(ready.svg.mtimeMs).toBe(rendered.getTime());
		expect(ready.pdf.mtimeMs).toBe(rendered.getTime());

		await writeFile(native(root, MMD), sourceV2);
		const edited = new Date('2026-01-01T00:00:20.000Z');
		await utimes(native(root, MMD), edited, edited);
		const reopened = await diagramBundleStatus(root, MMD);
		expect(reopened).toMatchObject({ state: 'stale', missing: false, stale: true, ready: false, error: false });
		expect(reopened.source.sha256).toBe(sha256(sourceV2));
		expect(reopened.pdf.sha256).toBe(sha256(pdf));
		expect(await readFile(native(root, PDF))).toEqual(pdf);
	});

	it('reports an on-disk file error distinctly and preserves other readable metadata', async () => {
		const root = await temporaryRoot();
		const source = Buffer.from('flowchart LR\nA-->B');
		const pdf = Buffer.from('%PDF-last-known-good');
		await atomicWriteDiagram(root, MMD, source);
		await atomicWriteDiagram(root, PDF, pdf);
		await mkdir(native(root, SVG), { recursive: true });

		const status = await diagramBundleStatus(root, MMD);
		expect(status).toMatchObject({ state: 'error', missing: false, stale: false, ready: false, error: true });
		expect(status.svg).toMatchObject({ exists: false, error: 'INVALID_FILE' });
		expect(status.pdf.sha256).toBe(sha256(pdf));
	});

	it('reads source bytes with hash/mtime and rejects oversized or missing data with scrubbed errors', async () => {
		const root = await temporaryRoot();
		const source = Buffer.from('flowchart LR\nA-->B');
		await atomicWriteDiagram(root, MMD, source);
		await expect(readDiagram(root, MMD)).resolves.toMatchObject({ content: source.toString(), sha256: sha256(source) });
		await expect(readDiagram(root, DRAWIO)).rejects.toThrow('DIAGRAM_NOT_FOUND');

		await writeFile(native(root, MMD), Buffer.alloc(MERMAID_SOURCE_LIMIT + 1));
		await expect(readDiagram(root, MMD)).rejects.toThrow('PAYLOAD_TOO_LARGE');
	});
});
