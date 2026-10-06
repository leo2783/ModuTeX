// @vitest-environment jsdom
//
// The store hydrates at MODULE INIT, so each case re-imports with localStorage already seeded.
// That is the only way to catch the bug this file exists for: MAX_RECENT was declared after the
// initializing call, so reading it from inside hit the temporal dead zone, the catch swallowed the
// ReferenceError, and the list came back empty every launch - then the first folder opened wrote
// itself over the whole history. Nothing in a normal test that imports once would have seen it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const KEY = 'texpile:recentFolders';
const load = () => import('$lib/workspace/workspaceStore');

describe('recentFolders', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetModules();
	});

	it('hydrates from localStorage at module init', async () => {
		localStorage.setItem(KEY, JSON.stringify(['/a', '/b', '/c']));
		const { recentFolders } = await load();
		expect(get(recentFolders)).toEqual(['/a', '/b', '/c']);
	});

	it('prepends a newly opened folder without losing the history', async () => {
		localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
		const { recentFolders, addRecentFolder } = await load();
		addRecentFolder('/c');
		expect(get(recentFolders)).toEqual(['/c', '/a', '/b']);
		expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['/c', '/a', '/b']);
	});

	it('moves a folder already in the list to the front rather than duplicating it', async () => {
		localStorage.setItem(KEY, JSON.stringify(['/a', '/b', '/c']));
		const { recentFolders, addRecentFolder } = await load();
		addRecentFolder('/c');
		expect(get(recentFolders)).toEqual(['/c', '/a', '/b']);
	});

	it('caps the list on read as well as write', async () => {
		localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 20 }, (_, i) => `/f${i}`)));
		const { recentFolders, addRecentFolder } = await load();
		expect(get(recentFolders)).toHaveLength(8);
		addRecentFolder('/new');
		expect(get(recentFolders)).toHaveLength(8);
		expect(get(recentFolders)[0]).toBe('/new');
	});

	it('survives junk in storage rather than throwing at import', async () => {
		localStorage.setItem(KEY, '{not json');
		const { recentFolders } = await load();
		expect(get(recentFolders)).toEqual([]);
	});

	it('drops non-string entries', async () => {
		localStorage.setItem(KEY, JSON.stringify(['/a', 42, null, '/b']));
		const { recentFolders } = await load();
		expect(get(recentFolders)).toEqual(['/a', '/b']);
	});
});
