// @vitest-environment jsdom
// Restoring the last-open file per workspace: the remembered path has to come back in a form the
// rest of the app can compare against, not merely one the filesystem will accept.
import { describe, expect, it, beforeEach } from 'vitest';
import { savedLastFile, setLastFile } from '$lib/workspace/workspaceStore';

describe('savedLastFile', () => {
	beforeEach(() => localStorage.clear());

	// What the OS directory scan hands the file tree: the root's own separator throughout.
	const treePath = (root: string, rel: string) => (root.includes('\\') ? `${root}\\${rel.split('/').join('\\')}` : `${root}/${rel}`);

	it.each([
		['C:\\dev\\proj', 'main.tex'],
		['C:\\dev\\proj', 'sub/ch1.tex'],
		['/home/u/proj', 'main.tex'],
		['/home/u/proj', 'sub/ch1.tex']
	])('round-trips %s + %s in the tree\u2019s own path form', (root, rel) => {
		const abs = treePath(root, rel);
		setLastFile(root, abs);
		// Strict equality on purpose. It used to come back "C:/dev/proj\main.tex" -- the root
		// forward-slashed, the tail backslash-joined -- which every fs call accepts and no string
		// comparison matches, so the restored file never highlighted as open in the tree.
		expect(savedLastFile(root)).toBe(abs);
	});

	it('returns null for a folder it has never recorded', () => {
		expect(savedLastFile('C:\\dev\\other')).toBeNull();
	});

	it('keeps a separate entry per workspace', () => {
		setLastFile('C:\\a', 'C:\\a\\one.tex');
		setLastFile('C:\\b', 'C:\\b\\two.tex');
		expect(savedLastFile('C:\\a')).toBe('C:\\a\\one.tex');
		expect(savedLastFile('C:\\b')).toBe('C:\\b\\two.tex');
	});

	it('ignores a file that is not under the root, rather than recording a cross-root path', () => {
		setLastFile('C:\\a', 'C:\\elsewhere\\stray.tex');
		expect(savedLastFile('C:\\a')).toBeNull();
	});
});
