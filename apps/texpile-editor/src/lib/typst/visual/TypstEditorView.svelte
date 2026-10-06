<script lang="ts">
	// The Typst visual editor: its OWN ProseMirror over typSchema, third sibling of EditorView and
	// MarkdownEditorView. Extensions are shared only where they are schema-agnostic (they read
	// state.schema); everything whose editing model is LaTeX-shaped (tables, MathLive, images,
	// intellisense, citations, the latex clipboard) is deliberately absent — those constructs
	// live in raw islands until they get typst-aware machinery (see typSchema's comment).
	import { onDestroy, onMount } from 'svelte';
	import { EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state';
	import { EditorView } from 'prosemirror-view';
	import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
	import { typstToProseMirror } from './converter';
	import { typstCopyPlugin } from './clipboard';
	import { createSuggestPlugin } from '$lib/editor/extensions/suggest/suggestPlugin';
	import { TypstBibliographyView, isTypstBibliography } from './typstBibliographyView.svelte';
	import { keymap } from 'prosemirror-keymap';
	import { baseKeymap, toggleMark } from 'prosemirror-commands';
	import { undo as historyUndo, redo as historyRedo, history } from 'prosemirror-history';
	import { gapCursor } from 'prosemirror-gapcursor';
	import { dropCursor } from 'prosemirror-dropcursor';
	import { columnResizing, fixTables, tableEditing, goToNextCell } from 'prosemirror-tables';
	import {
		createListPlugins,
		listKeymap,
		createIndentListCommand,
		createDedentListCommand,
		wrappingListInputRule,
		type ListAttributes
	} from 'prosemirror-flat-list';
	import { inputRules, textblockTypeInputRule, InputRule, undoInputRule, smartQuotes, ellipsis } from 'prosemirror-inputrules';
	import { emDashRule, enDashRule, emDashUpgradeRule } from '$lib/editor/extensions/inputrules/dashRules';
	import { search } from 'prosemirror-search';
	import { typSchema } from './schema';
	import TypstRefView from './typstRefView';
	import { TYP_BLOCK_INSERT_ITEMS } from './blockInsertItems';
	import { isMac } from '$lib/platform';
	import { editorViewStore, referenceStore } from '$lib/stores/editorStore';
	import type { BibLaTeXReference } from '$lib/biblatex';
	import { preferences } from '$lib/stores/preferencesStore.svelte';
	import { toggleHeading } from '$lib/editor/helperCommands';
	import { createMathField } from '$lib/editor/extensions/mathlivebridge/mlcommands';
	import { imagePlugin } from '$lib/editor/extensions/image';
	import { createTypstImageSettings } from './imageSettings.svelte';
	import { createCodeBlock } from '$lib/editor/extensions/codemirrorbridge/cmcommands';
	import { cmarrowHandlers } from '$lib/editor/extensions/codemirrorbridge/cmarrowhandler';
	import { menuUpdatePlugin } from '$lib/editor/extensions/toolbarlistenerplugin';
	import { createCursorPlugin } from '$lib/editor/extensions/cursor-plugin';
	import { createLinkPlugin } from '$lib/editor/extensions/link';
	import { pasteUUIDFixPlugin } from '$lib/editor/extensions/paste-uuid-fix';
	import { placeholderPlugin } from '$lib/editor/extensions/placeholderplugin';
	import { tablePlaceholderPlugin } from '$lib/editor/extensions/table/tablePlaceholderPlugin';
	import { createWordCountPlugin } from '$lib/editor/extensions/wordcount/wordCountPlugin';
	import { createTocPlugin } from '$lib/editor/extensions/tableofcontents/tocPlugin';
	import { createPersistentSelectionPlugin } from '$lib/editor/extensions/persistentSelection/persistentSelectionPlugin';
	import { proofreadPlugin, spellClickBoundaryPlugin } from '$lib/editor/extensions/spellcheck/spellcheckplugin';
	import { createTrailingParagraphPlugin, buildTrailingParagraphTr } from '$lib/editor/extensions/trailing-paragraph-plugin';
	import { createBoundaryClickPlugin } from '$lib/editor/extensions/boundary-click-plugin';
	import { createBlockHandlePlugin } from '$lib/editor/extensions/block-handle-plugin.svelte';
	import { createNodeFlashPlugin } from '$lib/editor/extensions/flash-plugin';
	import { remoteCursorsPlugin } from '$lib/editor/extensions/remoteCursors';
	import CodeBlockView from '$lib/editor/extensions/codemirrorbridge/cmview';
	import { typstTableWrapperView } from '$lib/editor/extensions/table/tableWrapperView.svelte';
	import { publishTableSelection } from '$lib/editor/extensions/table/tableSelectionContext';
	import RawLatexView from '$lib/editor/extensions/raw-latex/rawLatexView';
	import InlineLatexView from '$lib/editor/extensions/raw-latex/inlineLatexView';
	import IncludeDocView from '$lib/editor/extensions/includedoc/includeDocView.svelte';
	import ContextMenu from '$lib/editor/comp/toolbar/ContextMenu.svelte';
	import { pmComments } from '$lib/editor/extensions/pmComments';
	import { syncPmComments } from '$lib/editor/extensions/pmCommentsSync.svelte';
	import type { CommentAnchor } from '$lib/comments/anchor';
	import type { CommentThread } from '$lib/comments/log';
	import 'prosemirror-view/style/prosemirror.css';
	import 'prosemirror-tables/style/tables.css';
	import 'prosemirror-gapcursor/style/gapcursor.css';
	import 'prosemirror-flat-list/dist/style.css';
	import 'prosemirror-search/style/search.css';
	import '$lib/editor/extensions/image/styles/common.css';
	import '$lib/editor/styles/cursor.css';

	interface Props {
		localValue?: PMNode | null;
		onLocalChange?: (value: PMNode) => void;
		onSelectionChange?: () => void;
		placeholder?: string;
		onHistoryBoundary?: (dir: 'undo' | 'redo') => boolean;
		onReady?: () => void;
		/** the link tooltip's Open action: return true when handled in-app, false for the browser. */
		onOpenLink?: (href: string) => boolean;
		/** the open file's directory; #include chips resolve their paths against it */
		docDir?: string;
		/** the project's bibliography; @target chips resolve against it for display */
		localReferences?: BibLaTeXReference[];
		/** review comments, same contract as the latex EditorView; see extensions/pmComments */
		commentThreads?: CommentThread[];
		selectedComment?: string | null;
		onSelectComment?: (id: string, from: 'visual') => void;
		onAddComment?: (anchor: CommentAnchor | null) => void;
		onCommentsPlaced?: (lost: string[]) => void;
		addCommentLabel?: string;
	}

	let {
		localValue = null,
		onLocalChange,
		onSelectionChange,
		placeholder = '',
		onHistoryBoundary,
		onReady,
		onOpenLink,
		docDir = '',
		localReferences = [],
		commentThreads = [],
		selectedComment = null,
		onSelectComment,
		onAddComment,
		onCommentsPlaced,
		addCommentLabel = 'Comment'
	}: Props = $props();

	$effect(() => {
		referenceStore.set(localReferences);
	});

	let editor: HTMLElement = $state(null!);
	let editorView: EditorView | null = $state(null);

	// typst-flavored autoformat: = headings, ``` fences, - / + / 1. lists. Deliberately no task
	// rule: the serializer has no typst form for a checkbox, so a task list must not be creatable.
	const typInputRules = [
		textblockTypeInputRule(/^(={1,6})\s$/, typSchema.nodes.heading, (m) => ({ level: m[1].length })),
		textblockTypeInputRule(/^```$/, typSchema.nodes.code_block, { env: 'fence', args: '' }),
		wrappingListInputRule<ListAttributes>(/^\s?[-*]\s$/, { kind: 'bullet' }),
		wrappingListInputRule<ListAttributes>(/^\s?\+\s$/, { kind: 'ordered' }),
		wrappingListInputRule<ListAttributes>(/^\s?\d+\.\s$/, { kind: 'ordered' }),
		// "--- " (or the em dash the dash rules already made of it) alone on a line: divider
		new InputRule(/^(?:---|—)\s$/, (state, _m, start, end) =>
			state.tr.replaceRangeWith(start, end, typSchema.nodes.horizontal_rule.create())
		),
		// smart typography, same rules as the tex editor; the serializer emits the literal
		// characters and typst renders them as written
		...smartQuotes,
		ellipsis,
		emDashRule,
		enDashRule,
		emDashUpgradeRule
	];

	// Pasted TYPST SOURCE becomes rich nodes - the typst counterpart of the latex clipboard.
	// Gated on structural markers so ordinary prose still pastes as plain text; html-flavored
	// pastes keep ProseMirror's own path. Parse-time orig stamps are stripped: they describe the
	// clipboard bytes, not this document, and a stale slice must never reach the serializer.
	const pasteTypstPlugin = new Plugin({
		props: {
			handlePaste(view, event) {
				const cb = event.clipboardData;
				const text = cb?.getData('text/plain');
				if (!text || cb?.getData('text/html')) return false;
				if (!/(^|\n)(={1,6} |[-+] |\/ |```|#[a-zA-Z])|\*[^\s*][^*]*\*|_[^\s_][^_]*_/.test(text)) return false;
				try {
					const { doc } = typstToProseMirror(text);
					const blocks: PMNode[] = [];
					doc.forEach((c) =>
						blocks.push('orig' in (c.type.spec.attrs ?? {}) ? c.type.create({ ...c.attrs, orig: null }, c.content, c.marks) : c)
					);
					if (blocks.length === 0) return false;
					const frag = Fragment.fromArray(blocks);
					// a single pasted paragraph merges inline into the current one; anything more
					// structured inserts as whole blocks
					const open = blocks.length === 1 && blocks[0].type.name === 'paragraph' ? 1 : 0;
					view.dispatch(view.state.tr.replaceSelection(new Slice(frag, open, open)).scrollIntoView());
					return true;
				} catch {
					return false; // unparsable clipboard: let the plain-text path have it
				}
			}
		}
	});

	onMount(async () => {
		// MathLive edits the math nodes' LaTeX content; the serializer's mathTypstOf round-trips
		// it back to typst through MathLive's own typst serializer (see latexToTypst.ts)
		const { mathlivePlugin, mlarrowHandlers } = await import('$lib/editor/extensions/mathlivebridge/mlplugin');

		const plugins = [
			pasteTypstPlugin,
			typstCopyPlugin,
			gapCursor(),
			dropCursor({ color: 'var(--color-primary-500)', width: 2 }),
			columnResizing(),
			tableEditing(),
			...createListPlugins({ schema: typSchema }),
			history(),
			// the @ reference/citation popup; its arrow/enter keymap must precede the others.
			// The picker inserts typ_ref atoms (it keys off the mounted schema)
			...createSuggestPlugin(),
			keymap(listKeymap),
			inputRules({ rules: typInputRules }),
			keymap({
				// PM history first, then the workspace snapshot history (survives mode switches)
				'Mod-z': (state, dispatch) => historyUndo(state, dispatch) || (onHistoryBoundary ? (onHistoryBoundary('undo'), true) : false),
				'Mod-y': (state, dispatch) => historyRedo(state, dispatch) || (onHistoryBoundary ? (onHistoryBoundary('redo'), true) : false),
				'Mod-Shift-z': (state, dispatch) => historyRedo(state, dispatch) || (onHistoryBoundary ? (onHistoryBoundary('redo'), true) : false),
				Backspace: undoInputRule,
				'Mod-b': toggleMark(typSchema.marks.strong),
				'Mod-i': toggleMark(typSchema.marks.em),
				'Mod-u': toggleMark(typSchema.marks.u),
				'Mod-.': toggleMark(typSchema.marks.sup),
				'Mod-,': toggleMark(typSchema.marks.sub),
				'Mod-`': toggleMark(typSchema.marks.code),
				'Mod-Shift-`': createCodeBlock(),
				'Mod-m': createMathField(),
				'Mod-Shift-m': createMathField(true),
				// Word/Docs convention, same as the other editors; typst headings nest to six
				'Mod-Alt-0': toggleHeading(0),
				...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`Mod-Alt-${n}`, toggleHeading(n)])),
				...(isMac ? {} : { 'Mod-Shift-1': toggleHeading(1), 'Mod-Shift-2': toggleHeading(2), 'Mod-Shift-3': toggleHeading(3) }),
				// table cell first, then list indent; always consume so focus stays in the editor
				Tab: (state, dispatch) => goToNextCell(1)(state, dispatch) || createIndentListCommand()(state, dispatch) || true,
				'Shift-Tab': (state, dispatch) => goToNextCell(-1)(state, dispatch) || createDedentListCommand()(state, dispatch) || true
			}),
			cmarrowHandlers,
			mlarrowHandlers,
			mathlivePlugin,
			keymap(baseKeymap),
			imagePlugin(createTypstImageSettings(docDir)),
			menuUpdatePlugin(),
			createCursorPlugin(),
			createLinkPlugin({ onOpen: onOpenLink }),
			pasteUUIDFixPlugin,
			search(),
			placeholderPlugin(placeholder),
			tablePlaceholderPlugin(),
			createWordCountPlugin(),
			createTocPlugin(),
			createPersistentSelectionPlugin(),
			spellClickBoundaryPlugin, // must precede proofreadPlugin; see its comment
			proofreadPlugin,
			createTrailingParagraphPlugin(),
			createBoundaryClickPlugin(),
			// the Notion-style + / drag / delete gutter, with the typst insert set
			createBlockHandlePlugin({ items: TYP_BLOCK_INSERT_ITEMS }),
			createNodeFlashPlugin(),
			// Keep remote cursor decorations available for document providers.
			remoteCursorsPlugin,
			...pmComments({
				onSelect: (id) => onSelectComment?.(id, 'visual'),
				onAdd: onAddComment,
				addLabel: addCommentLabel
			})
		];

		let editorState = EditorState.create({ schema: typSchema, plugins, doc: localValue ?? undefined });
		const fix = fixTables(editorState);
		if (fix) editorState = editorState.apply(fix.setMeta('addToHistory', false));
		// trailing paragraphs at load, not lazily on first edit (byte-neutral; empty paragraphs
		// serialize to nothing)
		const trail = buildTrailingParagraphTr(editorState);
		if (trail) editorState = editorState.apply(trail.setMeta('addToHistory', false));

		editorView = new EditorView(editor, {
			attributes: { class: 'TexpileEditor TypstEditor', spellcheck: 'false' },
			state: editorState,
			nodeViews: {
				code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos as () => number),
				// typst raw islands are the safety valve for everything unmodeled: plain CM views
				// (highlighting picked by attrs.lang), never a latex-specialized node view. The one
				// dressed-up island is #bibliography, whose card view keeps the text verbatim
				raw_latex: (node, view, getPos) =>
					isTypstBibliography(node.textContent)
						? new TypstBibliographyView(node, view, getPos as () => number)
						: new RawLatexView(node, view, getPos as () => number),
				inline_latex: (node, view, getPos) => new InlineLatexView(node, view, getPos as () => number),
				includedoc: (node, view, getPos) => new IncludeDocView(node, view, getPos as () => number, docDir),
				// the shared table wrapper chrome (Table N header, gear with label + verbatim columns)
				// in typst mode: every LaTeX-only control is gated off inside
				table_wrapper: (node, view, getPos) => typstTableWrapperView(node, view, getPos as () => number),
				typ_ref: (node, view) => new TypstRefView(node, view)
			},
			editable: () => true,
			dispatchTransaction(transaction: Transaction) {
				// async plugins (spellcheck) can dispatch into a destroyed view on tab switches
				if (this.isDestroyed) return;
				const newState = this.state.apply(transaction);
				this.updateState(newState);
				if (transaction.selectionSet || transaction.docChanged) publishTableSelection(this);
				// collabRemotePatch: a collaborator's edit patched in from the shared doc. It is
				// already IN the shared doc, so reporting it as a local change would echo it back
				if (onLocalChange && transaction.docChanged && !transaction.getMeta('collabRemotePatch')) onLocalChange(newState.doc);
				if (onSelectionChange && (transaction.selectionSet || transaction.docChanged)) onSelectionChange();
			}
		});

		$editorViewStore = editorView;
		editor?.classList?.remove('hidden');
		editorView.focus();
		onReady?.();
	});

	function scrollParent(el: HTMLElement | null): HTMLElement | null {
		let cur = el?.parentElement ?? null;
		while (cur) {
			const oy = getComputedStyle(cur).overflowY;
			if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
			cur = cur.parentElement;
		}
		return null;
	}

	// swap in a re-parsed doc without remounting (same contract as the other editor views): a
	// fresh EditorState on the same view keeps the DOM and scroll; fires only when localValue changes
	let mountedDoc: PMNode | null = null;
	/** bumped only on doc SWAPS (see pmCommentsSync); typing maps ranges instead */
	let docEpoch = $state(0);
	$effect(() => {
		const next = localValue;
		if (!editorView || !next) return;
		if (mountedDoc === null) {
			mountedDoc = next;
			return;
		}
		if (next === mountedDoc || next === editorView.state.doc) {
			mountedDoc = next;
			return;
		}

		const scroller = scrollParent(editorView.dom);
		const savedTop = scroller?.scrollTop ?? 0;
		const prevAnchor = editorView.state.selection.anchor;

		let base = EditorState.create({ schema: typSchema, plugins: editorView.state.plugins, doc: next });
		const trail = buildTrailingParagraphTr(base);
		if (trail) base = base.apply(trail.setMeta('addToHistory', false));
		let restored = base;
		try {
			const pos = Math.min(Math.max(1, prevAnchor), base.doc.content.size);
			restored = base.apply(base.tr.setSelection(TextSelection.near(base.doc.resolve(pos))).setMeta('addToHistory', false));
		} catch {
			restored = base;
		}
		editorView.updateState(restored);
		mountedDoc = next;
		docEpoch++;

		if (scroller) {
			scroller.scrollTop = savedTop;
			requestAnimationFrame(() => (scroller.scrollTop = savedTop));
		}
	});

	// after the swap effect, so the sync reads the newly-installed document
	syncPmComments({
		view: () => editorView,
		threads: () => commentThreads,
		epoch: () => docEpoch,
		selected: () => selectedComment,
		onPlaced: (lost) => onCommentsPlaced?.(lost)
	});

	$effect(() => {
		if (editorView?.dom) {
			(editorView.dom as HTMLElement).style.setProperty('zoom', `${preferences.zoom}`, 'important');
		}
	});

	onDestroy(() => {
		editorView?.destroy();
		editorViewStore.set(null);
	});
</script>

<main bind:this={editor} class="hidden"></main>

<ContextMenu dialect="typst" {onAddComment} />

<style lang="postcss">
	@reference "../../../app.css";

	/* same quiet inset as the markdown editor's islands; the tex card styling is too loud here */
	:global(.TypstEditor .cm-wrapper) {
		@apply border-surface-300-700 border shadow-none;
	}

	/* raw-island insets are tightened in RawLatexView itself (all dialects), nothing typst-specific */

	/* A labeled equation shows its <label> where LaTeX shows "(1)": the editor cannot know the
	   real number (numbering is the template's #set math.equation rule), but the label proves the
	   equation is referenceable and is exactly what the @ picker offers. mlview sets the attr. */
	:global(.TypstEditor .block-math-container[data-typst-label]:not([data-typst-label=''])::after) {
		content: '<' attr(data-typst-label) '>';
		position: absolute;
		right: 1rem;
		top: 50%;
		transform: translateY(-50%);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8em;
		color: var(--color-surface-500);
		user-select: none;
		pointer-events: none;
	}
	/* keep the hover gear clear of the chip, the way the LaTeX number pushes it left */
	:global(.TypstEditor .block-math-container[data-typst-label]:not([data-typst-label='']) .math-settings-container) {
		right: 5rem;
	}

	/* @target chips: citation tint when the key resolves in the bibliography, neutral otherwise */
	:global(.TypstEditor .typ-ref) {
		border-radius: var(--radius-base, 4px);
		padding: 0 0.2em;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.85em;
		background: color-mix(in srgb, var(--color-surface-500) 14%, transparent);
		cursor: default;
	}
	:global(.TypstEditor .typ-ref-known) {
		background: color-mix(in srgb, var(--color-primary-500) 16%, transparent);
		color: var(--color-primary-700);
	}
	:global(.dark .TypstEditor .typ-ref-known) {
		color: var(--color-primary-300);
	}

	/* figure-wrapped tables render through the shared tableWrapperView (typst mode), which owns
	   the "Table N" header and caption layout; numbering stays approximate (raw-island tables
	   aren't counted, the preview is the authority) */

	/* term lists: bold term line, hanging description */
	:global(.TypstEditor .term-item) {
		margin: 0.25rem 0;
	}
	:global(.TypstEditor .term-title) {
		font-weight: 600;
	}
	:global(.TypstEditor .term-item > :not(.term-title)) {
		margin-left: 1.25rem;
	}
</style>
