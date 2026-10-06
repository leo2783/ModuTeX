import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fragment } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { schema } from '$lib/schema/schema';
import { detectEol, toLf } from '$lib/workspace/fileSystem';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';
import { SavePipeline, type SaveDeps } from '$lib/workspace/savePipeline.svelte';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const variants = [false, true].flatMap((bom) =>
	['\n', '\r\n'].flatMap((eol) =>
		[false, true].flatMap((comments) =>
			[0, 1, 2, 3].map((finalLf) => ({
				name: `${eol === '\n' ? 'LF' : 'CRLF'}, BOM=${bom}, comments=${comments}, EOF=${finalLf}`,
				source: (
					`${bom ? '\uFEFF' : ''}\\documentclass{article}\n% preamble spaces  \t\n\\begin{document}\nOriginal body.\n\\end{document}` +
					(comments ? '\n% postamble comment  \t\n% final comment  \t' : '') +
					'\n'.repeat(finalLf)
				).replace(/\n/g, eol)
			}))
		)
	)
);

// Real disk adapters for the existing SavePipeline; no Electron IPC/native GUI is exercised.
async function parseAndSave(path: string, edit = false) {
	const before = await readFile(path);
	const raw = before.toString('utf8');
	const parsed = parseLatexFile(toLf(raw));
	expect(parsed.hadDocumentEnv).toBe(true);
	let doc = schema.nodeFromJSON(JSON.parse(JSON.stringify(parsed.doc.toJSON())));
	doc.check();
	if (edit) {
		const children = Array.from({ length: doc.childCount }, (_, index) => doc.child(index));
		const index = children.findIndex((child) => child.type.name === 'paragraph' && child.textContent === 'Original body.');
		expect(index).toBeGreaterThanOrEqual(0);
		const child = children[index];
		children[index] = child.type.create(child.attrs, schema.text('Edited body.'), child.marks);
		doc = doc.copy(Fragment.fromArray(children));
		doc.check();
	}
	const content = serializeLatexFile(parsed, doc);
	let diskBaseline = before;
	let baseline: string | undefined;
	let dirty = true;
	let stamped = false;
	const deps: SaveDeps = {
		autosaveActive: () => false,
		writeText: (destination, value) => writeFile(destination, value, 'utf8'),
		getEol: () => detectEol(raw),
		getLoadedPath: () => path,
		getLiveContent: () => content,
		setDiskBaseline: (value) => {
			baseline = value;
		},
		setDirty: (value) => {
			dirty = value;
		},
		diskChanged: async (destination) => !(await readFile(destination)).equals(diskBaseline),
		recordDiskStamp: async (destination) => {
			diskBaseline = await readFile(destination);
			stamped = true;
		},
		raiseConflict: () => {
			throw new Error('unexpected disk conflict');
		}
	};
	const pipeline = new SavePipeline(deps);
	await pipeline.enqueue(path, content, false);
	await pipeline.whenIdle();
	expect(stamped).toBe(true);
	expect(baseline).toBe(content);
	expect(dirty).toBe(false);
	const after = await readFile(path);
	expect(after.equals(diskBaseline)).toBe(true);
	return { parsed, after };
}

async function withFile(source: string, action: (path: string, input: Buffer) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-postamble-'));
	const path = join(directory, 'main.tex');
	try {
		await writeFile(path, source, 'utf8');
		await action(path, await readFile(path));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('wrapped document postamble bytes through parser/JSON/serializer/SavePipeline and disk', () => {
	it.each(variants)('untouched $name retains SHA and EOF over three saves', async ({ source }) => {
		await withFile(source, async (path, input) => {
			for (let cycle = 0; cycle < 3; cycle++) {
				const { after } = await parseAndSave(path);
				expect(after.equals(input)).toBe(true);
				expect(sha256(after)).toBe(sha256(input));
			}
		});
	});

	it.each(variants)('body edit $name leaves preamble/postamble exact and reaches a fixed point', async ({ source }) => {
		await withFile(source, async (path, input) => {
			const { parsed, after } = await parseAndSave(path, true);
			expect(after.equals(input)).toBe(false);
			const eol = detectEol(source);
			const preambleBytes = Buffer.from(parsed.preamble.replace(/\n/g, eol), 'utf8');
			const postambleBytes = Buffer.from(parsed.postamble.replace(/\n/g, eol), 'utf8');
			expect(after.subarray(0, preambleBytes.length).equals(preambleBytes)).toBe(true);
			expect(after.subarray(after.length - postambleBytes.length).equals(postambleBytes)).toBe(true);
			expect(after.toString('utf8')).toContain('Edited body.');
			expect(after.toString('utf8')).not.toContain('Original body.');
			const reparsed = parseLatexFile(toLf(after.toString('utf8')));
			expect(reparsed.preamble).toBe(parsed.preamble);
			expect(reparsed.postamble).toBe(parsed.postamble);
			for (let cycle = 0; cycle < 2; cycle++) {
				const saved = await parseAndSave(path);
				expect(saved.after.equals(after)).toBe(true);
				expect(sha256(saved.after)).toBe(sha256(after));
			}
		});
	});
});
