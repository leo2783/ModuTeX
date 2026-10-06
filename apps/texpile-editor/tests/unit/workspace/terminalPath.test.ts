// The terminal's PATH must include whatever Preferences points at, or a configured tinymist works
// everywhere EXCEPT the compile command - see withPathDirs' own comment.
import { describe, it, expect } from 'vitest';
import { withPathDirs } from '../../../../../electron/src/toolchain';

const win = process.platform === 'win32';
const SEP = win ? ';' : ':';

describe('withPathDirs', () => {
	it('prepends the directory, so it beats a stale copy already on PATH', () => {
		const env = withPathDirs({ PATH: `/usr/bin${SEP}/bin` }, ['/opt/tinymist']);
		expect(env.PATH).toBe(`/opt/tinymist${SEP}/usr/bin${SEP}/bin`);
	});

	it('keeps the original env intact', () => {
		const base = { PATH: '/bin', HOME: '/home/x' };
		const env = withPathDirs(base, ['/opt/t']);
		expect(env.HOME).toBe('/home/x');
		expect(base.PATH).toBe('/bin'); // not mutated
	});

	it('returns a copy, not the same object, when there is nothing to add', () => {
		const base = { PATH: '/bin' };
		const env = withPathDirs(base, []);
		expect(env).toEqual(base);
		expect(env).not.toBe(base);
	});

	it('ignores empty and whitespace-only entries', () => {
		const env = withPathDirs({ PATH: '/bin' }, ['', '   ', null, undefined]);
		expect(env.PATH).toBe('/bin');
	});

	it('adds several directories in order', () => {
		const env = withPathDirs({ PATH: '/bin' }, ['/a', '/b']);
		expect(env.PATH).toBe(`/a${SEP}/b${SEP}/bin`);
	});

	it('does not re-add a directory already on PATH', () => {
		// the terminal can be respawned many times in a session; PATH must not grow each time
		const env = withPathDirs({ PATH: `/opt/t${SEP}/bin` }, ['/opt/t']);
		expect(env.PATH).toBe(`/opt/t${SEP}/bin`);
	});

	it('copes with a missing PATH', () => {
		const env = withPathDirs({ HOME: '/h' }, ['/opt/t']);
		expect(env.PATH).toBe('/opt/t');
	});

	it.runIf(win)('extends the existing `Path` key rather than adding a second one', () => {
		// Windows env lookup is case-insensitive but a JS object is not: writing PATH beside an
		// existing Path yields two keys, and the child would read the one we did NOT set
		const env = withPathDirs({ Path: 'C:\\Windows' }, ['C:\\tools']);
		expect(env.Path).toBe(`C:\\tools;C:\\Windows`);
		expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toHaveLength(1);
	});

	it.runIf(win)('treats Windows paths case-insensitively when deduping', () => {
		const env = withPathDirs({ Path: 'C:\\Tools' }, ['c:\\tools']);
		expect(env.Path).toBe('C:\\Tools');
	});
});
