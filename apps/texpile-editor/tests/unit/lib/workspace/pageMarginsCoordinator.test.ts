import { describe, expect, it, vi } from 'vitest';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { PageMarginsCoordinator } from '$lib/workspace/page-margins-context';
import type { PageMargins } from '$lib/workspace/geometryPatch';

const source = '\\documentclass{article}\n\\begin{document}\nBody bytes.\n\\end{document}\n';
const values: PageMargins = { top: '1.25', right: '2.5', bottom: '3.75', left: '4.125' };

function harness(initialSource = source) {
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => false,
		clearPendingAnchor: () => {}
	};
	const document = new DocumentBuffer(deps);
	document.openTex('/ws/main.tex', initialSource, '\n');
	const packagePrompt = new PackagePromptController();
	const afterPreambleChange = vi.fn(async () => true);
	const coordinator = new PageMarginsCoordinator(document, packagePrompt, {
		getActivePath: () => '/ws/main.tex',
		getKind: () => 'tex',
		getView: () => null,
		getViewMode: () => 'source',
		afterPreambleChange,
		onError: vi.fn()
	});
	return { document, packagePrompt, coordinator, scheduled, afterPreambleChange };
}

describe('page margin coordinator', () => {
	it('requires explicit geometry consent and saves one preamble-only edit after approval', async () => {
		const h = harness();
		const pending = h.coordinator.apply(values, source, new AbortController().signal);
		const request = h.packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'geometry', canAdd: true });
		h.packagePrompt.resolve(request!.id, 'add-and-insert');

		expect(await pending).toBe('applied');
		expect(h.document.texSource).toContain('\\usepackage{geometry}\n');
		expect(h.document.texSource).toContain('top=1.25cm,right=2.5cm,bottom=3.75cm,left=4.125cm');
		expect(h.document.texSource.slice(h.document.texSource.indexOf('\\begin{document}'))).toBe(
			source.slice(source.indexOf('\\begin{document}'))
		);
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: h.document.texSource }]);
		expect(h.afterPreambleChange).toHaveBeenCalledOnce();
	});

	it('cancel leaves the source untouched', async () => {
		const h = harness();
		const pending = h.coordinator.apply(values, source, new AbortController().signal);
		const request = h.packagePrompt.active!;
		h.packagePrompt.resolve(request.id, 'cancel');

		expect(await pending).toBe('cancelled');
		expect(h.document.texSource).toBe(source);
		expect(h.scheduled).toEqual([]);
		expect(h.afterPreambleChange).not.toHaveBeenCalled();
	});

	it('declines a stale dialog after the source changes while consent is open', async () => {
		const h = harness();
		const pending = h.coordinator.apply(values, source, new AbortController().signal);
		const request = h.packagePrompt.active!;
		const edited = source.replace('Body bytes.', 'Externally changed.');
		h.document.onTexInput(edited);
		h.packagePrompt.resolve(request.id, 'add-and-insert');

		expect(await pending).toBe('stale');
		expect(h.document.texSource).toBe(edited);
		expect(h.document.texSource).not.toContain('usepackage{geometry}');
		expect(h.scheduled).toEqual([{ path: '/ws/main.tex', content: edited }]);
	});

	it('rejects non-finite/invalid values and a preamble with unknown geometry settings', async () => {
		const h = harness();
		expect(await h.coordinator.apply({ ...values, left: 'NaN' }, source, new AbortController().signal)).toBe('invalid');
		expect(h.packagePrompt.active).toBeNull();

		const unsafe = source.replace('\\begin{document}', '\\usepackage{geometry}\n\\geometry{left=2cm}\n\\begin{document}');
		const blocked = harness(unsafe);
		expect(blocked.coordinator.inspect()).toMatchObject({ kind: 'blocked', reason: 'unknown-geometry-settings' });
		expect(await blocked.coordinator.apply(values, unsafe, new AbortController().signal)).toBe('blocked');
		expect(blocked.document.texSource).toBe(unsafe);
		expect(blocked.scheduled).toEqual([]);
	});
});
