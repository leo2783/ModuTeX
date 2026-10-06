// Pure edit computations for the typst source toolbar — the typst sibling of
// markdown/sourceInsert.ts: pure functions of EditorState (unit-testable without a DOM
// EditorView), multi-cursor ranges handled right-to-left so earlier edits don't shift later
// offsets. The actions write Typst markup, never LaTeX or markdown.
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

type Change = { from: number; to: number; insert: string };

function sortedRanges(state: EditorState) {
	return [...state.selection.ranges].sort((a, b) => b.from - a.from);
}

/** toggle a symmetric delimiter pair (* _ ` $) around each selection; empty selections get an
 * empty pair with the cursor inside. */
export function computeToggleDelim(state: EditorState, delim: string): TransactionSpec {
	const text = state.doc.toString();
	const changes: Change[] = [];
	let newSelectionPos: number | null = null;

	for (const range of sortedRanges(state)) {
		if (range.empty) {
			const before = text.slice(range.from - delim.length, range.from);
			const after = text.slice(range.from, range.from + delim.length);
			if (before === delim && after === delim) {
				changes.push({ from: range.from - delim.length, to: range.from + delim.length, insert: '' });
				newSelectionPos = range.from - delim.length;
			} else {
				changes.push({ from: range.from, to: range.from, insert: delim + delim });
				newSelectionPos = range.from + delim.length;
			}
			continue;
		}
		const selected = text.slice(range.from, range.to);
		if (selected.length >= delim.length * 2 && selected.startsWith(delim) && selected.endsWith(delim)) {
			changes.push({ from: range.from, to: range.to, insert: selected.slice(delim.length, -delim.length) });
		} else if (text.slice(range.from - delim.length, range.from) === delim && text.slice(range.to, range.to + delim.length) === delim) {
			changes.push({ from: range.from - delim.length, to: range.to + delim.length, insert: selected });
		} else {
			changes.push({ from: range.from, to: range.to, insert: delim + selected + delim });
		}
	}
	return { changes, ...(newSelectionPos != null ? { selection: EditorSelection.cursor(newSelectionPos) } : {}) };
}

/** set (or toggle off) a `=` heading level on every line the selection touches; 0 = paragraph. */
export function computeHeadingLine(state: EditorState, level: number): TransactionSpec {
	const changes: Change[] = [];
	const doneLines = new Set<number>();
	for (const range of sortedRanges(state)) {
		const fromLine = state.doc.lineAt(range.from).number;
		const toLine = state.doc.lineAt(range.to).number;
		for (let n = toLine; n >= fromLine; n--) {
			if (doneLines.has(n)) continue;
			doneLines.add(n);
			const line = state.doc.line(n);
			const m = /^(={1,6})\s+/.exec(line.text);
			const current = m ? m[1].length : 0;
			const target = current === level ? 0 : level; // same level again toggles back
			const prefix = target === 0 ? '' : '='.repeat(target) + ' ';
			changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
		}
	}
	return { changes };
}

/** toggle a list marker ('- ' or '+ ') on every selected line: add when any lacks it, else strip. */
export function computeListLines(state: EditorState, marker: '- ' | '+ '): TransactionSpec {
	const range = state.selection.main;
	const fromLine = state.doc.lineAt(range.from).number;
	const toLine = state.doc.lineAt(range.to).number;
	const lines = [];
	for (let n = fromLine; n <= toLine; n++) lines.push(state.doc.line(n));
	const re = new RegExp(`^\\${marker.trim()}\\s`);
	const allMarked = lines.every((l) => re.test(l.text) || l.text === '');
	const changes: Change[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (allMarked) {
			const m = re.exec(line.text);
			if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
		} else if (line.text !== '') {
			changes.push({ from: line.from, to: line.from, insert: marker });
		}
	}
	return { changes };
}

/** wrap the selection in a fenced raw block; empty selection leaves the cursor on the lang slot. */
export function computeFence(state: EditorState): TransactionSpec {
	const range = state.selection.main;
	const selected = state.doc.sliceString(range.from, range.to);
	const runs = selected.match(/`{3,}/g);
	const fence = '`'.repeat(runs ? Math.max(3, ...runs.map((r) => r.length)) + 1 : 3);
	const insert = `${fence}\n${selected}${selected && !selected.endsWith('\n') ? '\n' : ''}${fence}\n`;
	return {
		changes: { from: range.from, to: range.to, insert },
		selection: EditorSelection.cursor(range.from + fence.length)
	};
}

/** `#link("url")[selection]` with the url placeholder selected. */
export function computeLink(state: EditorState): TransactionSpec {
	const range = state.selection.main;
	const selected = state.doc.sliceString(range.from, range.to);
	const label = selected || 'text';
	const insert = `#link("url")[${label}]`;
	const urlStart = range.from + 7; // past `#link("`
	return {
		changes: { from: range.from, to: range.to, insert },
		selection: EditorSelection.range(urlStart, urlStart + 3)
	};
}

/** display equation around the selection: `$ ... $` (the spaces are what make it display). */
export function computeMathBlock(state: EditorState): TransactionSpec {
	const range = state.selection.main;
	const selected = state.doc.sliceString(range.from, range.to);
	const insert = `$ ${selected} $`;
	return {
		changes: { from: range.from, to: range.to, insert },
		selection: EditorSelection.cursor(range.from + 2 + selected.length)
	};
}

export interface TypTableOptions {
	/** total rows, the header row included when `header` is on */
	rows: number;
	cols: number;
	/** first row becomes table.header(...) */
	header: boolean;
	/** wrap in #figure(..., caption: [Caption]) so typst numbers it; the caption gets selected */
	figure: boolean;
}

/** #table skeleton on its own lines after the cursor's line; the figure form matches the visual
 * serializer's table_wrapper layout byte for byte, so it graduates on the next reparse. */
export function computeTableSkeleton(
	state: EditorState,
	{ rows, cols, header, figure }: TypTableOptions = { rows: 3, cols: 2, header: true, figure: false }
): TransactionSpec {
	const line = state.doc.lineAt(state.selection.main.head);
	const lead = line.length > 0 ? '\n\n' : '';
	const ind = figure ? '  ' : '';
	const cellRun = (cell: string) => Array.from({ length: Math.max(1, cols) }, () => cell).join(', ');
	const lines = [`${ind}  columns: ${Math.max(1, cols)},`];
	if (header) lines.push(`${ind}  table.header(${cellRun('[Column]')}),`);
	const bodyRows = Math.max(1, header ? rows - 1 : rows);
	for (let r = 0; r < bodyRows; r++) lines.push(`${ind}  ${cellRun('[]')},`);
	const table = `table(\n${lines.join('\n')}\n${ind})`;
	const insert = figure ? `${lead}#figure(\n  ${table},\n  caption: [Caption],\n)\n` : `${lead}#${table}\n`;
	if (figure) {
		const capStart = line.to + insert.lastIndexOf('caption: [') + 'caption: ['.length;
		return {
			changes: { from: line.to, to: line.to, insert },
			selection: EditorSelection.range(capStart, capStart + 'Caption'.length)
		};
	}
	return {
		changes: { from: line.to, to: line.to, insert },
		selection: EditorSelection.cursor(line.to + lead.length + insert.trimEnd().length - lead.length)
	};
}

/** captioned figure skeleton with the image path selected. */
export function computeFigureSkeleton(state: EditorState): TransactionSpec {
	const line = state.doc.lineAt(state.selection.main.head);
	const lead = line.length > 0 ? '\n\n' : '';
	const path = 'image.png';
	const insert = `${lead}#figure(image("${path}"), caption: [Caption])\n`;
	const pathStart = line.to + lead.length + 15; // past `#figure(image("`
	return {
		changes: { from: line.to, to: line.to, insert },
		selection: EditorSelection.range(pathStart, pathStart + path.length)
	};
}
