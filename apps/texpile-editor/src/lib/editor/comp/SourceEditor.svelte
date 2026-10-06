<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import {
		EditorView,
		keymap,
		drawSelection,
		lineNumbers,
		highlightActiveLine,
		rectangularSelection,
		crosshairCursor
	} from '@codemirror/view';
	import { EditorState, Compartment, Text, Transaction } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { bracketMatching, indentOnInput, foldGutter, LanguageDescription } from '@codemirror/language';
	import { cmSyntaxHighlight } from '$lib/editor/cmHighlight';
	import { languages as cmlangdata } from '@codemirror/language-data';
	import { searchKeymap, openSearchPanel } from '@codemirror/search';
	import { texpileSearch } from '$lib/editor/extensions/search-panel/searchPanel';
	import { latexAutocomplete, latexIntellisense } from '$lib/editor/extensions/intellisense/intellisense';
	import { foldMarkerDOM, foldMarkerTheme } from '$lib/editor/extensions/intellisense/fold';
	import { mdSourceShortcuts } from '$lib/markdown/sourceExtensions';
	import { mdPathCompletion } from '$lib/markdown/pathCompletion';
	import { cmSpellcheck } from '$lib/editor/extensions/spellcheck/cmSpellcheck';
	import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
	import {
		comments,
		setCommentRanges,
		focusCommentThread,
		commentGutterHandlers,
		type CommentRange
	} from '$lib/editor/extensions/comments';
	import { mathPreview } from '$lib/editor/extensions/math-preview/mathPreview';
	import { starterGhost } from '$lib/editor/extensions/starter-ghost/starterGhost';
	import { synctexFlash, flashLineEffect } from '$lib/editor/extensions/synctex-flash/synctexFlash';
	import { bindModalKeymap, modalKeymapCompartment } from '$lib/editor/extensions/keybindings/modalKeymap';
	import { bibtex } from '$lib/editor/extensions/bibtex/bibtex';
	import { latex } from '$lib/editor/extensions/latex/latex';
	import { releaseTypstLsp, typstLspExtension } from '$lib/typst/lspClient';
	import { workspaceRoot } from '$lib/workspace/workspaceStore';
	import { sourceCmView } from '$lib/stores/editorStore';
	import { docText } from '$lib/editor/docText';
	import { minimalEdit } from '$lib/editor/minimalEdit';
	import { caretDoctor, logDocReplace } from '$lib/debug/caretDoctor';
	import { setSourceDocCount, setSourceSelectionCount } from '$lib/stores/countStore.svelte';
	import { trailingDebounce } from '$lib/trailingDebounce';
	import { docPositions, resolvePosition } from '$lib/workspace/docPositions';
	import { m } from '$lib/paraglide/messages';
	import { settings } from '$lib/settings';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import * as Y from 'yjs';
	import type { Awareness } from 'y-protocols/awareness';

	// full-file CodeMirror editor. source-mode edits are written back verbatim, never through the
	// parse/serialize round-trip. filename picks the syntax mode, defaulting to LaTeX.
	import { ArrowRight, Scissors, Copy, ClipboardPaste, Search, MessageSquarePlus } from '@lucide/svelte';

	// gotoLine: token makes repeat jumps to the same line re-fire; selectText anchors against line drift.
	// initialScrollPos: one-shot mode-switch sync applied at mount.
	// onHistoryBoundary: called when CM undo/redo is exhausted; return true if the workspace history handled it.
	// diagnostics: compile-log problems for this file, line-anchored (the log gives no columns).
	interface SourceDiagnostic {
		line: number;
		lineEnd?: number;
		severity: 'error' | 'warning' | 'info';
		message: string;
		/** 1-based column of the error point (from the log's l.NN context). */
		column?: number;
		/** source text just before the error point, or the offending \ref/\cite key. */
		anchorText?: string;
		/** the offending \command, sized for the underline when found on the line. */
		token?: string;
	}
	// Provider binding: the Y.Text is the document, remote cursors use awareness, and undo only
	// tracks local edits.
	interface CollabBinding {
		ytext: Y.Text;
		awareness: Awareness;
		readOnly?: boolean;
	}
	let {
		value = '',
		onInput,
		filename = '',
		docPath = null,
		gotoLine,
		onSyncToPdf,
		initialScrollPos = null,
		onHistoryBoundary,
		diagnostics = [],
		onJumpToFile,
		onOpenFileAt,
		collab = null,
		onCaretMove,
		commentRanges = [],
		selectedComment = null,
		onAddComment,
		onSelectComment
	}: {
		value?: string;
		onInput?: (v: string) => void;
		filename?: string;
		/** absolute path, for remembering this file's caret across tab switches */
		docPath?: string | null;
		gotoLine?: { line: number; token: number; selectText?: string };
		onSyncToPdf?: (line: number) => void;
		initialScrollPos?: { scroll: number | null; cursor: number | null } | null;
		onHistoryBoundary?: (dir: 'undo' | 'redo') => boolean;
		diagnostics?: SourceDiagnostic[];
		/** go-to-definition hooks: \input targets and cross-file definition jumps */
		onJumpToFile?: (name: string) => void;
		onOpenFileAt?: (file: string, line: number) => void;
		collab?: CollabBinding | null;
		/**
		 * The caret moved here (ZERO-based line and column); lets the Typst preview follow along.
		 *
		 * The column matters as much as the line: tinymist's jump_from_cursor only resolves a
		 * position whose syntax leaf is text, and the leaf it checks is the one BEFORE the cursor.
		 * Column 0 therefore never resolves - so this fires on column changes too, and consumers
		 * are expected to debounce.
		 */
		onCaretMove?: (line: number, character: number) => void;
		/** review-comment ranges already resolved against this text; see lib/comments */
		commentRanges?: CommentRange[];
		/** the thread the reader is looking at; its highlight is picked out from the rest */
		selectedComment?: string | null;
		/** the reader selected text and pressed Comment; offsets are into this document */
		onAddComment?: (from: number, to: number) => void;
		onSelectComment?: (id: string, from: 'text' | 'gutter') => void;
	} = $props();

	/** last position reported to onCaretMove, so redundant selection updates do not spray requests */
	let lastCaretLine = -1;
	let lastCaretChar = -1;

	// language/extension gating: EditorPane only passes docPath, so `filename` alone was always
	// '' and EVERY file (md, bib) silently fell into the "no name -> assume LaTeX" branch —
	// latex intellisense shortcuts and highlighting in markdown source mode included
	const fileFor = $derived(filename || docPath || '');
	// context-menu wording: a .typ jump lands in the live preview, not in a PDF
	const isTypFile = $derived(/\.typ$/i.test(fileFor));

	let ctxMenu = $state<{ x: number; y: number; line: number; hasSelection: boolean } | null>(null);
	function onContextMenu(e: MouseEvent) {
		if (!view) return;
		e.preventDefault();
		const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
		const line = view.state.doc.lineAt(pos ?? view.state.selection.main.head).number;
		const main = view.state.selection.main;
		ctxMenu = {
			x: Math.min(e.clientX, window.innerWidth - 210),
			y: Math.min(e.clientY, window.innerHeight - 240),
			line,
			hasSelection: !main.empty
		};
	}
	function closeMenu() {
		ctxMenu = null;
	}
	const itemClass =
		'hover:preset-tonal-primary flex w-full items-center gap-2.5 px-3 py-1 text-left disabled:pointer-events-none disabled:opacity-40';
	async function cmCopy() {
		if (!view) return;
		const sel = view.state.selection.main;
		const text = view.state.sliceDoc(sel.from, sel.to);
		if (text) await navigator.clipboard.writeText(text).catch(() => {});
	}
	async function cmCut() {
		if (!view) return;
		const { from, to } = view.state.selection.main;
		const text = view.state.sliceDoc(from, to);
		if (text) {
			await navigator.clipboard.writeText(text).catch(() => {});
			view.dispatch({ changes: { from, to, insert: '' } });
		}
		view.focus();
	}
	async function cmPaste() {
		if (!view) return;
		const text = await navigator.clipboard.readText().catch(() => '');
		if (!text) {
			view.focus();
			return;
		}
		const { from, to } = view.state.selection.main;
		view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
		view.focus();
	}
	function cmSelectAll() {
		if (!view) return;
		view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
		view.focus();
	}
	function cmFind() {
		if (view) openSearchPanel(view);
	}

	let host = $state<HTMLDivElement>();
	let view: EditorView | null = null;
	// three digits so the text stops shifting every power of ten. the element is border-box, so the
	// padding has to be inside the floor or it eats a digit.
	/** a flat, single-colour marker; CM's stock ones are gradient-shaded blobs that don't read as
	 *  status icons. Colours are baked in (data: URIs can't reach CSS vars); both work on light
	 *  and dark line-number gutters. */
	const lintMarker = (svg: string) =>
		`url('data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${svg}</svg>`)}')`;
	const gutterTheme = EditorView.theme({
		// gutters aren't content: without this, double-clicking a line number or a fold arrow selects it
		'.cm-gutters': { userSelect: 'none', WebkitUserSelect: 'none' },
		// tight padding: this cell sits BETWEEN the lint rail and the fold rail, which carry their
		// own, so a roomy number cell reads as a gap on both sides rather than as breathing room
		'.cm-lineNumbers .cm-gutterElement': {
			padding: '0 2px 0 3px',
			minWidth: 'calc(3ch + 2px + 3px)',
			textAlign: 'center'
		},
		'.cm-gutter-lint': { width: '1em' },
		// a gutter is as wide as its widest marker, so an EMPTY fold rail is narrower than one with
		// chevrons - the text would slide sideways the moment the first parse produced fold ranges.
		// Pinning it (12px lucide icon + CodeMirror's own 1px cell padding) keeps the rail the same
		// width before and after, which is what makes the .typ open stop jumping.
		'.cm-foldGutter': { width: '14px' },
		// flex-centre the marker: stock CM leaves it inline (vertical-align: middle), which sits
		// visibly above the line-number baseline
		'.cm-gutter-lint .cm-gutterElement': { padding: '0 1px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
		'.cm-lint-marker': { width: '0.7em', height: '0.7em' },
		'.cm-lint-marker-error': { content: lintMarker('<circle cx="20" cy="20" r="15" fill="#ef4444"/>') },
		'.cm-lint-marker-warning': { content: lintMarker('<circle cx="20" cy="20" r="15" fill="#f59e0b"/>') },
		'.cm-lint-marker-info': { content: lintMarker('<circle cx="20" cy="20" r="15" fill="#3b82f6"/>') }
	});
	// y-codemirror.next's stock theme moves text: full-line selections ZERO the line's own padding
	// and "compensate" with 4px/2px margins (net shift), and the caret draws as 2px of inline
	// borders "cancelled" by -1px margins. Neutralize both so a peer's cursor or selection can
	// never move a glyph on this screen: a highlighted line gets pinned to exactly a normal line's
	// box (margin 0 + CM's default .cm-line padding), and the caret span becomes a zero-width
	// in-flow anchor whose visible bar hangs off it out-of-flow (the dot and name label were
	// already absolutely positioned upstream).
	const yRemoteLayoutFix = EditorView.theme({
		'.cm-yLineSelection': { margin: '0', padding: '0 2px 0 6px' },
		'.cm-ySelectionCaret': { border: 'none', margin: '0' },
		'.cm-ySelectionCaret::before': {
			content: "''",
			position: 'absolute',
			top: '0',
			bottom: '0',
			left: '-1px',
			width: '2px',
			backgroundColor: 'inherit'
		}
	});
	const langConf = new Compartment();
	const roConf = new Compartment();
	// soft wrap is a compartment, not a mounted-once extension: toggling it in Preferences has to
	// take effect in the editor already on screen, and remounting would lose the caret and scroll
	const wrapConf = new Compartment();
	// the LSP extension can only be built after the language server has started and answered, which
	// is async and may never happen (tinymist not installed). A compartment lets the editor mount
	// and be typed in immediately, and gain intellisense whenever the server is ready.
	const lspConf = new Compartment();
	// true once tinymist has attached to THIS editor; it then owns the lint state (see the
	// diagnostics effect below). Plain `let`, not $state: the effect that reads it also depends on
	// `diagnostics`, and a compile always follows the server attaching.
	let typstLspActive = false;

	// vim / emacs bindings, filled in after mount because the packages are dynamically imported
	const keymapConf = modalKeymapCompartment();
	let unbindKeymap: (() => void) | null = null;
	// true while pushing an external value into CM, so the update listener doesn't echo it back as a user edit
	let syncing = false;
	// last text handed to onInput: the value-sync effect compares against this first, so our own
	// round-tripped edits skip the second full doc.toString() per keystroke
	let lastEmitted: string | null = null;
	const deferredDocCount = trailingDebounce(300, setSourceDocCount);

	// The viewport, cached as it moves. Measuring it needs a laid-out DOM, and onDestroy - which is
	// the tab switch, and the one moment we MUST have a value - can run once the element is already
	// detached, where getBoundingClientRect reads all zeros and every line resolves to line 1. That
	// is why the caret used to come back correctly while the scroll always snapped to the top.
	let lastVisibleLine = 1;
	let lastVisibleOffset = 0;
	function captureVisibleLine(): void {
		if (!view) return;
		const rect = view.scrollDOM.getBoundingClientRect();
		if (rect.height === 0) return; // detached or hidden: the last good value stands
		const topH = rect.top - view.documentTop; // viewport top, in document height coordinates
		const block = view.lineBlockAtHeight(topH);
		lastVisibleLine = view.state.doc.lineAt(Math.min(block.from, view.state.doc.length)).number;
		// how far INTO that line the viewport starts, which is what makes the restore exact rather
		// than snapped to a line boundary
		lastVisibleOffset = Math.max(0, Math.round(topH - block.top));
	}

	/** Snapshot the caret and first visible line for docPositions. Line/column rather than an
	 *  offset: this file can change on disk between sessions, and a line survives that far better.
	 *  Collab is excluded - the Y.Text is the document and positions there are not ours to assert. */
	function rememberPosition(): void {
		if (!view || !docPath || collab) return;
		captureVisibleLine();
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		docPositions.set(docPath, {
			row: line.number - 1,
			column: head - line.from,
			firstVisibleLine: lastVisibleLine,
			offset: lastVisibleOffset
		});
	}
	// throttle-ish: scrolling and arrow keys fire constantly, and only the resting place matters
	const deferredRememberPosition = trailingDebounce<void>(400, rememberPosition);
	// reads the selection at fire time (not capture), so a huge selection isn't sliced per keystroke
	const deferredSelectionCount = trailingDebounce<void>(150, () => {
		if (!view) return;
		const s = view.state.selection.main;
		setSourceSelectionCount(s.empty ? null : view.state.sliceDoc(s.from, s.to));
	});
	// held at component scope so onDestroy can tear it down (else its doc observer leaks across
	// every file switch / mode toggle that remounts this editor)
	let undoManager: Y.UndoManager | null = null;

	onMount(() => {
		// collab mode: the Y.Text is the document, CRDT undo replaces CM history (plain CM undo
		// would revert other people's edits)
		undoManager = collab ? new Y.UndoManager(collab.ytext) : null;
		const initialDoc = collab ? collab.ytext.toString() : value;
		// Where this file was left. Folded into EditorState.create rather than dispatched after
		// mount, so the first paint is already in the right place instead of jumping to it.
		// A mode-switch anchor outranks it (that block below runs on mount), and an explicit
		// gotoLine outranks both (its own effect fires later still).
		const saved = !collab && !initialScrollPos && docPath ? docPositions.get(docPath) : null;
		// Text.of, not a throwaway EditorState: resolvePosition only needs line lookup, and building a
		// second full state to get it would parse the whole paper twice on every file open.
		const restored = saved ? resolvePosition(saved, Text.of(initialDoc.split('\n'))) : null;
		view = new EditorView({
			parent: host,
			...(restored ? { scrollTo: EditorView.scrollIntoView(restored.scroll, { y: 'start', yMargin: 0 }) } : {}),
			state: EditorState.create({
				doc: initialDoc,
				...(restored ? { selection: { anchor: restored.cursor } } : {}),
				extensions: [
					// gutters render in extension order: lint goes before lineNumbers so it lands on their left
					...(!fileFor || /\.(tex|typ)$/i.test(fileFor) ? [lintGutter({ hoverTime: 0 })] : []),
					// mounted only where the caller wants comments, so .bib and plain-text editors do not
					// grow a gutter column for a feature they never show
					...(onAddComment
						? [
								comments({
									onAdd: (from, to) => onAddComment?.(from, to),
									onSelect: (id, from) => onSelectComment?.(id, from),
									addLabel: m.comments_add()
								})
							]
						: []),
					// the comment mark rides these cells (gutterLineClass), so the click on it has to be
					// handled by the gutter that owns them - EditorView.domEventHandlers only sees the text
					lineNumbers(onSelectComment ? { domEventHandlers: commentGutterHandlers((id) => onSelectComment(id, 'gutter')) } : {}),
					gutterTheme,
					highlightActiveLine(),
					...(collab ? [yCollab(collab.ytext, collab.awareness, { undoManager: undoManager! }), yRemoteLayoutFix] : [history()]),
					roConf.of(collab?.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
					keymapConf.of([]),
					drawSelection(),
					// Multiple cursors. The commands already ship in the keymaps we load - defaultKeymap
					// binds Mod-Alt-Arrow to addCursorAbove/Below and searchKeymap binds Mod-d to
					// selectNextOccurrence - but every transaction is normalized down to one range until
					// the state is told extra ranges are allowed. rectangularSelection/crosshairCursor add
					// Alt+drag column selection on top.
					EditorState.allowMultipleSelections.of(true),
					rectangularSelection(),
					crosshairCursor(),
					bracketMatching(),
					indentOnInput(),
					langConf.of([]),
					cmSyntaxHighlight(),
					// full intellisense (completion + shortcuts + hover + folding + go-to-def) + math preview for
					// .tex only; .bib gets entry-type/field completion. Guests included: the sources read
					// stores fed through the workspace provider, so a session serves them from the shared doc.
					...(!fileFor || /\.tex$/i.test(fileFor)
						? [latexIntellisense({ onJumpToFile, onOpenFileAt }), mathPreview(), starterGhost(), cmSpellcheck()]
						: /\.(md|markdown)$/i.test(fileFor)
							? // md chords; $-math, spellcheck and project file paths are dialect-free
								[mdSourceShortcuts(), mdPathCompletion(), mathPreview(), cmSpellcheck()]
							: /\.bib$/i.test(fileFor)
								? [latexAutocomplete({ bib: true })]
								: /\.typ$/i.test(fileFor)
									? // Typst's completion/hover/diagnostics arrive over LSP from tinymist, filled
										// into lspConf below once the server answers. Harper parses Typst natively,
										// so it gets the source unmasked rather than through the LaTeX mask.
										//
										// The fold RAIL is mounted here, not with the language: the Typst parser is a
										// dynamic import, so a gutter travelling with it appears a second late and
										// shoves the text sideways on every .typ open. Mounted now it is there from
										// the first frame, empty until the parse supplies ranges (the fold service
										// itself does travel with the language, which is where the ranges live).
										[cmSpellcheck('typst'), foldGutter({ markerDOM: foldMarkerDOM }), foldMarkerTheme]
									: []),
					lspConf.of([]),
					synctexFlash(), // flash the line jumped to by SyncTeX inverse search / Find-in-Files
					// compact find/replace widget, floated top-right (styles below)
					texpileSearch(),
					keymap.of([...defaultKeymap, ...(collab ? yUndoManagerKeymap : historyKeymap), ...searchKeymap, indentWithTab]),
					// lower precedence than historyKeymap, so CM's own undo/redo runs first; these fire only
					// when it's exhausted and the workspace snapshot history takes over. consume the key even
					// at the stack edge: a failed redo falling through to another binding is worse than a no-op.
					// collab mode: the CRDT undo manager owns the whole stack, never fall through.
					keymap.of(
						collab
							? []
							: [
									{ key: 'Mod-z', run: () => (onHistoryBoundary ? (onHistoryBoundary('undo'), true) : false) },
									{ key: 'Mod-y', run: () => (onHistoryBoundary ? (onHistoryBoundary('redo'), true) : false) },
									{ key: 'Mod-Shift-z', run: () => (onHistoryBoundary ? (onHistoryBoundary('redo'), true) : false) }
								]
					),
					wrapConf.of($settings.sourceLineWrap === false ? [] : EditorView.lineWrapping),
					// opt-in diagnostic for "the caret moved and I didn't move it"; see caretDoctor
					caretDoctor(),
					EditorView.contentAttributes.of({ spellcheck: 'false', 'data-gramm': 'false', 'data-enable-grammarly': 'false' }),
					// scrolling produces no ViewUpdate at all, so the update listener below never sees it
					EditorView.domEventHandlers({ scroll: () => deferredRememberPosition() }),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) {
							const text = docText(u.state.doc);
							if (!syncing) {
								lastEmitted = text;
								onInput?.(text);
							}
							deferredDocCount(text); // word/char count is display-only, off the keystroke path
						}
						if (u.docChanged || u.selectionSet) deferredSelectionCount();
						if (u.selectionSet && onCaretMove) {
							const head = u.state.selection.main.head;
							const docLine = u.state.doc.lineAt(head);
							const line = docLine.number - 1;
							// UTF-16 code units from the line start, which is what LSP positions want
							// and what CodeMirror's offsets already are
							const character = head - docLine.from;
							if (line !== lastCaretLine || character !== lastCaretChar) {
								lastCaretLine = line;
								lastCaretChar = character;
								onCaretMove(line, character);
							}
						}
						if (u.selectionSet || u.docChanged || u.geometryChanged) deferredRememberPosition();
					})
				]
			})
		});
		view.focus();
		// scrollTo above lands the saved line at the viewport top; this adds the remembered fraction of
		// that line back so the restore is exact rather than snapped to a line boundary. Deferred by a
		// frame because the line's height is only known once CM has measured it, and clamped to that
		// height so a rewrapped (narrower) line cannot overshoot into the next one.
		if (restored && saved?.offset) {
			const px = saved.offset;
			requestAnimationFrame(() => {
				if (!view) return;
				const block = view.lineBlockAt(restored.scroll);
				view.scrollDOM.scrollTop += Math.min(px, Math.max(0, block.height - 1));
			});
		}
		unbindKeymap = bindModalKeymap(view, keymapConf);
		// collab mount: the Y.Text may be ahead of the caller's value (guest edits landed while
		// the file was closed) — hand the truth back so the save pipeline starts aligned
		if (collab && onInput && collab.ytext.toString() !== value) onInput(collab.ytext.toString());
		// seed the counts now; the updateListener only fires on later changes
		setSourceDocCount(docText(view.state.doc));
		setSourceSelectionCount(null);
		// mode-switch sync: reveal the scroll offset near the top, park the caret at the
		// visual editor's caret and flash its line
		if (initialScrollPos != null) {
			const len = view.state.doc.length;
			const clamp = (p: number) => Math.min(Math.max(0, p), len);
			const scrollPos = initialScrollPos.scroll != null ? clamp(initialScrollPos.scroll) : null;
			const cursorPos = initialScrollPos.cursor != null ? clamp(initialScrollPos.cursor) : scrollPos;
			if (cursorPos != null) {
				view.dispatch({
					selection: { anchor: cursorPos },
					effects: [flashLineEffect.of(cursorPos), EditorView.scrollIntoView(scrollPos ?? cursorPos, { y: 'start', yMargin: 12 })]
				});
			}
		}
		// publish this CM as the source-mode editor so menuBarCommands can route Insert/Format to it
		sourceCmView.set(view);

		// .bib uses our hand-written highlighter (language-data ships none). language-data's LaTeX
		// descriptor only matches .tex/.ltx, so route .cls/.sty (same TeX syntax) to it directly
		// instead of through matchFilename, which would leave them unhighlighted.
		if (fileFor && /\.bib$/i.test(fileFor)) {
			view?.dispatch({ effects: langConf.reconfigure(bibtex()) });
		} else if (fileFor && /\.typ$/i.test(fileFor)) {
			// language-data has no Typst entry. The parser is the official typst-syntax crate compiled
			// to wasm, imported dynamically: ~310KB nothing else needs. typstLanguage() deliberately
			// leaves the colours to cmSyntaxHighlight (see its own comment).
			void import('$lib/typst/typstLanguage').then(({ typstLanguage }) =>
				view?.dispatch({ effects: langConf.reconfigure(typstLanguage()) })
			);
		} else if (!fileFor || /\.(tex|cls|sty)$/i.test(fileFor)) {
			// our own LaTeX mode, not language-data's stex: stex files nearly everything under a tag
			// the shared style leaves uncoloured, while this one speaks the same tag vocabulary as
			// the Typst and Markdown modes (heading/math/label/function), so all three match
			view?.dispatch({ effects: langConf.reconfigure(latex()) });
		} else {
			const desc = LanguageDescription.matchFilename(cmlangdata, fileFor);
			desc?.load().then((lang) => view?.dispatch({ effects: langConf.reconfigure(lang) }));
		}

		// intellisense for .typ: start (or reuse) tinymist and hand this file to it. Deliberately
		// not awaited - a missing binary or a slow start must never delay the editor appearing,
		// and if it never resolves the editor simply stays a plain highlighted source view.
		// Started by the FILE, not by the project's compile command: that is how language servers
		// activate everywhere else (VS Code's own tinymist extension is `onLanguage:typst`), and a
		// build-config gate would deny intellisense to anyone driving Typst from a Makefile. The
		// memory it costs is handled by releasing it when the last .typ editor closes, not by
		// refusing to start it - which is also why there is no setting for this. Opening a .typ file
		// IS the request; a switch that turns off completion in your own language is a setting whose
		// only correct value is the default.
		if (fileFor && /\.typ$/i.test(fileFor)) {
			void typstLspExtension(get(workspaceRoot), fileFor)
				.then((ext) => {
					if (!ext || !view) return;
					typstLspActive = true;
					view.dispatch({ effects: lspConf.reconfigure(ext) });
				})
				.catch(() => {
					/* no intellisense; highlighting and compiling are unaffected */
				});
		}
	});

	// follow the Preferences toggle in the open editor rather than only at mount
	$effect(() => {
		const wrap = $settings.sourceLineWrap !== false;
		view?.dispatch({ effects: wrapConf.reconfigure(wrap ? EditorView.lineWrapping : []) });
	});

	// Reconcile an external value change into the document without echoing. addToHistory(false)
	// keeps it out of CM's undo stack, otherwise the next Ctrl+Z would "undo the undo" and bounce
	// back. collab mode: the Y.Text is the document, external value pushes would fight the CRDT.
	//
	// Only the part that actually DIFFERS is replaced. This used to swap the whole buffer
	// (from: 0, to: doc.length), which is a change spanning every position in it -- so CodeMirror
	// had nothing to map the caret onto and collapsed it to the edge of the change. Any external
	// push while the user was typing therefore threw away their place. Trimming the common prefix
	// and suffix leaves the caret's own offsets outside the changed range, where mapping is the
	// identity and the selection survives untouched.
	$effect(() => {
		const v = value;
		if (!collab && view && v !== lastEmitted && v !== docText(view.state.doc)) {
			const old = docText(view.state.doc);
			const edit = minimalEdit(old, v);
			logDocReplace({
				oldLen: old.length,
				newLen: v.length,
				from: edit.from,
				to: edit.to,
				insertLen: edit.insert.length,
				caret: view.state.selection.main.head
			});
			syncing = true;
			view.dispatch({ changes: edit, annotations: Transaction.addToHistory.of(false) });
			syncing = false;
		}
		// mirror CM's doc after every reconciliation, whichever branch ran, so lastEmitted can
		// never go stale and wrongly short-circuit a later external push
		if (!collab && view) lastEmitted = v;
	});

	// live read-only flips (the host opened/closed this file in its visual editor)
	$effect(() => {
		const ro = collab?.readOnly ?? false;
		void ro;
		if (view && collab) {
			view.dispatch({ effects: roConf.reconfigure(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
		}
	});

	// narrows a line-level diagnostic to the offending token: the anchor text (the log's l.NN
	// context tail, or a \ref/\cite key) re-locates the error point even when the buffer drifted
	// since the compile; the raw column is the fallback, the whole line the last resort.
	function diagnosticRange(doc: EditorState['doc'], d: SourceDiagnostic): { from: number; to: number } {
		const startLine = doc.line(Math.min(d.line, doc.lines));
		const endLine = doc.line(Math.min(d.lineEnd ?? d.line, doc.lines));
		if (d.lineEnd === undefined) {
			if (d.anchorText) {
				const at = startLine.text.indexOf(d.anchorText);
				if (at !== -1) {
					// a \ref/\cite key anchors ON itself
					if (d.token === undefined && !d.anchorText.includes('\\')) {
						return { from: startLine.from + at, to: startLine.from + at + d.anchorText.length };
					}
					// an l.NN tail ENDS at the error point: the offending token is its last chars
					const errPoint = at + d.anchorText.length;
					const len = Math.max(1, d.token?.length ?? 1);
					const from = startLine.from + Math.max(at, errPoint - len);
					return { from, to: Math.min(startLine.to, startLine.from + errPoint) };
				}
			}
			if (d.column !== undefined && d.column - 1 <= startLine.length) {
				const from = startLine.from + Math.max(0, d.column - 1 - Math.max(0, d.token?.length ?? 0));
				return { from, to: Math.min(startLine.to, from + Math.max(1, d.token?.length ?? 1)) };
			}
		}
		return { from: startLine.from, to: Math.max(endLine.to, startLine.from) };
	}

	// declared after the value-sync effect so a same-flush file switch replaces the document
	// first and the diagnostics anchor on the fresh doc.
	// Push resolved comment ranges in. Only on identity change: once they are in the field
	// CodeMirror maps them through every transaction itself, so re-dispatching per keystroke would
	// throw that mapping away and replace it with whatever the controller last resolved.
	let lastRanges: CommentRange[] | null = null;
	$effect(() => {
		const list = commentRanges;
		const v = view;
		if (!v || !onAddComment || list === lastRanges) return;
		lastRanges = list;
		v.dispatch({ effects: setCommentRanges.of(list) });
	});

	// Which thread is selected, so its highlight is picked out from the others. Kept separate from
	// the ranges: selecting happens far more often than the ranges change, and it must not cost a
	// rebuild of the whole set.
	let lastFocus: string | null = null;
	$effect(() => {
		const id = selectedComment ?? null;
		const v = view;
		if (!v || !onAddComment || id === lastFocus) return;
		lastFocus = id;
		v.dispatch({ effects: focusCommentThread.of(id) });
	});

	// the effect still runs per keystroke (value is a dependency), but dispatching setDiagnostics
	// re-runs every StateField, so skip when nothing can change: empty mapped onto empty, or the
	// same list on an unchanged doc (re-anchoring only matters once either of them moved).
	let lastDiagDoc: EditorState['doc'] | null = null;
	let lastDiagList: SourceDiagnostic[] | null = null;
	let lastDiagEmpty = true;
	$effect(() => {
		const list = diagnostics;
		const v = view;
		void value; // re-anchor when the document is externally replaced
		if (!v) return;
		// Both this and the language server write through setDiagnostics, which REPLACES the whole
		// lint state - so with tinymist attached the two would overwrite each other on every compile
		// and every keystroke. The server's are live and more precise, so it owns the editor's
		// squiggles for .typ and the compile log keeps the Problems panel. Without a server (not
		// installed) this stays the only source, which is better than nothing.
		if (typstLspActive) return;
		const doc = v.state.doc;
		const valid = list.filter((d) => Number.isInteger(d.line) && d.line >= 1);
		if (valid.length === 0 && lastDiagEmpty) return;
		if (list === lastDiagList && doc === lastDiagDoc) return;
		const mapped: Diagnostic[] = valid.map((d) => ({
			...diagnosticRange(doc, d),
			severity: d.severity,
			message: d.message,
			source: 'latex'
		}));
		v.dispatch(setDiagnostics(v.state, mapped));
		lastDiagDoc = doc;
		lastDiagList = list;
		lastDiagEmpty = mapped.length === 0;
	});

	// SyncTeX gives only a line number, which is stale whenever the buffer differs from the compiled
	// .tex. when the double-clicked word is known, anchor on content instead: select it on the
	// reported line, else on the nearest line containing it. this is what survives line drift.
	function resolveTarget(doc: EditorState['doc'], req: { line: number; selectText?: string }): { from: number; to: number } {
		const line = Math.min(Math.max(1, Math.floor(req.line)), doc.lines);
		const word = req.selectText?.trim();
		if (word && word.length >= 2) {
			const here = doc.line(line);
			const at = here.text.indexOf(word);
			if (at !== -1) return { from: here.from + at, to: here.from + at + word.length };
			// line drifted, find every line containing the word
			const hits: { line: number; from: number }[] = [];
			for (let i = 1; i <= doc.lines; i++) {
				const l = doc.line(i);
				const idx = l.text.indexOf(word);
				if (idx !== -1) hits.push({ line: i, from: l.from + idx });
			}
			if (hits.length === 1) return { from: hits[0].from, to: hits[0].from + word.length }; // unique -> certain
			if (hits.length > 1) {
				const best = hits.reduce((b, h) => (Math.abs(h.line - line) < Math.abs(b.line - line) ? h : b));
				return { from: best.from, to: best.from + word.length };
			}
		}
		const pos = doc.line(line).from;
		return { from: pos, to: pos };
	}
	// The token is what says "this is a NEW jump", and it has to be checked, not just carried. This
	// effect re-runs on far more than gotoLine changing: the prop travels down through inline object
	// literals (WorkspaceView's panes={{...}}), so reading it re-reads every other field in them -
	// diagnostics, the reference list, the tab list. Without this guard a save, a compile or a
	// citation rescan re-applied the last jump, yanking the caret away with the amber flash.
	let lastGotoToken: number | null = null;
	$effect(() => {
		const req = gotoLine;
		if (!req || !view) return;
		if (req.token === lastGotoToken) return;
		lastGotoToken = req.token;
		const { from, to } = resolveTarget(view.state.doc, req);
		view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, effects: flashLineEffect.of(from) });
		view.focus();
	});

	onDestroy(() => {
		// this teardown IS the tab switch: last chance to record where the user was, and the
		// debounce below is about to be cancelled, so take the snapshot synchronously first
		rememberPosition();
		sourceCmView.set(null);
		// the language server holds ~90MB with a project open; hand back our reference so it can be
		// reclaimed once no .typ editor is left (it lingers briefly, so a file switch never restarts it)
		if (typstLspActive) {
			typstLspActive = false;
			releaseTypstLsp();
		}
		unbindKeymap?.();
		unbindKeymap = null;
		// collab teardown: drop our cursor from awareness so peers don't see a ghost, and reap the
		// undo manager's doc observer before the view goes
		if (collab) collab.awareness.setLocalStateField('cursor', null);
		undoManager?.clear();
		undoManager?.destroy();
		undoManager = null;
		view?.destroy();
		view = null;
		// stale timers must not write the NEXT file's counts into the shared store
		deferredDocCount.cancel();
		deferredSelectionCount.cancel();
		deferredRememberPosition.cancel();
	});
</script>

<svelte:window onkeydown={(e) => ctxMenu && e.key === 'Escape' && closeMenu()} />

<div bind:this={host} class="source-editor h-full" oncontextmenu={onContextMenu} role="presentation"></div>

{#if ctxMenu}
	<button
		class="fixed inset-0 z-40 cursor-default"
		aria-label={m.tbar_close_menu_aria()}
		onclick={closeMenu}
		oncontextmenu={(e) => (e.preventDefault(), closeMenu())}
	></button>
	<div
		class="bg-surface-50-950 border-surface-300-700 fixed z-50 min-w-48 overflow-hidden rounded border py-1 text-sm shadow-lg"
		style="left: {ctxMenu.x}px; top: {ctxMenu.y}px"
	>
		<button class={itemClass} disabled={!ctxMenu.hasSelection} onclick={() => (cmCut(), closeMenu())}>
			<Scissors class="size-4 opacity-70" />
			{m.tbar_ctx_cut()} <span class="text-surface-500 ml-auto text-xs">⌘X</span>
		</button>
		<button class={itemClass} disabled={!ctxMenu.hasSelection} onclick={() => (cmCopy(), closeMenu())}>
			<Copy class="size-4 opacity-70" />
			{m.tbar_ctx_copy()} <span class="text-surface-500 ml-auto text-xs">⌘C</span>
		</button>
		<button class={itemClass} onclick={() => (cmPaste(), closeMenu())}>
			<ClipboardPaste class="size-4 opacity-70" />
			{m.tbar_ctx_paste()} <span class="text-surface-500 ml-auto text-xs">⌘V</span>
		</button>
		<button class={itemClass} onclick={() => (cmSelectAll(), closeMenu())}>
			<span class="size-4 shrink-0"></span>
			{m.tbar_ctx_select_all()} <span class="text-surface-500 ml-auto text-xs">⌘A</span>
		</button>
		{#if onAddComment}
			<!-- the same gesture the margin pill offers, for people who reach for the menu instead;
			     disabled rather than hidden with nothing selected, so it is discoverable -->
			<div class="border-surface-200-800 my-1 border-t"></div>
			<button
				class={itemClass}
				disabled={!ctxMenu.hasSelection}
				onclick={() => {
					const sel = view?.state.selection.main;
					if (sel && !sel.empty) onAddComment(sel.from, sel.to);
					closeMenu();
				}}
			>
				<MessageSquarePlus class="size-4 opacity-70" />
				{m.comments_add()}
			</button>
		{/if}
		<div class="border-surface-200-800 my-1 border-t"></div>
		<button class={itemClass} onclick={() => (cmFind(), closeMenu())}>
			<Search class="size-4 opacity-70" />
			{m.tbar_ctx_find()} <span class="text-surface-500 ml-auto text-xs">⌘F</span>
		</button>
		{#if onSyncToPdf}
			<div class="border-surface-200-800 my-1 border-t"></div>
			<!-- .typ goes to the live preview, not a PDF, and the label must not claim otherwise -->
			<button class={itemClass} onclick={() => (onSyncToPdf?.(ctxMenu.line), closeMenu())}>
				<!-- same arrow as the splitter's sync button: same jump, same icon -->
				<ArrowRight class="size-4 opacity-70" />
				{isTypFile ? m.tbar_ctx_show_in_preview() : m.tbar_ctx_show_in_pdf()}
			</button>
		{/if}
	</div>
{/if}

<style>
	.source-editor :global(.cm-editor) {
		height: 100%;
		font-size: 0.875rem;
		position: relative; /* anchor the floating top-right search panel */
	}
	/* float texpileSearch's panel top-right as the same card the visual editor's find bar uses
	   (SearchBar.svelte), so the two search UIs stay consistent */
	.source-editor :global(.cm-panels.cm-panels-top) {
		position: absolute;
		top: 0.5rem;
		right: 0.75rem;
		left: auto;
		width: max-content;
		max-width: calc(100% - 1.5rem);
		background: var(--color-surface-50);
		border: 1px solid var(--color-surface-200);
		border-radius: var(--radius-container, 0.75rem);
		box-shadow:
			0 20px 25px -5px rgb(0 0 0 / 0.1),
			0 8px 10px -6px rgb(0 0 0 / 0.1);
		z-index: 20;
		overflow: hidden;
	}
	:global([data-mode='dark'] .source-editor .cm-panels.cm-panels-top) {
		background: var(--color-surface-950);
		border-color: var(--color-surface-800);
	}
	/* same amber scale the ProseMirror search uses (SearchBar.svelte) */
	.source-editor :global(.cm-searchMatch) {
		background-color: rgb(255, 237, 153);
	}
	.source-editor :global(.cm-searchMatch-selected) {
		background-color: rgb(255, 213, 79);
	}
	:global([data-mode='dark'] .source-editor .cm-searchMatch) {
		background-color: rgb(102, 77, 3);
	}
	:global([data-mode='dark'] .source-editor .cm-searchMatch-selected) {
		background-color: rgb(161, 123, 5);
	}
	.source-editor :global(.cm-scroller) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		line-height: 1.6;
	}
	.source-editor :global(.cm-content) {
		padding: 1rem 0;
	}
	.source-editor :global(.cm-focused) {
		outline: none;
	}
	/* vim / emacs mode line. Unlike the search widget above this is a BOTTOM panel, so it keeps
	   CodeMirror's normal in-flow layout (the scroller shrinks for it) and only needs skinning. */
	.source-editor :global(.cm-panels.cm-panels-bottom) {
		border-top: 1px solid var(--color-surface-200);
		background: var(--color-surface-100);
	}
	:global([data-mode='dark'] .source-editor .cm-panels.cm-panels-bottom) {
		border-top-color: var(--color-surface-800);
		background: var(--color-surface-900);
	}
	.source-editor :global(.cm-vim-panel) {
		font-size: 0.75rem;
		align-items: center;
		min-height: 1.6em;
	}
</style>
