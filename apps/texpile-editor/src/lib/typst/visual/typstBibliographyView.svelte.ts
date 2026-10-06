// Card view for a #bibliography(...) raw island - the typst counterpart of the LaTeX
// \printbibliography card, sharing its display component. The island's TEXT stays verbatim
// (this view never edits the node), so the .typ round-trips unchanged.
import { mount, unmount } from 'svelte';
import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';
import BibliographyView from '$lib/editor/extensions/bibliography/BibliographyView.svelte';

export function isTypstBibliography(text: string): boolean {
	return /^#bibliography\(/.test(text.trim());
}

/** The heading from `title: "..."`, or the default typst uses. */
function typBibHeading(text: string): string {
	const m = text.match(/title:\s*"([^"]*)"/);
	return m ? m[1] : 'Bibliography';
}

export class TypstBibliographyView implements NodeView {
	dom: HTMLElement;
	private view: EditorView;
	private getPos: () => number;
	private props = $state<{ heading: string; selected: boolean }>({ heading: 'Bibliography', selected: false });
	private component: Record<string, unknown> | null = null;

	constructor(node: Node, view: EditorView, getPos: () => number) {
		this.view = view;
		this.getPos = getPos;
		this.props.heading = typBibHeading(node.textContent);

		const el = document.createElement('div');
		el.className = 'latex-bibliography';
		el.setAttribute('contenteditable', 'false');
		el.title = node.textContent.trim();
		// click selects the whole node (so Backspace removes it) instead of editing the preview
		el.addEventListener('mousedown', (e) => {
			e.preventDefault();
			const pos = this.getPos();
			if (pos != null) this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
		});
		this.dom = el;
		this.component = mount(BibliographyView, { target: el, props: this.props });
	}

	update(node: Node): boolean {
		if (!isTypstBibliography(node.textContent)) return false;
		this.props.heading = typBibHeading(node.textContent);
		return true;
	}
	selectNode() {
		this.props.selected = true;
	}
	deselectNode() {
		this.props.selected = false;
	}
	stopEvent() {
		return false;
	}
	ignoreMutation() {
		return true;
	}
	destroy() {
		if (this.component) unmount(this.component);
	}
}
