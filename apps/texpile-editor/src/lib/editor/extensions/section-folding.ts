import type { FoldedSectionState } from 'modutex-contracts';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import './section-folding.css';

export interface SectionDescriptor extends FoldedSectionState {
	key: string;
	headingPos: number;
	headingEnd: number;
	contentFrom: number;
	contentTo: number;
	title: string;
}

interface FoldPluginState {
	folded: Set<string>;
	decorations: DecorationSet;
}

interface SectionFoldingOptions {
	relativeFile: string;
	initial: FoldedSectionState[];
	onChange(states: FoldedSectionState[]): void;
	labels: { fold: string; unfold: string };
}

export const sectionFoldingPluginKey = new PluginKey<FoldPluginState>('section-folding');

const keyOf = (state: Pick<FoldedSectionState, 'relativeFile' | 'ancestorHeadingChain' | 'level' | 'occurrence'>) =>
	JSON.stringify([state.relativeFile, state.ancestorHeadingChain, state.level, state.occurrence]);

/**
 * Describes top-level visual-editor headings without mutating the document. The heading chain plus
 * per-chain occurrence distinguishes repeated section titles and makes saved fold state reopenable.
 */
export function sectionDescriptors(doc: PMNode, relativeFile: string): SectionDescriptor[] {
	const headings: Array<{ pos: number; node: PMNode; level: number; title: string; chain: string[] }> = [];
	const stack: Array<{ level: number; title: string }> = [];
	let pos = 0;

	for (let index = 0; index < doc.childCount; index++) {
		const node = doc.child(index);
		if (node.type.name === 'heading') {
			const level = Number(node.attrs.level) || 1;
			while (stack.length && stack.at(-1)!.level >= level) stack.pop();
			const title = node.textContent.trim();
			const chain = [...stack.map((item) => item.title), title];
			headings.push({ pos, node, level, title, chain });
			stack.push({ level, title });
		}
		pos += node.nodeSize;
	}

	const occurrences = new Map<string, number>();
	return headings.map((heading, index) => {
		const occurrenceBase = JSON.stringify([heading.level, heading.chain]);
		const occurrence = occurrences.get(occurrenceBase) ?? 0;
		occurrences.set(occurrenceBase, occurrence + 1);

		let contentTo = doc.content.size;
		for (let next = index + 1; next < headings.length; next++) {
			if (headings[next].level <= heading.level) {
				contentTo = headings[next].pos;
				break;
			}
		}

		const base = {
			relativeFile,
			ancestorHeadingChain: heading.chain,
			level: heading.level,
			occurrence,
			folded: true
		};
		return {
			...base,
			key: keyOf(base),
			headingPos: heading.pos,
			headingEnd: heading.pos + heading.node.nodeSize,
			contentFrom: heading.pos + heading.node.nodeSize,
			contentTo,
			title: heading.title
		};
	});
}

export function createSectionFoldingPlugin(options: SectionFoldingOptions): Plugin<FoldPluginState> {
	let currentView: EditorView | null = null;
	const initialKeys = new Set(options.initial.filter((item) => item.folded).map(keyOf));

	const buildDecorations = (doc: PMNode, folded: Set<string>) => {
		const descriptors = sectionDescriptors(doc, options.relativeFile);
		const decorations: Decoration[] = [];
		for (const section of descriptors) {
			const isFolded = folded.has(section.key);
			decorations.push(
				Decoration.widget(
					section.headingPos + 1,
					() => {
						const button = document.createElement('button');
						button.type = 'button';
						button.className = 'modutex-fold-toggle';
						button.textContent = isFolded ? '▸' : '▾';
						button.title = isFolded ? options.labels.unfold : options.labels.fold;
						button.setAttribute('aria-label', button.title);
						button.setAttribute('aria-expanded', String(!isFolded));
						button.addEventListener('mousedown', (event) => event.preventDefault());
						button.addEventListener('click', () => toggle(section.key, !isFolded));
						return button;
					},
					// Include folded state in the DOM identity: ProseMirror otherwise reuses the prior widget
					// button and leaves its aria-label/expanded value stale after a keyboard toggle.
					{ key: `fold-${section.key}-${isFolded ? 'closed' : 'open'}`, side: -1 }
				)
			);

			if (!isFolded) continue;
			let childPos = 0;
			for (let index = 0; index < doc.childCount; index++) {
				const node = doc.child(index);
				const end = childPos + node.nodeSize;
				if (childPos >= section.contentFrom && end <= section.contentTo) {
					decorations.push(Decoration.node(childPos, end, { class: 'modutex-folded-section', 'aria-hidden': 'true' }));
				}
				childPos = end;
			}
		}
		return DecorationSet.create(doc, decorations);
	};

	const toggle = (key: string, fold: boolean) => {
		if (!currentView) return;
		const descriptor = sectionDescriptors(currentView.state.doc, options.relativeFile).find((item) => item.key === key);
		if (!descriptor) return;

		let transaction = currentView.state.tr.setMeta(sectionFoldingPluginKey, { key, fold });
		const selection = currentView.state.selection;
		const selectionTouchesContent = selection.empty
			? selection.from >= descriptor.contentFrom && selection.from <= descriptor.contentTo
			: selection.from < descriptor.contentTo && selection.to > descriptor.contentFrom;
		if (fold && selectionTouchesContent) {
			transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(descriptor.headingEnd - 1), -1));
		}
		currentView.dispatch(transaction.setMeta('addToHistory', false));
		currentView.focus();
	};

	function sectionAtSelection(view: EditorView): SectionDescriptor | null {
		const pos = view.state.selection.head;
		const sections = sectionDescriptors(view.state.doc, options.relativeFile);
		return [...sections].reverse().find((section) => pos >= section.headingPos && pos <= section.contentTo) ?? null;
	}

	return new Plugin<FoldPluginState>({
		key: sectionFoldingPluginKey,
		state: {
			init: (_, state) => {
				const validKeys = new Set(sectionDescriptors(state.doc, options.relativeFile).map((section) => section.key));
				const folded = new Set([...initialKeys].filter((key) => validKeys.has(key)));
				return { folded, decorations: buildDecorations(state.doc, folded) };
			},
			apply(transaction, value) {
				let folded = new Set(value.folded);
				const meta = transaction.getMeta(sectionFoldingPluginKey) as { key: string; fold: boolean } | undefined;
				if (meta) {
					if (meta.fold) folded.add(meta.key);
					else folded.delete(meta.key);
				}
				if (transaction.docChanged) {
					const validKeys = new Set(sectionDescriptors(transaction.doc, options.relativeFile).map((section) => section.key));
					folded = new Set([...folded].filter((key) => validKeys.has(key)));
				}
				return { folded, decorations: buildDecorations(transaction.doc, folded) };
			}
		},
		props: {
			decorations: (state) => sectionFoldingPluginKey.getState(state)?.decorations,
			handleKeyDown(view, event) {
				if (!(event.ctrlKey && event.shiftKey) || (event.code !== 'BracketLeft' && event.code !== 'BracketRight')) return false;
				const section = sectionAtSelection(view);
				if (!section) return false;
				event.preventDefault();
				toggle(section.key, event.code === 'BracketLeft');
				return true;
			}
		},
		view(view) {
			currentView = view;
			let previous = '';
			const publish = () => {
				const state = sectionFoldingPluginKey.getState(view.state);
				if (!state) return;
				const descriptors = sectionDescriptors(view.state.doc, options.relativeFile).filter((item) => state.folded.has(item.key));
				const serialized = descriptors
					.map((item) => item.key)
					.sort()
					.join('\n');
				if (serialized === previous) return;
				previous = serialized;
				options.onChange(
					descriptors.map(({ relativeFile, ancestorHeadingChain, level, occurrence }) => ({
						relativeFile,
						ancestorHeadingChain,
						level,
						occurrence,
						folded: true
					}))
				);
			};
			publish();
			return {
				update(nextView) {
					currentView = nextView;
					publish();
				},
				destroy() {
					if (currentView === view) currentView = null;
				}
			};
		}
	});
}
