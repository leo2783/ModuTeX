// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import PageMarginsDialogHost from './PageMarginsDialogHost.svelte';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { PageMarginsCoordinator } from '$lib/workspace/page-margins-context';

const unsafeSource =
	'\\documentclass{article}\n\\usepackage{geometry}\n\\geometry{left=2cm}\n\\begin{document}\nKeep bytes.\n\\end{document}\n';

let host: HTMLDivElement;
let app: Record<string, unknown> | null = null;

afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	host?.remove();
});

function mountUnsafeDialog() {
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => false,
		clearPendingAnchor: () => {}
	};
	const buffer = new DocumentBuffer(deps);
	buffer.openTex('/ws/main.tex', unsafeSource, '\n');
	const coordinator = new PageMarginsCoordinator(buffer, new PackagePromptController(), {
		getActivePath: () => '/ws/main.tex',
		getKind: () => 'tex',
		getView: () => null,
		getViewMode: () => 'source',
		afterPreambleChange: async () => true
	});

	host = document.body.appendChild(globalThis.document.createElement('div'));
	const onClose = vi.fn();
	app = mount(PageMarginsDialogHost, { target: host, props: { coordinator, onClose } });
	flushSync();
	return { buffer, scheduled, onClose };
}

describe('page margins dialog close behavior', () => {
	it.each(['close button', 'cancel button', 'Escape'])(
		'closes an unsafe-preamble dialog with %s without editing source',
		async (action) => {
			const { buffer, scheduled, onClose } = mountUnsafeDialog();
			const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
			expect(host.querySelector('[role="status"]')).not.toBeNull();
			const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
			expect(buttons).toHaveLength(2);

			if (action === 'close button') {
				buttons[0].click();
			} else if (action === 'cancel button') {
				buttons[1].click();
			} else {
				await Promise.resolve();
				flushSync();
				expect(dialog?.contains(globalThis.document.activeElement)).toBe(true);
				globalThis.document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			}

			flushSync();
			expect(host.querySelector('[role="dialog"]')).toBeNull();
			expect(onClose).toHaveBeenCalledOnce();
			expect(buffer.texSource).toBe(unsafeSource);
			expect(scheduled).toEqual([]);
		}
	);
});
