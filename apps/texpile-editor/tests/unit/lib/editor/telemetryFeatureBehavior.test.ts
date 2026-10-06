import { describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import { createCodeBlock } from '$lib/editor/extensions/codemirrorbridge/cmcommands';
import { createMathField } from '$lib/editor/extensions/mathlivebridge/mlcommands';
import { startImageUpload } from '$lib/editor/extensions/image/imagepluginutils';
import type { ImagePluginSettings } from '$lib/editor/extensions/image/types';

function emptyState(): EditorState {
	return EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create()) });
}

describe('editor feature commands without telemetry', () => {
	it('still creates table nodes', () => {
		const table = createTableNode(schema, 2, 3, false);

		expect(table.type.name).toBe('table');
		expect(table.childCount).toBe(2);
		expect(table.firstChild?.childCount).toBe(3);
	});

	it('still inserts a code block', () => {
		let state = emptyState();
		const handled = createCodeBlock()(state, (transaction) => (state = state.apply(transaction)));
		const nodeTypes: string[] = [];
		state.doc.descendants((node) => {
			nodeTypes.push(node.type.name);
		});

		expect(handled).toBe(true);
		expect(nodeTypes).toContain('code_block');
	});

	it('still inserts inline math', () => {
		let state = emptyState();
		const handled = createMathField()(state, (transaction) => (state = state.apply(transaction)));

		expect(handled).toBe(true);
		expect(state.doc.firstChild?.firstChild?.type.name).toBe('inline_math');
	});

	it('still uploads and inserts a figure', async () => {
		let state = emptyState();
		const view = {
			get state() {
				return state;
			},
			dispatch(transaction) {
				state = state.apply(transaction);
			}
		} as EditorView;
		const uploadFile = vi.fn().mockResolvedValue('figure.png');
		const pluginSettings = {
			uploadFile,
			findPlaceholder: () => 1,
			hasTitle: false,
			defaultTitle: ''
		} as unknown as ImagePluginSettings;

		startImageUpload(view, new File(['figure'], 'figure.png', { type: 'image/png' }), 'figure alt', pluginSettings, schema);

		const findImage = () => {
			let image: ProseMirrorNode | null = null;
			state.doc.descendants((node) => {
				if (node.type.name === 'image') image = node;
			});
			return image;
		};
		await vi.waitFor(() => expect(findImage()).not.toBeNull());
		expect(uploadFile).toHaveBeenCalledOnce();
		expect(findImage()?.attrs).toMatchObject({ src: 'figure.png', alt: 'figure alt' });
	});
});
