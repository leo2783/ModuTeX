// Review comments in the visual editor: the highlight under commented text, and the click that
// selects a thread. The ProseMirror counterpart of extensions/comments.ts, deliberately smaller -
// the panel, the log and the anchors are all shared, so this file is only "turn threads into
// decorations for THIS representation".
//
// Anchors are stored in SOURCE dialect and are never rewritten here (resolution is read-only; an
// anchor rewritten to visual text would stop describing the file on disk). Resolution happens
// against the flat text of the rendered document: prose survives the LaTeX -> visual round trip
// verbatim, so the same quote search that places a thread in CodeMirror places it here. What does
// NOT survive - quotes containing markup, math, line-wrap whitespace - fails to resolve and the
// thread simply draws nothing in this view; the panel still lists it, and the source editor still
// places it. Honest absence over a guessed highlight, same policy as anchor.ts.
//
// Once resolved, ranges are MAPPED through every transaction rather than re-searched (the same
// discipline as the CodeMirror field, for the same reason: mapping is exact, re-searching mid-edit
// can snap a range onto another copy of the text). Re-resolution happens only when the thread list
// changes or a re-parsed document replaces the current one.
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import {
	buildAnchor,
	prepareLoose,
	resolveAnchor,
	resolveAnchorLooseIn,
	type CommentAnchor,
	type LooseHaystack
} from '$lib/comments/anchor';
import type { CommentThread } from '$lib/comments/log';

export interface PmCommentRange {
	id: string;
	from: number;
	to: number;
	resolved: boolean;
}

export interface FlatDoc {
	/** the document's prose in reading order */
	text: string;
	/** index[i] = ProseMirror position of text[i]; the whole reason this exists instead of textBetween */
	index: number[];
}

/**
 * Atoms whose content ProseMirror still renders, through a hole its node view leaves open.
 *
 * A figure caption is ordinary prose - visible, editable, and exactly the sort of line a reviewer
 * wants to argue with - so it has to be walked like any other text. The image node is only an atom
 * for SELECTION purposes; imageNodeView hands back a contentDOM, so a decoration over the caption
 * renders normally.
 *
 * Math is deliberately not here. block_math/inline_math are atoms with content too, but mathlive
 * draws that content itself and ProseMirror never renders it, so a range placed inside one would
 * report a thread as placed while drawing nothing - the exact lie resolvePmComments refuses to tell.
 */
const ATOMS_WITH_PROSE = new Set(['image']);

/**
 * One walk over the document collecting its text AND where each character lives.
 *
 * Atoms (math, includes, chips) become a single object-replacement character rather than being
 * skipped: skipping them would splice their neighbours together, and a quote could then match
 * across content that is not text at all. Block boundaries emit one newline, so a quote can never
 * run silently across a paragraph edge - the flat text has a separator where the reader sees one.
 */
export function flattenDoc(doc: PMNode): FlatDoc {
	const index: number[] = [];
	let text = '';
	doc.descendants((node, pos) => {
		// entering any block after the first: separate it from what came before
		if (!node.isText && node.isBlock && text.length > 0 && !text.endsWith('\n')) {
			index.push(pos);
			text += '\n';
		}
		if (node.isText) {
			const s = node.text ?? '';
			for (let i = 0; i < s.length; i++) index.push(pos + i);
			text += s;
			return false;
		}
		// an EMPTY captionable atom still needs its placeholder: with nothing to walk it would
		// splice the blocks on either side of the figure together
		if (node.isAtom && !(ATOMS_WITH_PROSE.has(node.type.name) && node.content.size > 0)) {
			index.push(pos);
			text += '￼';
			return false;
		}
		return true;
	});
	return { text, index };
}

/**
 * Place every thread in the rendered document, or report it as not visible in this view.
 *
 * Tiered, most precise first, and no tier guesses:
 *  1. the quote in the rendered text as-is (source offsets only feed the fast path/tie-break,
 *     where a miss costs one string compare);
 *  2. the quote through normalizeForMatch, which is what lets a quote survive line wraps,
 *     escapes and ligatures - the normal fate of any multi-line selection;
 *  3. not visible in this view. The panel still lists the thread and says so; the source editor
 *     still places it. Same behaviour in every dialect - an earlier block-demotion tier washed
 *     the containing block instead, and a highlight over a whole table claiming to be a comment
 *     on it read as noise, not as placement.
 */
export function resolvePmComments(doc: PMNode, threads: CommentThread[]): { ranges: PmCommentRange[]; lost: string[] } {
	const { text, index } = flattenDoc(doc);
	const ranges: PmCommentRange[] = [];
	const lost: string[] = [];
	// the flat text is normalized once for the whole pass, and only once something misses: this runs
	// on every re-place, so a document whose threads all still fit pays nothing for tier 2
	let hay: LooseHaystack | null = null;
	for (const t of threads) {
		let hit = resolveAnchor(text, t.anchor);
		if (!hit) {
			hay ??= prepareLoose(text);
			hit = resolveAnchorLooseIn(hay, t.anchor);
		}
		if (hit) {
			const from = index[hit.from];
			const to = hit.to > hit.from ? index[hit.to - 1] + 1 : from;
			if (from !== undefined && to !== undefined && to > from) {
				ranges.push({ id: t.id, from, to, resolved: t.resolved });
				continue;
			}
		}
		lost.push(t.id);
	}
	return { ranges, lost };
}

interface PmCommentsState {
	ranges: PmCommentRange[];
	focused: string | null;
	deco: DecorationSet;
}

type PmCommentsMeta = { type: 'set'; ranges: PmCommentRange[] } | { type: 'focus'; id: string | null };

export const pmCommentsKey = new PluginKey<PmCommentsState>('texpile-comments');

/** replace every range; the store folds its whole log, so partial updates would not buy anything */
export function setPmComments(view: EditorView, ranges: PmCommentRange[]): void {
	view.dispatch(view.state.tr.setMeta(pmCommentsKey, { type: 'set', ranges } satisfies PmCommentsMeta));
}

/** which thread the reader is looking at, so its highlight can be picked out from the rest */
export function focusPmComment(view: EditorView, id: string | null): void {
	view.dispatch(view.state.tr.setMeta(pmCommentsKey, { type: 'focus', id } satisfies PmCommentsMeta));
}

/**
 * Scroll a placed thread into view and park the caret on it. False when this view has not placed it.
 *
 * This is what the panel should use in visual mode, in preference to a source line pushed back
 * through the block map: the map is block-granular, so a line jump lands at the top of whatever
 * block contains the comment, while the plugin has already resolved the thread to the exact
 * characters it covers. The highlight the reader is being sent to is the one thing we know precisely.
 *
 * A COLLAPSED caret, not a selection over the quote: a non-empty selection raises the "Comment"
 * pill, and offering to comment on a comment is not what the click asked for. The focused-highlight
 * tint is what shows the extent.
 *
 * Focus is deliberately not taken. The click happened in the panel, next to a reply box; scrolling
 * is what was asked for, and yanking the caret out of the dock is not.
 */
export function revealPmComment(view: EditorView, id: string): boolean {
	const r = (pmCommentsKey.getState(view.state)?.ranges ?? []).find((x) => x.id === id);
	if (!r) return false;
	const $at = view.state.doc.resolve(r.from);
	// TextSelection.near rather than .create: a comment can start at a block edge, and near() finds
	// the closest position a caret may legally occupy instead of throwing
	const sel = TextSelection.near($at, 1);
	if (!(sel instanceof TextSelection)) return false;
	try {
		view.dispatch(view.state.tr.setSelection(sel).scrollIntoView().setMeta('addToHistory', false));
	} catch {
		return false; // the doc moved under the range; the caller falls back to the line jump
	}
	return true;
}

/** the innermost thread at a position, so nested comments resolve to the one you clicked */
export function pmCommentAt(state: EditorState, pos: number): PmCommentRange | null {
	let best: PmCommentRange | null = null;
	for (const r of pmCommentsKey.getState(state)?.ranges ?? []) {
		if (r.resolved || pos < r.from || pos > r.to) continue;
		if (!best || r.to - r.from < best.to - best.from) best = r;
	}
	return best;
}

function build(doc: PMNode, ranges: PmCommentRange[], focused: string | null): DecorationSet {
	return DecorationSet.create(
		doc,
		ranges
			// resolved threads draw nothing, same as the source editor: the argument is over
			.filter((r) => !r.resolved)
			.map((r) =>
				Decoration.inline(r.from, r.to, {
					class: `pm-comment${r.id === focused ? ' pm-comment-focused' : ''}`,
					'data-comment': r.id
				})
			)
	);
}

/**
 * An anchor for a selection in the rendered document, built against the FLAT text.
 *
 * Rendered-dialect on purpose: the selection is rendered text, so this is the one dialect the
 * anchor is certain to be faithful in. Resolving it back in source mode goes through the same
 * normalize-and-search fallback that carries source anchors the other way.
 */
export function buildPmAnchor(doc: PMNode, from: number, to: number): CommentAnchor | null {
	const { text, index } = flattenDoc(doc);
	// pm -> flat: first flat char at or after `from`, last flat char before `to`
	let f = 0;
	while (f < index.length && index[f] < from) f++;
	let t = f;
	while (t < index.length && index[t] < to) t++;
	if (t <= f) return null;
	return buildAnchor(text, f, t);
}

interface PmCommentsConfig {
	/** commented text was clicked. Selection only - the panel decides whether it is even open. */
	onSelect?: (id: string) => void;
	/** the reader asked to comment on the current selection; null when it spans no real text */
	onAdd?: (anchor: CommentAnchor | null) => void;
	/** label for the pill, so the caller owns translation */
	addLabel?: string;
}

export function pmComments({ onSelect, onAdd, addLabel = 'Comment' }: PmCommentsConfig = {}): Plugin[] {
	const state = new Plugin<PmCommentsState>({
		key: pmCommentsKey,
		state: {
			init: () => ({ ranges: [], focused: null, deco: DecorationSet.empty }),
			apply(tr, value) {
				const meta = tr.getMeta(pmCommentsKey) as PmCommentsMeta | undefined;
				if (meta?.type === 'set') return { ...value, ranges: meta.ranges, deco: build(tr.doc, meta.ranges, value.focused) };
				if (meta?.type === 'focus') return { ...value, focused: meta.id, deco: build(tr.doc, value.ranges, meta.id) };
				if (!tr.docChanged) return value;
				// bias -1/1 keeps a range hugging its own text: typing at either edge extends the
				// comment rather than sliding it. A range whose text is gone collapses, and is dropped.
				const mapped: PmCommentRange[] = [];
				for (const r of value.ranges) {
					const from = tr.mapping.map(r.from, -1);
					const to = tr.mapping.map(r.to, 1);
					if (to > from) mapped.push({ ...r, from, to });
				}
				return { ...value, ranges: mapped, deco: build(tr.doc, mapped, value.focused) };
			}
		},
		props: {
			decorations(state) {
				return pmCommentsKey.getState(state)?.deco ?? DecorationSet.empty;
			},
			handleClick(view, pos) {
				if (!onSelect) return false;
				const hit = pmCommentAt(view.state, pos);
				if (!hit) return false;
				onSelect(hit.id);
				// not handled: the click should still place the caret where it landed
				return false;
			}
		}
	});
	return [state, ...(onAdd ? [addPill(onAdd, addLabel)] : [])];
}

/** the pill fades in rather than flashing under the pointer for every drag it passes through */
const SHOW_DELAY = 120;

/**
 * The Comment affordance for a non-empty selection: a small tooltip button floating ABOVE the
 * selection, sharing the source pill's .cm-comment-add chrome from app.css.
 *
 * Above rather than the source editor's left-margin placement, because the visual editor's left
 * margin is already spoken for: the block-handle plugin parks its + and drag grips there, and the
 * pill landed on top of them. Centred over the selection on one line; over the selection head when
 * it spans lines. Flips below when the selection starts at the top of the window.
 *
 * Structurally simpler than the CodeMirror twin because ProseMirror permits layout reads in a
 * plugin view's update(); there is no requestMeasure discipline to follow. Scroll and pane-resize
 * move the text without an editor update, so a capture-phase scroll listener and a ResizeObserver
 * cover what update() cannot see.
 */
function addPill(onAdd: (anchor: CommentAnchor | null) => void, label: string): Plugin {
	return new Plugin({
		view(view) {
			const dom = document.createElement('button');
			dom.className = 'cm-comment-add';
			dom.title = label;
			dom.setAttribute('aria-label', label);
			dom.innerHTML =
				'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
			// geometry inline: the shared class only carries colours (the CM side gets these same
			// properties from its baseTheme, which this editor does not load)
			Object.assign(dom.style, {
				position: 'fixed',
				zIndex: '5',
				display: 'none',
				alignItems: 'center',
				justifyContent: 'center',
				width: '26px',
				height: '26px',
				padding: '0',
				cursor: 'pointer',
				opacity: '0',
				transition: 'opacity 0.05s ease-in'
			});
			// mousedown, not click: by the time click fires the editor has collapsed the selection
			// under the pointer and there is nothing left to comment on
			dom.onmousedown = (e) => {
				e.preventDefault();
				const sel = view.state.selection;
				if (sel instanceof TextSelection && !sel.empty) onAdd(buildPmAnchor(view.state.doc, sel.from, sel.to));
			};
			// NEXT TO the editor, never inside it: view.dom is the contenteditable ProseMirror root,
			// whose children the view owns - its mutation observer treats a foreign child as document
			// DOM and removes it (the CodeMirror twin gets away with view.dom.appendChild because CM's
			// view.dom is a wrapper around the editable area, not the editable area itself). The
			// parent also sits outside the zoom style EditorView puts on the root, which would have
			// scaled the fixed-position button against its own coordinates.
			(view.dom.parentElement ?? document.body).appendChild(dom);

			let timer: ReturnType<typeof setTimeout> | null = null;
			let shown = false;
			const hide = () => {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				shown = false;
				dom.style.opacity = '0';
				dom.style.display = 'none';
			};
			const place = () => {
				const sel = view.state.selection;
				if (!(sel instanceof TextSelection) || sel.empty) {
					hide();
					return;
				}
				let a: { top: number; bottom: number; left: number; right: number };
				let b: typeof a;
				try {
					a = view.coordsAtPos(sel.from);
					b = view.coordsAtPos(sel.to);
				} catch {
					hide();
					return;
				}
				const head = sel.head === sel.from ? a : b;
				// scrolled out of the window: hide rather than park the tooltip at the edge
				if (head.bottom < 0 || head.top > window.innerHeight) {
					hide();
					return;
				}
				const oneLine = Math.abs(a.top - b.top) < 2;
				const cx = oneLine ? (a.left + b.right) / 2 : (head.left + head.right) / 2;
				const anchor = oneLine ? a : head;
				// above the line, else below it when the selection starts at the top of the window
				const top = anchor.top - 26 - 6 >= 4 ? anchor.top - 26 - 6 : anchor.bottom + 6;
				dom.style.display = 'flex';
				dom.style.top = `${top}px`;
				dom.style.left = `${Math.min(Math.max(cx - 13, 4), window.innerWidth - 30)}px`;
				if (!shown && !timer) {
					timer = setTimeout(() => {
						timer = null;
						shown = true;
						dom.style.opacity = '1';
					}, SHOW_DELAY);
				}
			};
			window.addEventListener('scroll', place, true);
			const ro = new ResizeObserver(place);
			ro.observe(view.dom);
			return {
				update: place,
				destroy() {
					window.removeEventListener('scroll', place, true);
					ro.disconnect();
					if (timer) clearTimeout(timer);
					dom.remove();
				}
			};
		}
	});
}
