import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import { FileOpener, type FileOpenerDeps } from '$lib/workspace/fileOpener';
import { DocumentBuffer } from '$lib/workspace/documentBuffer.svelte';
import { activeFilePath } from '$lib/workspace/workspaceStore';
import type { VisualParser } from '$lib/workspace/visualParse.svelte';

vi.mock('$lib/typst/visual/roundtrip', () => ({ serializeTypstFile: () => '' }));

// regression: the open-time parse runs BEFORE doc.path switches, so the parse format MUST come
// from the path being opened, never from the still-open previous file's kind. The WorkspaceView
// adapter once re-derived it reactively, and opening a .tex while a .md was active parsed the
// .tex as markdown.
function makeOpener(
	parse: FileOpenerDeps['parse'],
	readText: FileOpenerDeps['readText'] = async () => 'contents',
	fallbackToSource: FileOpenerDeps['fallbackToSource'] = () => {}
) {
	const doc = new DocumentBuffer({
		scheduleSave: () => {},
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor: () => {}
	});
	const parser = {
		nextSequence: () => 1,
		isCurrent: () => true,
		lastParsedSource: null
	} as unknown as VisualParser;
	const opener = new FileOpener({
		doc,
		parser,
		readText,
		whenIdle: async () => {},
		isVisualMode: () => true,
		isSourceMode: () => false,
		isDiffMode: () => false,
		parse,
		fallbackToSource,
		resetHistory: () => {},
		disableHistory: () => {},
		clearPerFileViewState: () => {},
		captureDiffSnapshot: () => {},
		closeOpenFile: () => {}
	});
	return { opener, doc };
}

describe('FileOpener parse format', () => {
	it('derives the dialect from the OPENED path, not the previous buffer', async () => {
		const calls: Array<{ text: string; format: string }> = [];
		const { opener, doc } = makeOpener(async (text, format) => {
			calls.push({ text, format });
			return {};
		});

		// previous file is markdown...
		activeFilePath.set('C:/ws/notes.md');
		await opener.open('C:/ws/notes.md');
		expect(calls[0].format).toBe('md');
		expect(doc.kind).toBe('md');

		// ...and the incoming .tex must still parse as tex (doc.kind is 'md' until openTex runs)
		activeFilePath.set('C:/ws/paper.tex');
		await opener.open('C:/ws/paper.tex');
		expect(calls[1].format).toBe('tex');
		expect(doc.kind).toBe('tex');
		expect(get(activeFilePath)).toBe('C:/ws/paper.tex');
	});

	it('keeps malformed source intact and invokes the source-mode fallback after a parse failure', async () => {
		const source = readFileSync(fileURLToPath(new URL('../../../fixtures/roundtrip/malformed-source.tex', import.meta.url)), 'utf8');
		const failure = { timeout: false, message: 'parser rejected malformed input' };
		const fallbackToSource = vi.fn();
		const { opener, doc } = makeOpener(
			async () => ({ failure }),
			async () => source,
			fallbackToSource
		);

		activeFilePath.set('C:/ws/malformed.tex');
		await opener.open('C:/ws/malformed.tex');

		// Opening commits the source buffer before the background visual parse settles.
		expect(doc.texSource).toBe(source);
		await vi.waitFor(() => expect(fallbackToSource).toHaveBeenCalledWith(failure));
		expect(doc.texSource).toBe(source);
		expect(doc.visualDoc).toBeNull();
	});
});
