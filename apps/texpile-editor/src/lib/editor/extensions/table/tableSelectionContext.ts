import { NodeSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

interface SelectionSubscriber {
	getPos: () => number | undefined;
	setSelected: (selected: boolean) => void;
	selected: boolean;
}

const subscribers = new WeakMap<EditorView, Set<SelectionSubscriber>>();

/** Return the wrapper position only when the entire selection belongs to one table. */
export function selectedTableWrapperPosition(state: EditorState): number | null {
	const selection = state.selection;
	if (selection instanceof NodeSelection && selection.node.type.name === 'table_wrapper') return selection.from;

	const from = selection.$from;
	const to = selection.$to;
	for (let depth = from.depth; depth > 0; depth--) {
		const node = from.node(depth);
		if (node.type.name !== 'table_wrapper') continue;
		const position = from.before(depth);
		for (let toDepth = to.depth; toDepth > 0; toDepth--) {
			if (to.node(toDepth) === node && to.before(toDepth) === position) return position;
		}
		return null;
	}
	return null;
}

/** NodeViews subscribe by their wrapper position; editor dispatches publish actual PM selection changes. */
export function subscribeTableSelection(
	view: EditorView,
	getPos: () => number | undefined,
	setSelected: (selected: boolean) => void
): () => void {
	let viewSubscribers = subscribers.get(view);
	if (!viewSubscribers) {
		viewSubscribers = new Set();
		subscribers.set(view, viewSubscribers);
	}
	const subscriber: SelectionSubscriber = { getPos, setSelected, selected: false };
	viewSubscribers.add(subscriber);
	refreshSubscriber(view, subscriber, selectedTableWrapperPosition(view.state));
	return () => viewSubscribers?.delete(subscriber);
}

export function publishTableSelection(view: EditorView): void {
	const viewSubscribers = subscribers.get(view);
	if (!viewSubscribers) return;
	const selectedPosition = selectedTableWrapperPosition(view.state);
	for (const subscriber of viewSubscribers) refreshSubscriber(view, subscriber, selectedPosition);
}

function refreshSubscriber(view: EditorView, subscriber: SelectionSubscriber, selectedPosition: number | null): void {
	let position: number | undefined;
	try {
		position = subscriber.getPos();
	} catch {
		position = undefined;
	}
	const selected = position !== undefined && position === selectedPosition && view.dom.isConnected;
	if (subscriber.selected === selected) return;
	subscriber.selected = selected;
	subscriber.setSelected(selected);
}
