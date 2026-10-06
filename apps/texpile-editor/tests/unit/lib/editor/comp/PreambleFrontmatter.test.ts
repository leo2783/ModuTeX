// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PreambleFrontmatter from '../../../../../src/lib/editor/comp/PreambleFrontmatter.svelte';

let host: HTMLDivElement;
let app: Record<string, unknown> | null = null;

afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	host?.remove();
});

describe('PreambleFrontmatter title creation', () => {
	it('offers one paper-title action when no active title exists', () => {
		const onAddTitle = vi.fn();
		host = document.body.appendChild(document.createElement('div'));
		app = mount(PreambleFrontmatter, {
			target: host,
			props: { preamble: '\\documentclass{article}\n', onAddTitle }
		});
		flushSync();

		const button = host.querySelector<HTMLButtonElement>('button');
		expect(button?.textContent?.trim()).toBe('Add a paper title');
		button!.click();
		expect(onAddTitle).toHaveBeenCalledOnce();
	});

	it('disables edits to an existing title in read-only mode', () => {
		host = document.body.appendChild(document.createElement('div'));
		app = mount(PreambleFrontmatter, {
			target: host,
			props: {
				preamble: '\\documentclass{article}\n\\title{Plain title}\n',
				disabled: true,
				onAddTitle: vi.fn()
			}
		});
		flushSync();

		expect(host.querySelector('button')).toBeNull();
		expect(host.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
	});

	it('does not duplicate an active complex title that remains in source mode', () => {
		host = document.body.appendChild(document.createElement('div'));
		app = mount(PreambleFrontmatter, {
			target: host,
			props: {
				preamble: '\\documentclass{article}\n\\title{A \\textbf{complex} title}\n',
				onAddTitle: vi.fn()
			}
		});
		flushSync();

		expect(host.querySelector('button')).toBeNull();
		expect(host.querySelector('input')).toBeNull();
	});
});
