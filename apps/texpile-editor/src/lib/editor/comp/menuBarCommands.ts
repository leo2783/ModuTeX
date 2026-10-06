// menu-bar editor commands. visual mode always targets the PM doc (a raw CM block is still a
// PM node); only source mode targets the SourceEditor's CodeMirror.
//
// Dialect-aware on both paths: the CM wraps write the open file's own syntax, and the PM commands
// read the mark/node off the view's OWN schema - the tex, md and typ editors are three different
// Schema objects, and a MarkType from one must never be dispatched into another.
import { get } from 'svelte/store';
import { EditorView as CMView } from '@codemirror/view';
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { undo, redo } from 'prosemirror-history';
import { toggleMark } from 'prosemirror-commands';
import { toggleHeading, toggleBlockQuote } from '$lib/editor/helperCommands';
import { editorViewStore, displaySearchBarStore, viewMode, sourceCmView } from '$lib/stores/editorStore';
import type { Command, EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

export type MenuDialect = 'tex' | 'md' | 'typ';

/** Runs a PM command against the main editor, refocusing by default. MathLive selections own focus. */
export function run(cmd: Command, options: { focusAfter?: boolean } = {}) {
	const v = get(editorViewStore);
	if (!v) return;
	cmd(v.state, v.dispatch);
	if (options.focusAfter !== false) v.focus();
}

/** toggles a mark by name, skipping silently when the open editor's schema lacks it. */
export function runMark(name: string, attrs?: Record<string, unknown>) {
	const v = get(editorViewStore);
	if (!v) return;
	const mark = v.state.schema.marks[name];
	if (!mark) return;
	toggleMark(mark, attrs)(v.state, v.dispatch);
	v.focus();
}

/** replaces the selection in the main editor with a freshly built node. */
export function insertNode(make: (state: EditorState) => PMNode | null) {
	const v = get(editorViewStore);
	if (!v) return;
	const node = make(v.state);
	if (node) {
		v.dispatch(v.state.tr.replaceSelectionWith(node));
		v.focus();
	}
}

/** the CM view the menu should target: source mode only, null in visual mode. */
export function activeCm(): CMView | null {
	if (get(viewMode) !== 'source') return null;
	const cm = get(sourceCmView);
	return cm && cm.dom.isConnected ? cm : null;
}

/** wraps the CM selection with before/after (or inserts at the cursor), then refocuses. */
export function cmReplace(cm: CMView, before: string, after = '') {
	const { from, to } = cm.state.selection.main;
	const sel = cm.state.sliceDoc(from, to);
	cm.dispatch({
		changes: { from, to, insert: before + sel + after },
		selection: { anchor: from + before.length, head: from + before.length + sel.length },
		scrollIntoView: true
	});
	cm.focus();
}

export function editSelect(value: string) {
	// source mode: the document history and the search UI are CodeMirror's, not ProseMirror's
	const cm = activeCm();
	if (cm) {
		if (value === 'undo') cmUndo(cm);
		else if (value === 'redo') cmRedo(cm);
		else if (value === 'find') {
			openSearchPanel(cm); // takes focus itself
			return;
		}
		cm.focus();
		return;
	}
	if (value === 'undo') run(undo);
	else if (value === 'redo') run(redo);
	else if (value === 'find') displaySearchBarStore.update((v) => !v);
}

// what Format writes into the source editor, per dialect. Headings and quotes are line-start
// markers in typst/markdown, so those entries prefix rather than wrap.
const CM_FORMAT: Record<MenuDialect, Partial<Record<string, [string, string]>>> = {
	tex: {
		bold: ['\\textbf{', '}'],
		italic: ['\\textit{', '}'],
		underline: ['\\underline{', '}'],
		code: ['\\texttt{', '}'],
		h1: ['\\section{', '}'],
		h2: ['\\subsection{', '}'],
		h3: ['\\subsubsection{', '}'],
		quote: ['\\begin{quote}\n', '\n\\end{quote}']
	},
	typ: {
		bold: ['*', '*'],
		italic: ['_', '_'],
		underline: ['#underline[', ']'],
		code: ['`', '`'],
		h1: ['= ', ''],
		h2: ['== ', ''],
		h3: ['=== ', ''],
		quote: ['#quote(block: true)[', ']']
	},
	// markdown has no underline; the menu hides the item
	md: {
		bold: ['**', '**'],
		italic: ['*', '*'],
		code: ['`', '`'],
		h1: ['# ', ''],
		h2: ['## ', ''],
		h3: ['### ', ''],
		quote: ['> ', '']
	}
};

export function formatSelect(value: string, dialect: MenuDialect = 'tex') {
	const cm = activeCm();
	if (cm) {
		const wrap = CM_FORMAT[dialect][value];
		if (wrap) cmReplace(cm, wrap[0], wrap[1]);
		return;
	}
	switch (value) {
		case 'bold':
			runMark('strong');
			break;
		case 'italic':
			runMark('em');
			break;
		case 'underline':
			runMark('u');
			break;
		case 'code':
			runMark('code');
			break;
		case 'h1':
			run(toggleHeading(1));
			break;
		case 'h2':
			run(toggleHeading(2));
			break;
		case 'h3':
			run(toggleHeading(3));
			break;
		case 'quote':
			run(toggleBlockQuote());
			break;
	}
}
