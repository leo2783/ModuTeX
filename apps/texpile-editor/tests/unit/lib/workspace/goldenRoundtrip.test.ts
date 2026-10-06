import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schema } from '$lib/schema/schema';
import { detectEol, toLf } from '$lib/workspace/fileSystem';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';
import { SavePipeline, type SaveDeps } from '$lib/workspace/savePipeline.svelte';

const CORPUS = fileURLToPath(new URL('../../../fixtures/roundtrip/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../../..', import.meta.url));
const GOLDEN_FIXTURES: Readonly<
	Record<
		string,
		Readonly<{
			bytes: number;
			sha256: string;
			indexEol: 'lf' | 'crlf';
			bom: boolean;
			finalNewline: boolean;
			trailingSpaceLines: number;
		}>
	>
> = {
	'bom-unicode.tex': {
		bytes: 169,
		sha256: '16876b1fa12b89e1e59d87be817b2f3314028596e4394bac3b9ba869355f6f6b',
		indexEol: 'lf',
		bom: true,
		finalNewline: true,
		trailingSpaceLines: 0
	},
	'crlf-comments.tex': {
		bytes: 315,
		sha256: '241cc4510696a8e480e10cbb44e7eb467def08e6ed18765c255901f9a0753640',
		indexEol: 'crlf',
		bom: false,
		finalNewline: true,
		trailingSpaceLines: 1
	},
	'diagram-markers.tex': {
		bytes: 617,
		sha256: 'a63776e03187c14c82db99c18f4734aa83848f3e8823229aaee2fa0feaa2db34',
		indexEol: 'lf',
		bom: false,
		finalNewline: true,
		trailingSpaceLines: 0
	},
	'fragment-no-final-newline.tex': {
		bytes: 82,
		sha256: '9e4aa150a3b229f2a9d72f7bf0636c33ccbec4b7636afdb3506523cdf5ae2ad4',
		indexEol: 'lf',
		bom: false,
		finalNewline: false,
		trailingSpaceLines: 0
	},
	'lf-complex.tex': {
		bytes: 890,
		sha256: 'cc054a4283161dd989c66fe3d97b7956704f219a1dd16a203cc3eed708c161d4',
		indexEol: 'lf',
		bom: false,
		finalNewline: true,
		trailingSpaceLines: 0
	},
	'malformed-source.tex': {
		bytes: 125,
		sha256: 'c61c531fa97688236cca4d2d543c4097cc442354b43fd5e4bfaf4736d3c677b9',
		indexEol: 'lf',
		bom: false,
		finalNewline: true,
		trailingSpaceLines: 0
	}
};

const fixtures = readdirSync(CORPUS, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith('.tex'))
	.map((entry) => entry.name)
	.sort();

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function trackedIndexEol(relativePath: string): 'lf' | 'crlf' {
	const output = execFileSync('git', ['ls-files', '--eol', '--', relativePath], {
		cwd: REPO_ROOT,
		encoding: 'utf8'
	}).trim();
	const value = output.match(/^i\/(lf|crlf)\s/)?.[1];
	if (value !== 'lf' && value !== 'crlf') throw new Error(`missing index EOL metadata for ${relativePath}`);
	return value;
}

function trailingSpaceLines(bytes: Uint8Array): number {
	return bytes
		.toString()
		.split('\n')
		.filter((line) => /[ \t]\r?$/.test(line)).length;
}

async function saveThroughProductionBoundary(content: string, eol: '\n' | '\r\n'): Promise<Buffer> {
	let saved: Buffer | undefined;
	const path = '/golden/main.tex';
	let baseline: string | undefined;
	let dirty = true;
	const stamped: string[] = [];
	const deps: SaveDeps = {
		autosaveActive: () => false,
		writeText: async (_path, diskContent) => {
			saved = Buffer.from(diskContent, 'utf8');
		},
		getEol: () => eol,
		getLoadedPath: () => path,
		getLiveContent: () => content,
		setDiskBaseline: (value) => {
			baseline = value;
		},
		setDirty: (value) => {
			dirty = value;
		},
		diskChanged: async () => false,
		recordDiskStamp: async (value) => {
			stamped.push(value);
		},
		raiseConflict: () => {}
	};
	await new SavePipeline(deps).enqueueWithEol(path, content, false, eol);
	if (!saved) throw new Error('production save boundary did not write the golden fixture');
	expect(baseline).toBe(content);
	expect(dirty).toBe(false);
	expect(stamped).toEqual([path]);
	return saved;
}

describe('ModuTeX golden round-trip corpus', () => {
	it('contains only the independently hashed fixtures required by the plan', () => {
		expect(fixtures).toEqual(Object.keys(GOLDEN_FIXTURES).sort());

		for (const name of fixtures) {
			const input = readFileSync(`${CORPUS}/${name}`);
			const expected = GOLDEN_FIXTURES[name];
			expect(input.length, `${name} fixture length changed`).toBe(expected.bytes);
			expect(sha256(input), `${name} fixture bytes changed`).toBe(expected.sha256);
			expect(trackedIndexEol(`apps/texpile-editor/tests/fixtures/roundtrip/${name}`)).toBe(expected.indexEol);
			expect(input.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(expected.bom);
			expect(input.at(-1) === 0x0a).toBe(expected.finalNewline);
			expect(trailingSpaceLines(input)).toBe(expected.trailingSpaceLines);
		}

		const crlf = readFileSync(`${CORPUS}/crlf-comments.tex`);
		expect(crlf.includes(Buffer.from('\r\n'))).toBe(true);
		expect(crlf.includes(Buffer.from('spaces.  \r\n'))).toBe(true);
		const bom = readFileSync(`${CORPUS}/bom-unicode.tex`);
		expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const fragment = readFileSync(`${CORPUS}/fragment-no-final-newline.tex`);
		expect(fragment.at(-1)).not.toBe(0x0a);
	});

	it('covers the planned structural and raw syntax classes', () => {
		const complex = readFileSync(`${CORPUS}/lf-complex.tex`, 'utf8');
		for (const token of [
			'\\newcommand',
			'\\begin{custompackageenv}[mode=x]',
			'\\begin{nested-unknown}',
			'\\begin{verbatim}',
			'\\begin{figure*}[htbp]',
			'\\begin{align*}',
			'\\begin{tabular}{lr}',
			'\\begin{lstlisting}[language=TeX]',
			'\\cite[p.~4]{sample}',
			'繁體中文、Unicode αβγ'
		]) {
			expect(complex).toContain(token);
		}

		const diagrams = readFileSync(`${CORPUS}/diagram-markers.tex`, 'utf8');
		expect(diagrams).toContain('% modutex:diagram {"v":1');
		expect(diagrams).toContain('% modutex:diagram {"v":9');
	});

	it.each(fixtures)('%s is schema-valid and byte-identical after an untouched production save', async (name) => {
		const input = readFileSync(`${CORPUS}/${name}`);
		const raw = input.toString('utf8');
		const eol = detectEol(raw);
		const source = toLf(raw);
		const parsed = parseLatexFile(source);
		expect(() => parsed.doc.check()).not.toThrow();

		// The worker transports parser output as JSON before the editor save path rehydrates it.
		const rehydrated = schema.nodeFromJSON(parsed.doc.toJSON());
		const outputLf = serializeLatexFile(parsed, rehydrated);
		const output = await saveThroughProductionBoundary(outputLf, eol);

		expect(sha256(output)).toBe(GOLDEN_FIXTURES[name].sha256);
		expect(output.equals(input)).toBe(true);
	});

	it('keeps trailing-whitespace validation active outside the byte fixtures', () => {
		const temp = mkdtempSync(join(tmpdir(), 'texpile-diff-check-'));
		const clean = join(temp, 'clean.tex');
		const dirty = join(temp, 'dirty.tex');
		writeFileSync(clean, '\\section{A}\n');
		writeFileSync(dirty, '\\section{A}  \n');

		try {
			let status = 0;
			let diagnostic = '';
			try {
				execFileSync('git', ['diff', '--no-index', '--check', clean, dirty], {
					cwd: REPO_ROOT,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe']
				});
			} catch (error) {
				const result = error as { status?: number; stdout?: string; stderr?: string };
				status = result.status ?? 0;
				diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`;
			}

			expect(status).not.toBe(0);
			expect(diagnostic).toMatch(/trailing whitespace/);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it('preserves unsupported commands and nested environments as raw LaTeX', () => {
		const input = readFileSync(`${CORPUS}/lf-complex.tex`, 'utf8');
		const parsed = parseLatexFile(input);
		expect(parsed.warnings).not.toEqual([]);
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(input);
	});
});
