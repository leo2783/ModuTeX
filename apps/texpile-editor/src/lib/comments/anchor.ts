// Where a comment is attached, in a form that survives the file being edited by something that
// is not this app.
//
// Overleaf never needs this: it owns the document store, so every edit passes through its ranges
// tracker and an offset can never go stale. Our files sit on disk. Someone edits main.tex in vim,
// or pulls a branch, and every offset after the change is wrong - silently, which is the bad kind.
// So an offset is only ever a HINT here, and the quote plus its surrounding context is what the
// comment is really pinned to. This is the W3C Web Annotation TextQuoteSelector model, the same
// thing Hypothesis anchors highlights with.
//
// Inside a live editing session none of this runs: CodeMirror maps the decorations through each
// transaction, which is exact and free. Re-anchoring happens on load, and after an external
// change to the file.

/** how much text either side is kept, to tell repeated quotes apart */
const CONTEXT = 32;

/**
 * A quote long enough to be worth searching for. A one- or two-character quote appears everywhere
 * and its context decides the match on its own, which is guesswork dressed up as a result.
 */
const MIN_QUOTE = 3;

/** a runaway scan guard: past this many hits the quote is not distinctive enough to place */
const MAX_HITS = 500;

export interface CommentAnchor {
	/** the commented text itself */
	quote: string;
	/** text immediately before and after it, used to pick between repeats of the quote */
	prefix: string;
	suffix: string;
	/** where the quote sat when the comment was written; re-checked, never trusted */
	start: number;
	end: number;
}

export interface ResolvedAnchor {
	from: number;
	to: number;
	/** the offsets were still right - nothing has moved under this comment */
	exact: boolean;
}

export function buildAnchor(text: string, from: number, to: number): CommentAnchor {
	return {
		quote: text.slice(from, to),
		prefix: text.slice(Math.max(0, from - CONTEXT), from),
		suffix: text.slice(to, Math.min(text.length, to + CONTEXT)),
		start: from,
		end: to
	};
}

/**
 * Find the anchor in `text`, or null if it has gone.
 *
 * Null means orphaned, and an orphaned comment must be SHOWN as orphaned rather than pinned to a
 * best guess: a review note parked on the wrong sentence is worse than one that admits it lost its
 * place, because the reader has no way to tell it is lying.
 */
export function resolveAnchor(text: string, a: CommentAnchor): ResolvedAnchor | null {
	if (a.quote.length < MIN_QUOTE) return null;
	// the common case by far - the file has not been touched behind our back
	if (text.slice(a.start, a.end) === a.quote) return { from: a.start, to: a.end, exact: true };
	const hit = searchQuote(text, a.quote, a.prefix, a.suffix, a.start);
	return hit ? { ...hit, exact: false } : null;
}

/** the search behind resolveAnchor, shared with the loose path; `hint` breaks exact-score ties */
function searchQuote(text: string, quote: string, prefix: string, suffix: string, hint: number): { from: number; to: number } | null {
	if (quote.length < MIN_QUOTE) return null;
	const hits = occurrences(text, quote);
	if (hits.length === 0) return null;
	// Too common to place. The scan stops at MAX_HITS, so scoring what it collected would rank the
	// first 500 copies and ignore the rest - and a comment on `\begin` in a long document would land
	// confidently near the top of the file, which is precisely the lie this module exists to avoid.
	// Orphaned is the honest answer for a quote this repetitive.
	if (hits.length >= MAX_HITS) return null;
	if (hits.length === 1) return { from: hits[0], to: hits[0] + quote.length };

	// repeated quote: the context decides. Ties go to whichever copy is nearest where the comment
	// used to be, since edits move text a little more often than they move it a long way.
	const a = { quote, prefix, suffix };
	let best = hits[0];
	let bestScore = -1;
	for (const at of hits) {
		const score = contextScore(text, at, at + quote.length, a);
		if (score > bestScore || (score === bestScore && Math.abs(at - hint) < Math.abs(best - hint))) {
			bestScore = score;
			best = at;
		}
	}
	return { from: best, to: best + quote.length };
}

/**
 * Bring both dialects of the same prose to one canonical form, remembering where every canonical
 * character came from: map[i] = raw offset where canonical character i starts. (The raw span of
 * character i therefore ends where character i+1 begins.)
 *
 * The layers are deliberately closed sets - whitespace, LaTeX escapes, the typographic ligatures -
 * because each is deterministic in both directions. Command stripping (\emph{x} -> x) is NOT here:
 * that is half a parser, and a quote it would mishandle should demote to its block instead of
 * being matched by machinery we only half trust.
 */
export function normalizeForMatch(s: string): { text: string; map: number[] } {
	const map: number[] = [];
	let text = '';
	const emit = (ch: string, at: number) => {
		text += ch;
		map.push(at);
	};
	// the last comparison is U+00A0 (nbsp), not a second plain space: the rendered side of ~
	const ws = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ' ';
	for (let i = 0; i < s.length;) {
		const c = s[i];
		// whitespace runs to one space: source wraps lines that the rendered text does not, so this
		// single rule is what lets any multi-line quote match at all
		if (ws(c)) {
			const at = i;
			while (i < s.length && ws(s[i])) i++;
			emit(' ', at);
			continue;
		}
		if (c === '~') {
			emit(' ', i++); // LaTeX's non-breaking space; the rendered side is caught by ws above
			continue;
		}
		if (c === '\\') {
			const next = s[i + 1];
			if (next !== undefined && '&%$#_{}'.includes(next)) {
				emit(next, i);
				i += 2;
				continue;
			}
			const dots = s.startsWith('\\ldots', i) ? 6 : s.startsWith('\\dots', i) ? 5 : 0;
			if (dots) {
				emit('…', i);
				i += dots;
				continue;
			}
			emit(c, i++);
			continue;
		}
		// dashes and ellipsis canonicalize UP to the unicode character the visual editor's input
		// rules produce; quotes canonicalize DOWN to ascii, because the rendered side may hold
		// either straight or curly depending on whether smartQuotes saw them typed
		if (c === '-' && s[i + 1] === '-') {
			const three = s[i + 2] === '-';
			emit(three ? '—' : '–', i);
			i += three ? 3 : 2;
			continue;
		}
		if (c === '.' && s[i + 1] === '.' && s[i + 2] === '.') {
			emit('…', i);
			i += 3;
			continue;
		}
		if (c === '`') {
			const two = s[i + 1] === '`';
			emit(two ? '"' : "'", i);
			i += two ? 2 : 1;
			continue;
		}
		if (c === "'" && s[i + 1] === "'") {
			emit('"', i);
			i += 2;
			continue;
		}
		if (c === '‘' || c === '’') {
			emit("'", i++);
			continue;
		}
		if (c === '“' || c === '”') {
			emit('"', i++);
			continue;
		}
		emit(c, i++);
	}
	return { text, map };
}

/**
 * One text, normalized once, ready to be searched by many anchors.
 *
 * Exists because normalizing is the expensive half and the text is the same for every thread in a
 * file: it walks the whole string character by character building a parallel offset map, ~3ms for a
 * 200KB document. Doing that per THREAD made a file with 50 relocated comments cost 150ms instead
 * of 5 - the same work 50 times over, for one answer that never changes.
 */
export interface LooseHaystack {
	/** the original string, so a hit can be mapped back to offsets the caller can use */
	raw: string;
	text: string;
	map: number[];
}

export function prepareLoose(text: string): LooseHaystack {
	const n = normalizeForMatch(text);
	return { raw: text, text: n.text, map: n.map };
}

/**
 * resolveAnchor across dialects: the anchor was written against one form of the text (usually the
 * source file) and is being placed in another (the rendered document), so both sides go through
 * normalizeForMatch and the match happens in canonical space. The result is mapped back to RAW
 * offsets in `h.raw`.
 *
 * Never exact: the raw fast path cannot apply when the offsets belong to a different string. The
 * hint is 0 for the same reason - a source offset points nowhere in particular here, so ties fall
 * to the earliest copy rather than to a number pretending to be relevant.
 *
 * The anchor's own quote/prefix/suffix are still normalized per call, and stay that way: they are
 * at most a sentence and a pair of 32-character windows, and they differ every time.
 */
export function resolveAnchorLooseIn(h: LooseHaystack, a: CommentAnchor): ResolvedAnchor | null {
	const quote = normalizeForMatch(a.quote).text;
	const hit = searchQuote(h.text, quote, normalizeForMatch(a.prefix).text, normalizeForMatch(a.suffix).text, 0);
	if (!hit) return null;
	const from = h.map[hit.from];
	const to = hit.to < h.map.length ? h.map[hit.to] : h.raw.length;
	return { from, to, exact: false };
}

/** the single-anchor form; callers with a list should prepare once and loop resolveAnchorLooseIn */
export function resolveAnchorLoose(text: string, a: CommentAnchor): ResolvedAnchor | null {
	return resolveAnchorLooseIn(prepareLoose(text), a);
}

/** how many characters of the remembered context still line up around a candidate */
function contextScore(text: string, from: number, to: number, a: Pick<CommentAnchor, 'prefix' | 'suffix'>): number {
	let score = 0;
	const before = text.slice(Math.max(0, from - a.prefix.length), from);
	for (let i = 1; i <= Math.min(before.length, a.prefix.length); i++) {
		if (before[before.length - i] !== a.prefix[a.prefix.length - i]) break;
		score++;
	}
	const after = text.slice(to, to + a.suffix.length);
	for (let i = 0; i < Math.min(after.length, a.suffix.length); i++) {
		if (after[i] !== a.suffix[i]) break;
		score++;
	}
	return score;
}

function occurrences(text: string, needle: string): number[] {
	const out: number[] = [];
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
		out.push(at);
		if (out.length >= MAX_HITS) break;
	}
	return out;
}
