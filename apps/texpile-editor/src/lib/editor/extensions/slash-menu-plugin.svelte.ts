import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { mount, unmount } from 'svelte';
import SlashMenu from './SlashMenu.svelte';
import {
	BLOCK_COMMANDS,
	createBlockCommandContext,
	diagramRequesterFor,
	executeBlockCommand,
	type BlockCommand,
	type BlockCommandContext
} from './blockInsertItems';
import { m } from '$lib/paraglide/messages';

interface SlashPluginState {
	open: boolean;
	targetPos: number;
}

interface PendingCommand {
	controller: AbortController;
}

const CLOSED: SlashPluginState = { open: false, targetPos: -1 };
export const slashMenuPluginKey = new PluginKey<SlashPluginState>('slash-menu');

export function isSlashTrigger(state: EditorState, from: number, to: number, text: string): boolean {
	if (text !== '/' || from !== to || !state.selection.empty || state.selection.from !== from) return false;
	const resolvedFrom = state.doc.resolve(from);
	return resolvedFrom.parent.type.name === 'paragraph' && resolvedFrom.parent.content.size === 0 && resolvedFrom.parentOffset === 0;
}

class SlashMenuView {
	private host = document.createElement('div');
	private component: Record<string, unknown> | null;
	private pending: PendingCommand | null = null;
	private state = $state({ open: false, top: 0, left: 0, query: '', active: 0, pending: false, error: '' });

	constructor(
		private view: EditorView,
		private commands: BlockCommand[]
	) {
		document.body.appendChild(this.host);
		this.component = mount(SlashMenu, {
			target: this.host,
			props: { state: this.state, commands, onSelect: this.select, onClose: this.close }
		});
	}

	private cancelPending() {
		this.pending?.controller.abort();
		this.pending = null;
		this.state.pending = false;
	}

	private close = () => {
		this.cancelPending();
		this.state.error = '';
		if (!this.view.isDestroyed) {
			this.view.dispatch(this.view.state.tr.setMeta(slashMenuPluginKey, CLOSED));
			this.view.focus();
		}
		this.state.open = false;
	};

	private select = async (command: BlockCommand) => {
		if (this.state.pending) return;
		const pluginState = slashMenuPluginKey.getState(this.view.state);
		if (!pluginState?.open || !command.isAvailable(this.commandContext(pluginState.targetPos))) return;

		const pending: PendingCommand = { controller: new AbortController() };
		this.pending = pending;
		this.state.pending = true;
		this.state.error = '';

		const ctx = this.commandContext(pluginState.targetPos, pending);
		try {
			const completed = await executeBlockCommand(command, ctx);
			if (this.pending !== pending || pending.controller.signal.aborted) return;
			this.pending = null;
			this.state.pending = false;
			if (completed) this.close();
		} catch {
			if (this.pending !== pending || pending.controller.signal.aborted) return;
			this.pending = null;
			this.state.pending = false;
			this.state.error = m.errorview_title_generic();
		}
	};

	private commandContext(targetPos: number, pending?: PendingCommand): BlockCommandContext {
		return createBlockCommandContext(
			this.view.state,
			(transaction: Transaction) => {
				if (pending && (this.pending !== pending || pending.controller.signal.aborted)) return;
				if (!this.view.isDestroyed) this.view.dispatch(transaction);
			},
			targetPos,
			'replace',
			pending?.controller.signal,
			diagramRequesterFor(this.view)
		);
	}

	update(view: EditorView) {
		this.view = view;
		const pluginState = slashMenuPluginKey.getState(view.state) ?? CLOSED;
		if (!pluginState.open) {
			this.cancelPending();
			this.state.open = false;
			return;
		}
		const coords = view.coordsAtPos(Math.min(pluginState.targetPos + 1, view.state.doc.content.size));
		this.state.top = Math.max(8, Math.min(coords.bottom + 6, window.innerHeight - 340));
		this.state.left = Math.max(8, Math.min(coords.left, window.innerWidth - 272));
		if (!this.state.open) {
			this.state.query = '';
			this.state.active = 0;
			this.state.pending = false;
			this.state.error = '';
		}
		this.state.open = true;
	}

	destroy() {
		this.cancelPending();
		if (this.component) unmount(this.component);
		this.host.remove();
	}
}

export function createSlashMenuPlugin(commands: BlockCommand[] = BLOCK_COMMANDS): Plugin<SlashPluginState> {
	return new Plugin<SlashPluginState>({
		key: slashMenuPluginKey,
		state: {
			init: () => CLOSED,
			apply(transaction, current) {
				const meta = transaction.getMeta(slashMenuPluginKey) as SlashPluginState | undefined;
				if (meta) return meta;
				return transaction.docChanged ? CLOSED : current;
			}
		},
		props: {
			handleTextInput(view, from, to, text) {
				if (!isSlashTrigger(view.state, from, to, text)) return false;
				const resolvedFrom = view.state.doc.resolve(from);
				view.dispatch(view.state.tr.setMeta(slashMenuPluginKey, { open: true, targetPos: resolvedFrom.before(resolvedFrom.depth) }));
				return true;
			},
			handleKeyDown(view, event) {
				if (event.key !== 'Escape' || !slashMenuPluginKey.getState(view.state)?.open) return false;
				view.dispatch(view.state.tr.setMeta(slashMenuPluginKey, CLOSED));
				return true;
			}
		},
		view: (view) => new SlashMenuView(view, commands)
	});
}
