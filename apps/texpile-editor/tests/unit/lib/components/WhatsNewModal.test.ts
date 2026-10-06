// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import WhatsNewModal from '../../../../src/lib/components/WhatsNewModal.svelte';

let host: HTMLDivElement;
let app: Record<string, unknown> | null = null;

afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	host?.remove();
});

describe('What’s New version label', () => {
	it('shows the shipped app version rather than the upstream changelog version', () => {
		host = document.body.appendChild(document.createElement('div'));
		app = mount(WhatsNewModal, {
			target: host,
			props: {
				open: true,
				entries: [{ version: '0.17.0', notes: ['An upstream release note.'] }]
			}
		});
		flushSync();

		expect(host.querySelector('h2')?.textContent).toContain('v0.1.0');
		expect(host.querySelector('h2')?.textContent).not.toContain('v0.17.0');
	});
});
