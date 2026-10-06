// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import {
	BLOCK_COMMANDS,
	createBlockCommandContext,
	executeBlockCommand,
	filterBlockCommands,
	type BlockCommand
} from '$lib/editor/extensions/blockInsertItems';
import { createSlashMenuPlugin, isSlashTrigger, slashMenuPluginKey } from '$lib/editor/extensions/slash-menu-plugin.svelte';

function stateWithParagraph(text = ''): EditorState {
	const paragraph = schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
	return EditorState.create({ schema, doc: schema.nodes.doc.create(null, paragraph) });
}

function commandById(id: string): BlockCommand {
	const command = BLOCK_COMMANDS.find((item) => item.id === id);
	if (!command) throw new Error(`Missing command ${id}`);
	return command;
}

async function flushMenu(): Promise<HTMLInputElement> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	await Promise.resolve();
	const input = document.querySelector<HTMLInputElement>('[aria-controls="slash-menu-options"]');
	if (!input) throw new Error('Slash menu input was not rendered');
	return input;
}

function openSlashMenu(commands: BlockCommand[] = BLOCK_COMMANDS): { view: EditorView; plugin: ReturnType<typeof createSlashMenuPlugin> } {
	const plugin = createSlashMenuPlugin(commands);
	const view = new EditorView(document.body.appendChild(document.createElement('div')), {
		state: EditorState.create({ schema, plugins: [plugin] })
	});
	vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 8, right: 8, top: 8, bottom: 20 });
	const handled = plugin.props.handleTextInput?.call(plugin, view, 1, 1, '/', () => view.state.tr) ?? false;
	expect(handled).toBe(true);
	return { view, plugin };
}

describe('BlockCommand registry', () => {
	it('matches localized labels, stable IDs, and English keywords', () => {
		expect(filterBlockCommands(BLOCK_COMMANDS, 'heading-2').map((item) => item.id)).toContain('heading-2');
		expect(filterBlockCommands(BLOCK_COMMANDS, 'h2').map((item) => item.id)).toEqual(['heading-2']);
		expect(filterBlockCommands(BLOCK_COMMANDS, 'Math block').map((item) => item.id)).toContain('math-block');
	});

	it('replaces the slash paragraph at its original block position', async () => {
		let state = stateWithParagraph();
		const inserted = await executeBlockCommand(
			commandById('heading-1'),
			createBlockCommandContext(state, (transaction) => (state = state.apply(transaction)), 0, 'replace')
		);
		expect(inserted).toBe(true);
		expect(state.doc.firstChild?.type.name).toBe('heading');
		expect(state.doc.firstChild?.attrs.level).toBe(1);
		expect(state.selection.from).toBe(1);
	});

	it('inserts after the block handle target at the sibling position', async () => {
		let state = EditorState.create({
			schema,
			doc: schema.nodes.doc.create(null, [
				schema.nodes.paragraph.create(null, schema.text('Before')),
				schema.nodes.paragraph.create(null, schema.text('After'))
			])
		});
		const firstSize = state.doc.firstChild!.nodeSize;
		const inserted = await executeBlockCommand(
			commandById('heading-2'),
			createBlockCommandContext(state, (transaction) => (state = state.apply(transaction)), 0, 'after')
		);
		expect(inserted).toBe(true);
		expect(state.doc.childCount).toBe(3);
		expect(state.doc.child(1).type.name).toBe('heading');
		expect(state.doc.child(1).attrs.level).toBe(2);
		expect(state.selection.from).toBe(firstSize + 1);
	});

	it('keeps a cancelled async diagram command from inserting a placeholder', async () => {
		let state = stateWithParagraph();
		let resolveDialog!: () => void;
		const dialog = new Promise<void>((resolve) => (resolveDialog = resolve));
		const controller = new AbortController();
		const diagramCommand: BlockCommand = {
			...commandById('paragraph'),
			id: 'diagram',
			group: 'diagram',
			isAvailable: () => true,
			run: async (ctx) => {
				await dialog;
				if (ctx.abortSignal?.aborted) return;
				ctx.dispatch(ctx.state.tr.insertText('diagram placeholder', 1));
			}
		};
		const completion = executeBlockCommand(
			diagramCommand,
			createBlockCommandContext(state, (transaction) => (state = state.apply(transaction)), 0, 'replace', controller.signal)
		);
		controller.abort();
		resolveDialog();
		expect(await completion).toBe(false);
		expect(state.doc.firstChild?.type.name).toBe('paragraph');
		expect(state.doc.textContent).toBe('');
	});
});

describe('slash-menu trigger', () => {
	it('opens only for a slash at the start of an empty paragraph', () => {
		const empty = stateWithParagraph();
		expect(isSlashTrigger(empty, 1, 1, '/')).toBe(true);
		expect(isSlashTrigger(empty, 1, 1, 'x')).toBe(false);
		const nonEmpty = stateWithParagraph('text');
		expect(isSlashTrigger(nonEmpty, 1, 1, '/')).toBe(false);
	});

	it('uses the production menu for keyboard search, selection, and Escape', async () => {
		const { view } = openSlashMenu();
		try {
			const input = await flushMenu();
			input.value = 'h2';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			await Promise.resolve();
			expect(view.state.doc.firstChild?.type.name).toBe('heading');
			expect(view.state.doc.firstChild?.attrs.level).toBe(2);
			expect(slashMenuPluginKey.getState(view.state)?.open).toBe(false);
		} finally {
			view.destroy();
		}

		const escapeCase = openSlashMenu();
		try {
			const reopenedInput = await flushMenu();
			const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
			reopenedInput.dispatchEvent(escape);
			expect(escape.defaultPrevented).toBe(true);
			expect(slashMenuPluginKey.getState(escapeCase.view.state)?.open).toBe(false);
		} finally {
			escapeCase.view.destroy();
		}
	});

	it('cancels a pending async diagram command through the production menu without inserting a placeholder', async () => {
		let resolveDialog!: () => void;
		const dialog = new Promise<void>((resolve) => (resolveDialog = resolve));
		const diagramCommand: BlockCommand = {
			...commandById('paragraph'),
			id: 'diagram',
			group: 'diagram',
			label: () => 'Diagram',
			isAvailable: () => true,
			run: async (ctx) => {
				await dialog;
				ctx.dispatch(ctx.state.tr.insertText('diagram placeholder', 1));
			}
		};
		const { view } = openSlashMenu([diagramCommand]);
		try {
			const input = await flushMenu();
			expect(document.activeElement).toBe(input);
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			await Promise.resolve();
			expect(document.querySelector('[role="status"]')).not.toBeNull();
			// A disabled input is removed from the browser focus order, making this real Escape path
			// unreachable while a dialog is pending. readonly keeps this menu-owned keyboard target live.
			expect(input.readOnly).toBe(true);
			expect(document.activeElement).toBe(input);
			const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
			(document.activeElement as HTMLInputElement).dispatchEvent(escape);
			expect(escape.defaultPrevented).toBe(true);
			resolveDialog();
			await Promise.resolve();
			await Promise.resolve();
			expect(view.state.doc.textContent).toBe('');
			expect(slashMenuPluginKey.getState(view.state)?.open).toBe(false);
		} finally {
			view.destroy();
		}
	});
});
