import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FrontendFiles } from '../src/frontend-files';
import { FrontendCompiler } from '../src/frontend-compile';
import { createManagedCompileService, checkedCompilePath, MANAGED_FORMAT_SETUP_TIMEOUT_MS } from '../src/managed-compile';
import { matrixSource, equationSource, equationAt, equationReplacement } from '../../apps/frontend/src/features/math/source';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { createTable, tableSource } from '../../apps/frontend/src/features/tables/source';
import { booktabsPlan, tableInsertionTransaction } from '../../apps/frontend/src/features/tables/preamble';
import { createSourceState, sourceState, rangeInsertionTarget, historyTransaction } from '../../apps/frontend/src/features/source-editor/state';
import { createDraft } from '../../apps/frontend/src/features/files/templates';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const data = path.join(repository, '.verification-artifacts', 'frontend-runtime-2026-10-07');
await checkedCompilePath(repository, true);
for (const directory of [path.dirname(data), data]) {
	try { await fs.mkdir(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	await checkedCompilePath(directory, true);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-frontend-runtime-'));
const files = new FrontendFiles();
const engine = createManagedCompileService({ runtime: { isPackaged: false, appPath: repository,
	resourcesPath: repository, userData: data }, authorize: () => files.compileOwner() });
const compiler = new FrontendCompiler(engine, () => files);
afterAll(async () => {
	compiler.cancelOwner(1); engine.close(); files.close();
	if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('modutex-frontend-runtime-')) throw new Error('Unsafe cleanup');
	await fs.rm(root, { recursive: true, force: true });
});
beforeEach(() => {
	files.close();
});
afterEach(() => {
	files.close();
});
async function request(text: string) {
	await fs.writeFile(path.join(root, 'main.tex'), text);
	const workspace = await files.open(root, 'folder');
	const read = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
	return { workspaceId: workspace.id, entryPath: 'main.tex', documentId: 'real-document', documentVersion: 0,
		savedRevision: read.revision, engine: 'managed' as const };
}
describe('actual bundled Tectonic frontend integration (no mock engine or PDF)', () => {
	it('compiles confirmed booktabs preamble and true three-line tables using the existing warm engine cache', async () => {
		try {
			const original = SourceDocument.open(Buffer.from('\uFEFF% keep\r\n\\documentclass{article}\r\n\\begin{document}\r\nBody\n\\end{document}\r'));
			const plan = booktabsPlan(original, parseSource(original)); expect(plan).not.toBeNull(); if (!plan) throw new Error('Expected explicit package plan');
			const tables = (['none', 'above', 'below'] as const).map((position, index) => tableSource({ ...createTable(3, 2), rules: 'booktabs', header: index !== 1,
				cells: ['Metric', 'Value', 'A & B', '10%', 'raw', '\\end{tabular}'], weights: [2, 1], caption: { position, text: 'Results_#1' } })).join('\n');
			const from = original.read().indexOf('Body'), span = { documentId: original.documentId, version: original.version, from, to: from + 4 };
			const initial = createSourceState(original), state = tableInsertionTransaction(initial, rangeInsertionTarget(initial, span), tables, plan).state;
			const changed = state.field(sourceState).projection.document;
			expect(changed.read().match(/\\usepackage\{booktabs\}/g)?.length).toBe(1);
			expect(changed.read().match(/\\toprule/g)?.length).toBe(3); expect(changed.read().match(/\\bottomrule/g)?.length).toBe(3);
			expect(Buffer.from(historyTransaction(state, 'undo')!.state.field(sourceState).projection.document.toBytes())).toEqual(Buffer.from(original.toBytes()));
			const identity = await request(Buffer.from(changed.toBytes()).toString('utf8'));
			expect(await fs.readFile(path.join(root, 'main.tex'))).toEqual(Buffer.from(changed.toBytes()));
			const run = await compiler.start({}, 1, identity), result = await compiler.result(1, run.runId);
			expect(result.status, result.log).toBe('success'); if (result.status !== 'success') throw new Error(result.log);
			expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
			expect(Buffer.from(result.pdf)).toEqual(await fs.readFile(path.join(root, 'output', 'main.pdf')));
		} finally {
			files.close();
		}
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15000);
	it.each(['blank', 'article', 'report'] as const)('compiles the original %s new-document template with genuine saved bytes and PDF', async (id) => {
		files.close();
		let savedWorkspaceId: string | null = null;
		try {
			const draft = createDraft(id);
			const saved = await files.saveAs(path.join(root, id + '.tex'), { workspaceId: null, bytes: draft.toBytes(), documentId: draft.documentId, documentVersion: draft.version });
			savedWorkspaceId = saved.workspace.id;
			const disk = await fs.readFile(path.join(root, id + '.tex'));
			expect(disk).toEqual(Buffer.from(draft.toBytes()));
			const run = await compiler.start({}, 1, { workspaceId: saved.workspace.id, entryPath: saved.workspace.entryPath!, documentId: draft.documentId, documentVersion: draft.version, savedRevision: saved.write.revision, engine: 'managed' });
			const result = await compiler.result(1, run.runId);
			expect(result.status, result.log).toBe('success');
			if (result.status !== 'success') throw new Error(result.log);
			expect(result.identity.documentId).toBe(draft.documentId);
			expect(result.identity.savedRevision).toBe(saved.write.revision);
			expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
			expect(Buffer.from(result.pdf)).toEqual(await fs.readFile(path.join(root, 'output', id + '.pdf')));
		} finally {
			files.close();
		}
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15000);
	it('compiles all generated table styles, caption positions and escaped literal content without extra packages', async () => {
		const tables = (['three-line', 'full', 'horizontal'] as const).map((style, index) => tableSource({
			...createTable(3, 2), style, weights: [2, 1], width: 80, cells: ['Metric', 'Value', 'A & B', '10%', 'raw', '\\end{tabular}'],
			caption: { position: index === 0 ? 'none' : index === 1 ? 'above' : 'below', text: 'Results_#1' }
		})).join('\n');
		const run = await compiler.start({}, 1, await request('\\documentclass{article}\n\\begin{document}\n' + tables + '\n\\end{document}\n'));
		const result = await compiler.result(1, run.runId);
		expect(result.status, result.log).toBe('success');
		if (result.status !== 'success') throw new Error(result.log);
		expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15000);
	it('re-edits all four real equation delimiters, saves their exact patched bytes and compiles genuine PDFs', async () => {
		const delimiters = [['$', '$', true], ['$$', '$$', false], ['\\(', '\\)', true], ['\\[', '\\]', false]] as const;
		for (const [index, [opening, closing, inline]] of delimiters.entries()) {
			const name = `equation-reedit-${index}.tex`;
			const prefix = '\uFEFF% original fixture\r\n\\documentclass{article}\r\n\\begin{document}\nBefore.\r\n';
			const suffix = '\r\nAfter.\n\\end{document}\r\n';
			const original = Buffer.from(prefix + opening + 'x^2' + closing + suffix);
			await fs.writeFile(path.join(root, name), original);
			const workspace = await files.open(root, 'folder');
			const read = await files.read({ workspaceId: workspace.id, path: name });
			const source = SourceDocument.open(read.bytes);
			const located = equationAt(source, parseSource(source), source.read().indexOf('x^2'));
			expect(located).not.toBeNull();
			if (!located) throw new Error('Equation parser did not grant current delimiter authority');
			const latex = '\\frac{1}{2}+\\sqrt{4}+\\alpha';
			const replacement = equationReplacement(source, located, { latex, inline });
			expect(replacement).toBe(opening + latex + closing);
			const changed = source.apply({ expectedVersion: source.version, patches: [{ from: located.span.from, to: located.span.to,
				insert: replacement, expected: source.read(located.span.from, located.span.to) }] }).document;
			expect(Buffer.from(source.toBytes())).toEqual(original);
			expect(Buffer.from(changed.toBytes())).toEqual(Buffer.from(prefix + opening + latex + closing + suffix));
			const receipt = await files.write({ workspaceId: workspace.id, path: name, bytes: changed.toBytes(), expectedRevision: read.revision,
				documentId: changed.documentId, documentVersion: changed.version });
			expect(await fs.readFile(path.join(root, name))).toEqual(Buffer.from(changed.toBytes()));
			expect(receipt.revision).not.toBe(read.revision);
			const reopened = await files.read({ workspaceId: workspace.id, path: name });
			expect(reopened.revision).toBe(receipt.revision);
			expect(Buffer.from(reopened.bytes)).toEqual(Buffer.from(changed.toBytes()));
			const reopenedSource = SourceDocument.open(reopened.bytes);
			expect(equationAt(reopenedSource, parseSource(reopenedSource), reopenedSource.read().indexOf(latex))?.draft).toEqual({ latex, inline });
			const run = await compiler.start({}, 1, { workspaceId: workspace.id, entryPath: name, documentId: changed.documentId,
				documentVersion: changed.version, savedRevision: receipt.revision, engine: 'managed' });
			const result = await compiler.result(1, run.runId);
			expect(result.status, result.log).toBe('success');
			if (result.status !== 'success') throw new Error(result.log);
			expect(result.identity.documentId).toBe(changed.documentId);
			expect(result.identity.documentVersion).toBe(changed.version);
			expect(result.identity.savedRevision).toBe(receipt.revision);
			expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
			expect(Buffer.from(result.pdf)).toEqual(await fs.readFile(path.join(root, 'output', `equation-reedit-${index}.pdf`)));
		}
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 60000);
	it('compiles generated 1x1, rectangular and 10x10 matrices without adding amsmath', async () => {
		const formulas = [[1, 1], [3, 2], [10, 10]].map(([rows, columns]) => equationSource(matrixSource({
			rows: rows!, columns: columns!, cells: Array.from({ length: rows! * columns! }, (_, index) => String(index % 10))
		}, 'parentheses'), false)).join('\n');
		const run = await compiler.start({}, 1, await request('\\documentclass{article}\n\\begin{document}\n' + formulas + '\n\\end{document}\n'));
		const result = await compiler.result(1, run.runId);
		expect(result.status, result.log).toBe('success');
		if (result.status !== 'success') throw new Error(result.log);
		expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15000);
	it('generates a genuine PDF and preserves it after actual LaTeX failure', async () => {
		const first = await compiler.start({}, 1, await request('\\documentclass{article}\n\\begin{document}Frontend compile.\\end{document}\n'));
		const pending = compiler.result(1, first.runId);
		await expect(compiler.result(1, first.runId)).rejects.toThrow('BUSY');
		await expect(compiler.result(2, first.runId)).rejects.toThrow('STALE_WORKSPACE');
		const result = await pending;
		expect(result.status, result.log).toBe('success');
		if (result.status !== 'success') throw new Error(result.log);
		expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
		const previous = await fs.readFile(path.join(root, 'output', 'main.pdf'));
		expect(Buffer.from(result.pdf)).toEqual(previous);
		const second = await compiler.start({}, 1, await request('\\documentclass{article}\n\\begin{document}\\undefinedfrontendcommand\\end{document}\n'));
		const failure = await compiler.result(1, second.runId);
		expect(failure.status).toBe('failure');
		expect(failure.diagnostics[0]?.line, failure.log).toBe(2);
		expect(failure.diagnostics[0]?.path).toBe('main.tex');
		expect(await fs.readFile(path.join(root, 'output', 'main.pdf'))).toEqual(previous);
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15000);
	it('cancels a real nonterminating TeX run and allows a subsequent compile', async () => {
		const run = await compiler.start({}, 1, await request('\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n'));
		const finished = compiler.result(1, run.runId);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const peer = new FrontendFiles();
		const workspace = await peer.open(root, 'folder');
		const original = await peer.read({ workspaceId: workspace.id, path: 'main.tex' });
		try {
			await expect(peer.write({ workspaceId: workspace.id, path: 'main.tex', expectedRevision: original.revision,
				documentId: 'peer-document', documentVersion: 1, bytes: Buffer.from('must not overwrite') })).rejects.toThrow('BUSY');
			expect(await fs.readFile(path.join(root, 'main.tex'))).toEqual(Buffer.from(original.bytes));
		} finally { peer.close(); }
		await compiler.cancel(1, run.runId);
		expect((await finished).status).toBe('cancelled');
		const next = await compiler.start({}, 1, await request('\\documentclass{article}\n\\begin{document}After cancel.\\end{document}\n'));
		const result = await compiler.result(1, next.runId);
		expect(result.status, result.log).toBe('success');
	}, 30000);
	it('rejects stale disk revision before launching and foreign result identity', async () => {
		const initial = await request('\\documentclass{article}\n\\begin{document}One.\\end{document}\n');
		await fs.writeFile(path.join(root, 'main.tex'), 'external');
		await expect(compiler.start({}, 1, initial)).rejects.toThrow('FILE_CONFLICT');
		await expect(compiler.result(2, 'foreign')).rejects.toThrow('STALE_WORKSPACE');
	});
});
