import fs from 'node:fs';
import { resolve } from 'node:path';
import { loadProjectFromDirectory } from '@inlang/sdk';
import { compileProject } from '@inlang/paraglide-js';

const editor = resolve(import.meta.dirname, '..');
const projectPath = resolve(editor, 'project.inlang');
const outdir = resolve(editor, 'src/lib/paraglide');

async function assertNoProjectErrors(project) {
	const errors = await project.errors.get();
	if (errors.length) {
		throw new AggregateError(errors, 'Inlang project loading failed', { cause: errors[0] });
	}
}

// The stock CLI logs SDK loader errors as warnings. Fail on them before writing
// output, and remove stale modules so a failed sync cannot leave usable artifacts.
await fs.promises.rm(outdir, { recursive: true, force: true });
let project;
try {
	project = await loadProjectFromDirectory({ path: projectPath, fs });
	await assertNoProjectErrors(project);
	const output = await compileProject({
		project,
		projectPath,
		compilerOptions: { emitTsDeclarations: true }
	});
	await assertNoProjectErrors(project);
	// The package writer uses allSettled without propagating write failures.
	// Write the real compiler's files directly so filesystem errors also fail sync.
	for (const [file, content] of Object.entries(output)) {
		const target = resolve(outdir, file);
		await fs.promises.mkdir(resolve(target, '..'), { recursive: true });
		await fs.promises.writeFile(target, content);
	}
} catch (error) {
	await fs.promises.rm(outdir, { recursive: true, force: true });
	throw error;
} finally {
	await project?.close();
}
console.log('Paraglide generation complete (including TypeScript declarations).');
