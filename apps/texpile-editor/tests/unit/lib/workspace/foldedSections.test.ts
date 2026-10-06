// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoldedSectionState } from 'modutex-contracts';

const ROOT_A = 'C:\\work\\alpha';
const ROOT_B = 'C:\\work\\beta';
const WORKSPACES_KEY = 'texpile:workspaces';

function section(relativeFile: string, occurrence = 0): FoldedSectionState {
	return {
		relativeFile,
		ancestorHeadingChain: ['Introduction'],
		level: 1,
		occurrence,
		folded: true
	};
}

const loadStore = () => import('$lib/workspace/workspaceStore');
const pathFor = (root: string, relativeFile: string) => `${root}\\${relativeFile.split('/').join('\\')}`;
function workspaceKey(root: string): string {
	const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
	return /^[a-z]:($|\/)/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

function persisted(root = ROOT_A): Record<string, unknown> {
	const all = JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
	return all[workspaceKey(root)] ?? {};
}

describe('folded section workspace state', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetModules();
	});

	it("restores a file's folded sections after the workspace store is reopened", async () => {
		const first = await loadStore();
		const path = pathFor(ROOT_A, 'chapters/intro.tex');
		const saved = [section('chapters/intro.tex'), section('chapters/intro.tex', 1)];

		first.setFoldedSections(ROOT_A, path, saved);

		vi.resetModules();
		const reopened = await loadStore();
		expect(reopened.savedFoldedSections(ROOT_A, path)).toEqual(saved);
	});

	it('isolates folded sections by workspace and relative file', async () => {
		const store = await loadStore();
		const intro = `${ROOT_A}\\chapters\\intro.tex`;
		const methods = `${ROOT_A}\\chapters\\methods.tex`;
		const betaIntro = `${ROOT_B}\\chapters\\intro.tex`;

		store.setFoldedSections(ROOT_A, intro, [section('chapters/intro.tex')]);
		store.setFoldedSections(ROOT_A, methods, [section('chapters/methods.tex')]);
		store.setFoldedSections(ROOT_B, betaIntro, [section('chapters/intro.tex', 4)]);

		expect(store.savedFoldedSections(ROOT_A, intro)).toEqual([section('chapters/intro.tex')]);
		expect(store.savedFoldedSections(ROOT_A, methods)).toEqual([section('chapters/methods.tex')]);
		expect(store.savedFoldedSections(ROOT_B, betaIntro)).toEqual([section('chapters/intro.tex', 4)]);
	});

	it('removes the final fold without deleting other workspace metadata', async () => {
		const store = await loadStore();
		const path = pathFor(ROOT_A, 'chapters/intro.tex');
		store.setLastFile(ROOT_A, path);
		store.setCompileFormat(ROOT_A, 'latex');
		store.setFoldedSections(ROOT_A, path, [section('chapters/intro.tex')]);

		store.setFoldedSections(ROOT_A, path, []);

		expect(store.savedFoldedSections(ROOT_A, path)).toEqual([]);
		expect(persisted()).toEqual({ lastFile: 'chapters/intro.tex', compile: 'latex' });
	});

	it('rejects cross-workspace, sibling-prefix, traversal, and mixed-separator paths', async () => {
		const store = await loadStore();
		const intro = pathFor(ROOT_A, 'chapters/intro.tex');
		store.setFoldedSections(ROOT_A, pathFor(ROOT_B, 'other.tex'), [section('other.tex')]);
		store.setFoldedSections(ROOT_A, 'C:\\work\\alphabet\\other.tex', [section('other.tex')]);
		store.setFoldedSections(ROOT_A, `${ROOT_A}\\chapters\\..\\outside.tex`, [section('outside.tex')]);
		store.setFoldedSections(ROOT_A, 'C:/work\\alpha/chapters\\intro.tex', [section('chapters/intro.tex')]);

		expect(store.savedFoldedSections(ROOT_A, intro)).toEqual([section('chapters/intro.tex')]);
		expect(Object.keys((persisted().foldedSections as Record<string, unknown>) ?? {})).toEqual(['chapters/intro.tex']);
	});

	it('keeps drive-letter aliases and mixed separators on one Windows workspace identity', async () => {
		const store = await loadStore();
		const aliasedRoot = 'c:/WORK/ALPHA';
		const aliasedPath = 'C:/work\\alpha/chapters\\intro.tex';
		store.setFoldedSections(ROOT_A, pathFor(ROOT_A, 'Chapters/Intro.tex'), [section('Chapters/Intro.tex')]);

		expect(store.savedFoldedSections(aliasedRoot, aliasedPath)).toEqual([section('chapters/intro.tex')]);
	});

	it('uses one case-folded identity for Windows roots and relative files, then clears every alias', async () => {
		const store = await loadStore();
		const upperRoot = 'C:\\Work\\Alpha';
		const lowerRoot = 'c:/work/alpha';
		const upperPath = 'C:\\Work\\Alpha\\Chapters\\Intro.tex';
		const lowerPath = 'c:/work/alpha/chapters/intro.tex';

		store.setFoldedSections(upperRoot, upperPath, [section('Chapters/Intro.tex')]);
		expect(store.savedFoldedSections(lowerRoot, lowerPath)).toEqual([section('chapters/intro.tex')]);
		expect(Object.keys(persisted(lowerRoot))).toEqual(['foldedSections']);
		expect(Object.keys(persisted(lowerRoot).foldedSections as Record<string, unknown>)).toEqual(['chapters/intro.tex']);

		store.setFoldedSections(lowerRoot, lowerPath, []);
		expect(store.savedFoldedSections(upperRoot, upperPath)).toEqual([]);
		expect(JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '{}')).toEqual({});
	});

	it('keeps distinct POSIX casing while folding UNC roots and relative files', async () => {
		const store = await loadStore();
		const posixUpperRoot = '/work/Alpha';
		const posixLowerRoot = '/work/alpha';
		const posixUpperPath = '/work/Alpha/Chapters/Intro.tex';
		const posixLowerPath = '/work/alpha/chapters/intro.tex';
		const uncRoot = '\\\\Server\\Share\\Alpha';
		const uncAlias = '\\\\server\\share\\alpha';
		const uncPath = '\\\\Server\\Share\\Alpha\\Chapters\\Intro.tex';
		const uncAliasPath = '\\\\server\\share\\alpha\\chapters\\intro.tex';

		store.setFoldedSections(posixUpperRoot, posixUpperPath, [section('Chapters/Intro.tex')]);
		store.setFoldedSections(posixLowerRoot, posixLowerPath, [section('chapters/intro.tex', 1)]);
		store.setFoldedSections(uncRoot, uncPath, [section('Chapters/Intro.tex')]);

		expect(store.savedFoldedSections(posixUpperRoot, posixUpperPath)).toEqual([section('Chapters/Intro.tex')]);
		expect(store.savedFoldedSections(posixLowerRoot, posixLowerPath)).toEqual([section('chapters/intro.tex', 1)]);
		expect(store.savedFoldedSections(uncAlias, uncAliasPath)).toEqual([section('chapters/intro.tex')]);
	});

	it('rejects absolute section identities from POSIX, drive, and UNC paths', async () => {
		const store = await loadStore();
		const path = pathFor(ROOT_A, 'chapters/intro.tex');
		for (const absoluteIdentity of ['/tmp/intro.tex', 'D:/other/intro.tex', '\\\\server\\share\\intro.tex']) {
			store.setFoldedSections(ROOT_A, path, [section(absoluteIdentity)]);
		}

		expect(store.savedFoldedSections(ROOT_A, path)).toEqual([]);
		expect(localStorage.getItem(WORKSPACES_KEY)).toBeNull();
	});

	it('returns defensive state and heading-chain copies', async () => {
		const store = await loadStore();
		const path = pathFor(ROOT_A, 'chapters/intro.tex');
		store.setFoldedSections(ROOT_A, path, [section('chapters/intro.tex')]);

		const firstRead = store.savedFoldedSections(ROOT_A, path);
		firstRead[0].ancestorHeadingChain.push('Mutated');
		firstRead[0].relativeFile = 'changed.tex';

		expect(store.savedFoldedSections(ROOT_A, path)).toEqual([section('chapters/intro.tex')]);
	});

	it('rejects a sparse incoming state array as one invalid write', async () => {
		const store = await loadStore();
		const path = pathFor(ROOT_A, 'chapters/intro.tex');
		const sparse = [section('chapters/intro.tex')];
		sparse.length = 2;

		store.setFoldedSections(ROOT_A, path, sparse);

		expect(store.savedFoldedSections(ROOT_A, path)).toEqual([]);
		expect(localStorage.getItem(WORKSPACES_KEY)).toBeNull();
	});

	it('canonicalizes malformed folded containers and preserves valid workspace metadata', async () => {
		localStorage.setItem(
			WORKSPACES_KEY,
			JSON.stringify({
				[workspaceKey(ROOT_A)]: {
					lastFile: 'chapters/intro.tex',
					compile: 'latex',
					foldedSections: {
						'chapters\\intro.tex': [section('chapters/intro.tex')],
						'chapters/empty.tex': [],
						'chapters/../outside.tex': [section('chapters/../outside.tex')],
						'/absolute.tex': [section('/absolute.tex')],
						'chapters/mixed.tex': [section('chapters/mixed.tex'), { ...section('chapters/mixed.tex', 1), folded: false }],
						'chapters/bad-state.tex': [null, 'not a state', { ...section('chapters/bad-state.tex'), folded: false }],
						garbage: 'not an array'
					}
				}
			})
		);
		const store = await loadStore();

		expect(store.savedFoldedSections(ROOT_A, pathFor(ROOT_A, 'chapters/intro.tex'))).toEqual([section('chapters/intro.tex')]);
		expect(persisted()).toEqual({
			lastFile: 'chapters/intro.tex',
			compile: 'latex',
			foldedSections: { 'chapters/intro.tex': [section('chapters/intro.tex')] }
		});
	});

	it.each(['string', [], null, 0, true])('removes a malformed %p folded container without touching metadata', async (container) => {
		localStorage.setItem(
			WORKSPACES_KEY,
			JSON.stringify({ [workspaceKey(ROOT_A)]: { lastFile: 'chapters/intro.tex', compile: 'latex', foldedSections: container } })
		);
		const store = await loadStore();

		expect(store.savedFoldedSections(ROOT_A, pathFor(ROOT_A, 'chapters/intro.tex'))).toEqual([]);
		expect(persisted()).toEqual({ lastFile: 'chapters/intro.tex', compile: 'latex' });
	});

	it('drops malformed workspace entries while a valid workspace keeps writing', async () => {
		localStorage.setItem(
			WORKSPACES_KEY,
			JSON.stringify({
				badNull: null,
				badArray: [],
				badString: 'not a workspace entry',
				[workspaceKey(ROOT_A)]: { lastFile: 'chapters/intro.tex' },
				[workspaceKey(ROOT_B)]: { lastFile: 'chapters/before-write.tex' }
			})
		);
		const store = await loadStore();

		expect(store.savedLastFile(ROOT_A)).toBe(pathFor(ROOT_A, 'chapters/intro.tex'));
		store.setLastFile(ROOT_B, pathFor(ROOT_B, 'chapters/after-write.tex'));

		expect(store.savedLastFile(ROOT_B)).toBe(pathFor(ROOT_B, 'chapters/after-write.tex'));
		expect(JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '{}')).toEqual({
			[workspaceKey(ROOT_A)]: { lastFile: 'chapters/intro.tex' },
			[workspaceKey(ROOT_B)]: { lastFile: 'chapters/after-write.tex' }
		});
	});

	it('fails closed for persisted Windows aliases before set, get, and clear use one identity', async () => {
		localStorage.setItem(
			WORKSPACES_KEY,
			JSON.stringify({
				'C:/work/alpha': { foldedSections: { 'chapters/intro.tex': [section('chapters/intro.tex')] } },
				'c:/WORK/ALPHA': { foldedSections: { 'chapters/intro.tex': [section('chapters/intro.tex', 1)] } }
			})
		);
		const store = await loadStore();
		const upperRoot = 'C:\\WORK\\ALPHA';
		const upperPath = 'C:\\WORK\\ALPHA\\CHAPTERS\\INTRO.TEX';

		expect(store.savedFoldedSections(upperRoot, upperPath)).toEqual([]);
		expect(JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '{}')).toEqual({});

		store.setFoldedSections(upperRoot, upperPath, [section('CHAPTERS/INTRO.TEX')]);
		expect(store.savedFoldedSections(ROOT_A, pathFor(ROOT_A, 'chapters/intro.tex'))).toEqual([section('chapters/intro.tex')]);
		store.setFoldedSections(ROOT_A, pathFor(ROOT_A, 'chapters/intro.tex'), []);

		expect(JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '{}')).toEqual({});
	});
});
