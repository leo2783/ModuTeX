import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
	captureCompileInputs,
	compareCompileInputManifests,
	assertCompileInputsCurrent,
	checkCompileInputsCurrent,
	DEFAULT_TREE_DEPTH_LIMIT,
	DEFAULT_TREE_ENTRY_LIMIT,
	DEFAULT_FILE_BYTES_LIMIT,
	DEFAULT_TOTAL_BYTES_LIMIT,
	type CompileAuthority
} from '../src/frontend-compile-inputs';

describe('bounded real filesystem compile-input revision manifest', () => {
	let directory: string;
	let validAuthority: boolean;

	function createAuthority(root: string = directory): CompileAuthority {
		return {
			root,
			assertCurrent: () => {
				if (!validAuthority) throw new Error('STALE_WORKSPACE');
			}
		};
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-compile-inputs-'));
		validAuthority = true;
	});

	afterEach(async () => {
		if (
			!path.basename(directory).startsWith('modutex-compile-inputs-') ||
			path.dirname(directory) !== os.tmpdir()
		) {
			throw new Error('Unsafe cleanup path');
		}
		await fs.rm(directory, { recursive: true, force: true });
	});

	it('captures all local resources with stable relative paths, content hashes and physical identities', async () => {
		await fs.writeFile(path.join(directory, 'main.tex'), '\\documentclass{article}\n\\begin{document}Hello\\end{document}');
		await fs.mkdir(path.join(directory, 'sections'));
		await fs.writeFile(path.join(directory, 'sections', 'intro.tex'), '\\section{Intro}');
		await fs.mkdir(path.join(directory, 'assets'));
		await fs.writeFile(path.join(directory, 'assets', 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		await fs.writeFile(path.join(directory, 'references.bib'), '@article{test, title={Test}}');
		await fs.writeFile(path.join(directory, 'custom.sty'), '\\ProvidesPackage{custom}');

		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		expect(manifest.root).toBe(directory);
		expect(manifest.rootDev).toBeTypeOf('bigint');
		expect(manifest.rootIno).toBeTypeOf('bigint');
		expect(manifest.manifestRevision).toMatch(/^sha256:[a-f0-9]{64}$/);

		const paths = manifest.entries.map((e) => e.path);
		expect(paths).toEqual([
			'assets/diagram.png',
			'custom.sty',
			'main.tex',
			'references.bib',
			'sections/intro.tex'
		]);

		const dirPaths = manifest.directories.map((d) => d.path);
		expect(dirPaths).toEqual(['', 'assets', 'sections']);

		for (const entry of manifest.entries) {
			expect(entry.dev).toBeTypeOf('bigint');
			expect(entry.ino).toBeTypeOf('bigint');
			expect(entry.size).toBeGreaterThan(0n);
			expect(entry.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(entry.path).not.toContain('\\');
		}

		expect(manifest.totalBytes).toBeGreaterThan(0n);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest.entries)).toBe(true);
		expect(Object.isFrozen(manifest.directories)).toBe(true);
	});

	it('excludes output, .git, and node_modules directories and nested files but includes files named output.tex', async () => {
		await fs.writeFile(path.join(directory, 'main.tex'), 'main');
		await fs.writeFile(path.join(directory, 'output.tex'), 'this is a tex file named output');

		// create output/ dir with artifacts
		await fs.mkdir(path.join(directory, 'output'));
		await fs.writeFile(path.join(directory, 'output', 'main.pdf'), '%PDF-1.7');
		await fs.writeFile(path.join(directory, 'output', 'main.log'), 'compile log');
		await fs.mkdir(path.join(directory, 'output', 'cache'));
		await fs.writeFile(path.join(directory, 'output', 'cache', 'state.bin'), 'cache');

		// create .git/ dir
		await fs.mkdir(path.join(directory, '.git'));
		await fs.writeFile(path.join(directory, '.git', 'config'), 'git config');
		await fs.writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main');

		// create node_modules/ dir
		await fs.mkdir(path.join(directory, 'node_modules'));
		await fs.mkdir(path.join(directory, 'node_modules', 'pkg'));
		await fs.writeFile(path.join(directory, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');

		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		const paths = manifest.entries.map((e) => e.path);
		expect(paths).toEqual(['main.tex', 'output.tex']);

		const dirPaths = manifest.directories.map((d) => d.path);
		expect(dirPaths).toEqual(['']);

		// Verify output modifications do not mark manifest stale
		await fs.writeFile(path.join(directory, 'output', 'main.pdf'), '%PDF-1.7 modified');
		await fs.writeFile(path.join(directory, 'output', 'new-artifact.aux'), 'aux');
		await expect(assertCompileInputsCurrent(authority, manifest)).resolves.toBeUndefined();
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(true);
	});

	it('includes ordinary files named output, .git, or node_modules and detects their changes', async () => {
		for (const name of ['output', '.git', 'node_modules']) {
			await fs.writeFile(path.join(directory, name), 'ordinary file');
		}
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);
		expect(manifest.entries.map((entry) => entry.path)).toEqual(['.git', 'node_modules', 'output']);

		await fs.writeFile(path.join(directory, 'output'), 'changed ordinary file');
		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
	});

	it('rejects real directory junctions and symlinks with LINK_NOT_ALLOWED', async () => {
		await fs.mkdir(path.join(directory, 'real-dir'));
		await fs.writeFile(path.join(directory, 'real-dir', 'file.tex'), 'hello');

		// Create directory junction/symlink
		const linkTarget = path.join(directory, 'real-dir');
		const linkPath = path.join(directory, 'linked-dir');
		await fs.symlink(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

		const authority = createAuthority();
		await expect(captureCompileInputs(authority)).rejects.toThrow('LINK_NOT_ALLOWED');
	});

	it('rejects directory junction targeting outside workspace with LINK_NOT_ALLOWED', async () => {
		const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-outside-'));
		try {
			await fs.writeFile(path.join(outsideDir, 'secret.tex'), 'secret');
			const linkPath = path.join(directory, 'escape');
			await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

			const authority = createAuthority();
			await expect(captureCompileInputs(authority)).rejects.toThrow('LINK_NOT_ALLOWED');
		} finally {
			await fs.rm(outsideDir, { recursive: true, force: true });
		}
	});

	it('rejects replaced root directory with STALE_WORKSPACE', async () => {
		await fs.writeFile(path.join(directory, 'main.tex'), 'content');
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		// Recreate root directory at same path with new physical inode
		await fs.rm(directory, { recursive: true, force: true });
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, 'main.tex'), 'content');

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(false);
	});

	it('rejects parent directory replacement with STALE_WORKSPACE', async () => {
		const parentPath = path.join(directory, 'chapters');
		await fs.mkdir(parentPath);
		await fs.writeFile(path.join(parentPath, 'ch1.tex'), 'chapter 1');

		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		// Replace parent directory
		await fs.rm(parentPath, { recursive: true, force: true });
		await fs.mkdir(parentPath);
		await fs.writeFile(path.join(parentPath, 'ch1.tex'), 'chapter 1');

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
	});

	it('rejects root or parent directory replaced by a symlink/junction with LINK_NOT_ALLOWED', async () => {
		const parentPath = path.join(directory, 'chapters');
		await fs.mkdir(parentPath);
		await fs.writeFile(path.join(parentPath, 'ch1.tex'), 'chapter 1');

		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		const otherPath = path.join(directory, 'other');
		await fs.mkdir(otherPath);
		await fs.writeFile(path.join(otherPath, 'ch1.tex'), 'chapter 1');

		// Replace chapters with junction
		await fs.rm(parentPath, { recursive: true, force: true });
		await fs.symlink(otherPath, parentPath, process.platform === 'win32' ? 'junction' : 'dir');

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('LINK_NOT_ALLOWED');
	});

	it('enforces bounded tree depth limit with TREE_TOO_DEEP', async () => {
		let current = directory;
		for (let i = 0; i < 4; i++) {
			current = path.join(current, `level-${i}`);
			await fs.mkdir(current);
		}
		await fs.writeFile(path.join(current, 'deep.tex'), 'deep');

		const authority = createAuthority();
		await expect(captureCompileInputs(authority, { maxTreeDepth: 2 })).rejects.toThrow('TREE_TOO_DEEP');

		// With default limit (16) it succeeds
		const manifest = await captureCompileInputs(authority);
		expect(manifest.entries).toHaveLength(1);
	});

	it('enforces bounded tree entry limit with TREE_TOO_LARGE', async () => {
		for (let i = 0; i < 5; i++) {
			await fs.writeFile(path.join(directory, `file-${i}.tex`), `file ${i}`);
		}
		const authority = createAuthority();
		await expect(captureCompileInputs(authority, { maxTreeEntries: 3 })).rejects.toThrow('TREE_TOO_LARGE');

		const manifest = await captureCompileInputs(authority, { maxTreeEntries: 10 });
		expect(manifest.entries).toHaveLength(5);
	});

	it('enforces bounded per-file byte limit with FILE_TOO_LARGE', async () => {
		await fs.writeFile(path.join(directory, 'large.tex'), Buffer.alloc(1024, 0x41));
		const authority = createAuthority();
		await expect(captureCompileInputs(authority, { maxFileBytes: 512 })).rejects.toThrow('FILE_TOO_LARGE');

		const manifest = await captureCompileInputs(authority, { maxFileBytes: 2048 });
		expect(manifest.entries).toHaveLength(1);
	});

	it('enforces bounded total workspace bytes limit with FILE_TOO_LARGE', async () => {
		await fs.writeFile(path.join(directory, 'a.tex'), Buffer.alloc(400, 0x41));
		await fs.writeFile(path.join(directory, 'b.tex'), Buffer.alloc(400, 0x42));
		const authority = createAuthority();
		await expect(captureCompileInputs(authority, { maxTotalBytes: 600 })).rejects.toThrow('FILE_TOO_LARGE');

		const manifest = await captureCompileInputs(authority, { maxTotalBytes: 1000 });
		expect(manifest.entries).toHaveLength(2);
	});

	it('detects stale on before/after additions', async () => {
		await fs.writeFile(path.join(directory, 'main.tex'), 'main');
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		await fs.writeFile(path.join(directory, 'added.tex'), 'new file');

		const diff = compareCompileInputManifests(manifest, await captureCompileInputs(authority));
		expect(diff.isStale).toBe(true);
		expect(diff.added).toEqual(['added.tex']);
		expect(diff.removed).toEqual([]);

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(false);
	});

	it('detects stale on before/after removals', async () => {
		await fs.writeFile(path.join(directory, 'main.tex'), 'main');
		await fs.writeFile(path.join(directory, 'removed.tex'), 'will be removed');
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		await fs.unlink(path.join(directory, 'removed.tex'));

		const diff = compareCompileInputManifests(manifest, await captureCompileInputs(authority));
		expect(diff.isStale).toBe(true);
		expect(diff.removed).toEqual(['removed.tex']);
		expect(diff.added).toEqual([]);

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(false);
	});

	it('detects stale on before/after content changes', async () => {
		const target = path.join(directory, 'main.tex');
		await fs.writeFile(target, 'initial content');
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		await fs.writeFile(target, 'modified content');

		const diff = compareCompileInputManifests(manifest, await captureCompileInputs(authority));
		expect(diff.isStale).toBe(true);
		expect(diff.modifiedContent).toEqual(['main.tex']);

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(false);
	});

	it('detects stale on same-byte identity replacement', async () => {
		const target = path.join(directory, 'chapter.tex');
		const bytes = Buffer.from('identical bytes across replacement');
		await fs.writeFile(target, bytes);
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		// Replace file on disk with identical bytes but distinct physical inode/timestamps
		await fs.unlink(target);
		await fs.writeFile(target, bytes);

		const updated = await captureCompileInputs(authority);
		const diff = compareCompileInputManifests(manifest, updated);

		// Inode or mtimeNs/ctimeNs changed even though content hash is identical
		expect(diff.isStale).toBe(true);
		expect(diff.replacedIdentity).toEqual(['chapter.tex']);
		expect(diff.modifiedContent).toEqual([]);

		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(false);
	});

	it('rejects when authority is revoked', async () => {
		await fs.writeFile(path.join(directory, 'main.tex'), 'content');
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		validAuthority = false;
		await expect(assertCompileInputsCurrent(authority, manifest)).rejects.toThrow('STALE_WORKSPACE');
		await expect(captureCompileInputs(authority)).rejects.toThrow('STALE_WORKSPACE');
		expect(await checkCompileInputsCurrent(authority, manifest)).toBe(false);
	});

	it('detects same-byte identity replacement during actual operations using deterministic barrier', async () => {
		let inFlightResolve!: () => void;
		let barrierResume!: () => void;
		const enteredBarrier = new Promise<void>((resolve) => {
			inFlightResolve = resolve;
		});
		const continueBarrier = new Promise<void>((resolve) => {
			barrierResume = resolve;
		});

		const filePath = path.join(directory, 'chapter.tex');
		const bytes = Buffer.from('deterministic barrier payload');
		await fs.writeFile(filePath, bytes);

		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		let barrierArmed = true;
		const verificationPromise = assertCompileInputsCurrent(authority, manifest, {
			barrier: async () => {
				if (barrierArmed) {
					barrierArmed = false;
					inFlightResolve();
					await continueBarrier;
				}
			}
		});

		// Wait deterministically for verification to reach the actual barrier
		await enteredBarrier;

		// Concurrently execute actual filesystem operation: same-byte replacement
		await fs.unlink(filePath);
		await fs.writeFile(filePath, bytes);

		// Resume verification through the barrier
		barrierResume();

		// Verification must detect the stale physical identity and throw STALE_WORKSPACE
		await expect(verificationPromise).rejects.toThrow('STALE_WORKSPACE');
	});

	it('rejects a nested directory replaced after capture but before recursion opens it', async () => {
		const parentPath = path.join(directory, 'chapters');
		await fs.mkdir(parentPath);
		await fs.writeFile(path.join(parentPath, 'chapter.tex'), 'Chapter.');

		let entered!: () => void;
		let resume!: () => void;
		const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
		const continueBarrier = new Promise<void>((resolve) => { resume = resolve; });
		let paused = false;
		const capture = captureCompileInputs(createAuthority(), {
			barrier: async (point) => {
				if (!paused && point.kind === 'directory' && point.path === 'chapters') {
					paused = true;
					entered();
					await continueBarrier;
				}
			}
		});

		try {
			await Promise.race([enteredBarrier, capture.then(() => {
				throw new Error('Capture completed before the directory barrier');
			})]);
			await fs.rename(parentPath, path.join(directory, 'chapters-held'));
			await fs.mkdir(parentPath);
			await fs.writeFile(path.join(parentPath, 'chapter.tex'), 'Chapter.');
		} finally {
			resume();
		}
		await expect(capture).rejects.toThrow('STALE_WORKSPACE');
	});

	it('rejects a same-byte file replacement at the held-file open barrier', async () => {
		const filePath = path.join(directory, 'chapter.tex');
		const bytes = Buffer.from('same bytes');
		await fs.writeFile(filePath, bytes);
		const authority = createAuthority();
		const manifest = await captureCompileInputs(authority);

		let entered!: () => void;
		let resume!: () => void;
		const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
		const continueBarrier = new Promise<void>((resolve) => { resume = resolve; });
		let paused = false;
		const verification = assertCompileInputsCurrent(authority, manifest, {
			barrier: async (point) => {
				if (!paused && point.kind === 'file' && point.path === 'chapter.tex') {
					paused = true;
					entered();
					await continueBarrier;
				}
			}
		});

		try {
			await Promise.race([enteredBarrier, verification.then(() => {
				throw new Error('Verification completed before the file barrier');
			})]);
			await fs.unlink(filePath);
			await fs.writeFile(filePath, bytes);
		} finally {
			resume();
		}
		await expect(verification).rejects.toThrow('STALE_WORKSPACE');
	});
});
