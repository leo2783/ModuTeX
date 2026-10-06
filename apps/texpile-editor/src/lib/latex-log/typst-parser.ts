// Typst diagnostics, as written to stderr by `typst compile` / `tinymist compile` and redirected
// into the log the compile pipeline already watches.
//
// The format is codespan's (the same renderer rustc uses), not TeX's:
//
//     error: cannot add string and integer
//       ┌─ C:\proj\main.typ:3:12
//       │
//     3 │ #let f(x) = x + 1
//       │             ^^^^^
//
//     help: while calling `f`
//       ┌─ C:\proj\main.typ:4:1
//       ...
//
// `help:` and `hint:` blocks are CONTINUATIONS of the diagnostic above them - a call trace, or a
// suggested fix - not diagnostics of their own. They are folded into the preceding entry's context
// so the Problems list shows one row per real problem, with the trace available underneath.

import type { LogEntry } from './types';

// "error: message" / "warning: message" at the start of a line
const SEVERITY = /^(error|warning)(?:\[[^\]]*\])?:\s*(.*)$/;
// a continuation block belonging to the diagnostic above
const CONTINUATION = /^(help|hint|note):\s*(.*)$/;
// "  ┌─ <path>:<line>:<col>". The path is matched greedily so a Windows drive letter's colon
// cannot be mistaken for the line separator - the last two colon-groups are always line and column.
const LOCATION = /^\s*[┌╭]─\s*(.+):(\d+):(\d+)\s*$/;
// the caret row that underlines the offending span: "  │      ^^^^^"
const CARET = /^\s*│\s*(\^+|-+)\s*$/;
// a numbered source row: "3 │ #let f(x) = x + 1"
const SOURCE_ROW = /^\s*(\d+)\s*│\s?(.*)$/;

/** True when this text looks like Typst diagnostics rather than a TeX engine log. */
export function isTypstLog(text: string): boolean {
	// the box-drawing location marker is the giveaway: no TeX engine emits one
	return /^\s*[┌╭]─\s.+:\d+:\d+\s*$/m.test(text) && /^(error|warning)(\[[^\]]*\])?:/m.test(text);
}

/**
 * The substring the caret row underlines, which anchors the diagnostic in the editor even when the
 * buffer has drifted from the compiled file. Returns '' when the rows don't line up.
 */
function underlined(sourceRow: string, caretRow: string): string {
	// both rows are printed after the same "<gutter> │ " prefix, so the caret's offset within its
	// own row's content is the offset within the source row's content
	const caret = caretRow.indexOf('^') >= 0 ? caretRow.indexOf('^') : caretRow.indexOf('-');
	const bar = caretRow.indexOf('│');
	if (caret < 0 || bar < 0) return '';
	const start = caret - bar - 2; // "│" plus the single space that follows it
	const len = caretRow.slice(caret).replace(/[^^-].*$/, '').length || 1;
	if (start < 0 || start >= sourceRow.length) return '';
	return sourceRow.slice(start, start + len);
}

export interface ParseTypstLogOptions {
	/** Hard cap on entries, guarding against a pathological log. Default 500. */
	maxEntries?: number;
}

/**
 * Parse Typst diagnostics into the same LogEntry shape the LaTeX log produces, so the Problems
 * panel and the editor gutter consume them unchanged.
 */
export function parseTypstLog(text: string, options: ParseTypstLogOptions = {}): LogEntry[] {
	const maxEntries = options.maxEntries ?? 500;
	const entries: LogEntry[] = [];
	const lines = text.split(/\r?\n/);

	let current: LogEntry | null = null;
	// the entry's own location is the FIRST one after its severity line; later ones belong to
	// continuation frames and only enrich the context
	let haveLocation = false;
	const context: string[] = [];

	const flush = () => {
		if (!current) return;
		const ctx = context.join('\n').trim();
		if (ctx) current.context = ctx;
		current.raw = [current.raw, ctx].filter(Boolean).join('\n');
		entries.push(current);
		current = null;
		context.length = 0;
		haveLocation = false;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const sev = SEVERITY.exec(line);
		if (sev) {
			flush();
			if (entries.length >= maxEntries) break;
			current = { level: sev[1] === 'error' ? 'error' : 'warning', message: sev[2].trim(), raw: line };
			continue;
		}

		if (!current) continue; // preamble noise before the first diagnostic

		const cont = CONTINUATION.exec(line);
		if (cont) {
			// stays inside the current entry; the label is kept so the trace reads as it was printed
			context.push(line);
			continue;
		}

		const loc = LOCATION.exec(line);
		if (loc) {
			if (!haveLocation) {
				current.file = loc[1].trim();
				current.line = Number(loc[2]);
				current.column = Number(loc[3]);
				haveLocation = true;
			} else {
				context.push(line);
			}
			continue;
		}

		if (CARET.test(line) && !current.anchorText) {
			// the row above is the source row this caret underlines
			const src = SOURCE_ROW.exec(lines[i - 1] ?? '');
			if (src) {
				const anchor = underlined(src[2], line).trim();
				if (anchor) current.anchorText = anchor;
			}
			context.push(line);
			continue;
		}

		if (line.trim()) context.push(line);
	}
	flush();
	return entries;
}
