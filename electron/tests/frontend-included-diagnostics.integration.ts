import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FrontendFiles } from '../src/frontend-files';
import { FrontendCompiler } from '../src/frontend-compile';
import { createManagedCompileService, checkedCompilePath, MANAGED_FORMAT_SETUP_TIMEOUT_MS } from '../src/managed-compile';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const data = path.join(repository, '.verification-artifacts', 'frontend-runtime-2026-10-07');
await checkedCompilePath(repository, true);
for (const directory of [path.dirname(data), data]) {
	try { await fs.mkdir(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	await checkedCompilePath(directory, true);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-frontend-included-diagnostics-'));
const files = new FrontendFiles();
const engine = createManagedCompileService({
	runtime: { isPackaged: false, appPath: repository, resourcesPath: repository, userData: data },
	authorize: () => files.compileOwner()
});
const compiler = new FrontendCompiler(engine, () => files);
let pendingResult: ReturnType<FrontendCompiler['result']> | null = null;

afterAll(async () => {
	compiler.cancelOwner(1);
	engine.close();
	if (pendingResult) await Promise.allSettled([pendingResult]);
	files.close();
	if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('modutex-frontend-included-diagnostics-')) {
		throw new Error('Unsafe cleanup');
	}
	await fs.rm(root, { recursive: true, force: true });
});
afterEach(async () => {
	compiler.cancelOwner(1);
	if (pendingResult) await Promise.allSettled([pendingResult]);
	pendingResult = null;
	files.close();
});

describe('actual bundled Tectonic included-file diagnostics', () => {
	it('reports the real location of an error in a nested included TeX file', async () => {
		const includedPath = 'chapters/nested/included.tex';
		await fs.mkdir(path.join(root, 'chapters', 'nested'), { recursive: true });
		await fs.writeFile(path.join(root, 'main.tex'), [
			'\\documentclass{article}',
			'\\begin{document}',
			'\\input{chapters/nested/included.tex}',
			'\\end{document}'
		].join('\n') + '\n');
		await fs.writeFile(path.join(root, includedPath), [
			'% This undefined command is an intentional real-engine error.',
			'\\modutexIncludedDiagnosticUndefinedCommand'
		].join('\n') + '\n');

		const workspace = await files.open(root, 'folder');
		const entry = await files.read({ workspaceId: workspace.id, path: 'main.tex' });
		const run = await compiler.start({}, 1, {
			workspaceId: workspace.id,
			entryPath: 'main.tex',
			documentId: 'included-diagnostic-document',
			documentVersion: 0,
			savedRevision: entry.revision,
			engine: 'managed'
		});
		pendingResult = compiler.result(1, run.runId);
		const result = await pendingResult;
		expect(result.status, result.log).toBe('failure');
		if (result.status !== 'failure') throw new Error(result.log);
		expect(result.log).toContain('Undefined control sequence');
		const diagnostic = result.diagnostics.find((value) => value.path === includedPath);
		expect(diagnostic).toBeDefined();
		if (!diagnostic) throw new Error('Tectonic did not report the included file location');
		expect(diagnostic.severity).toBe('error');
		expect(diagnostic.line).toBe(2);
		expect(diagnostic.message).toContain('Undefined control sequence');
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15000);
});
