// Reports what moved the caret, and where from -- nothing else. Off unless switched on.
//
// The caret jumping mid-edit is hard to pin down from source alone: any number of things can
// dispatch to the view, and the one that does it is whichever ran at that moment. This logs
// every transaction that moves the selection WITHOUT the user having asked, along with the
// stack that dispatched it, so a single reproduction names the culprit outright.
//
// Turn it on from the devtools console, reproduce, read the log:
//
//   localStorage.setItem('texpile:caret-doctor', '1')   // then reload
//   __caretLog()                                        // after reproducing
//
// Off by default and gated on the flag, so it costs an `if` per update otherwise.
import { EditorView } from '@codemirror/view';
import { Transaction, type Extension } from '@codemirror/state';

type Entry = {
	at: number;
	from: number;
	to: number;
	docChanged: boolean;
	userEvent: string | undefined;
	changes: string;
	stack: string;
};

const log: Entry[] = [];

export function caretDoctorEnabled(): boolean {
	try {
		return localStorage.getItem('texpile:caret-doctor') === '1';
	} catch {
		return false;
	}
}

/**
 * Report that the document was replaced from OUTSIDE the editor -- i.e. something handed the
 * component a value the editor did not itself emit.
 *
 * This is the event worth watching. Typing never reaches it: the editor records what it emits
 * and the reconcile guard rejects the echo, so anything logged here came from elsewhere (a file
 * load, disk being adopted after an external write, the formatter, undo across a mode switch, a
 * label rename). If one of these appears on a plain autosave, that alone is the finding -- it
 * would mean a save round-trip exists that is not supposed to.
 */
export function logDocReplace(d: { oldLen: number; newLen: number; from: number; to: number; insertLen: number; caret: number }): void {
	if (!caretDoctorEnabled()) return;
	const inside = d.caret >= d.from && d.caret <= d.to;
	console.warn(
		'[caret-doctor] document replaced from outside the editor: %d -> %d chars, edit %d..%d (+%d), caret %d %s',
		d.oldLen,
		d.newLen,
		d.from,
		d.to,
		d.insertLen,
		d.caret,
		inside ? 'IS INSIDE the edit and will move' : 'is outside the edit and should survive',
		new Error().stack
	);
}

export function caretDoctor(): Extension {
	if (!caretDoctorEnabled()) return [];
	const w = window as unknown as { __caretLog?: () => Entry[]; __caretClear?: () => void };
	w.__caretLog = () => {
		console.table(log.map(({ stack, ...rest }) => ({ ...rest, top: stack.split('\n')[2]?.trim() ?? '' })));
		return log;
	};
	w.__caretClear = () => log.splice(0, log.length);

	return EditorView.updateListener.of((u) => {
		if (!u.selectionSet) return;
		const before = u.startState.selection.main.head;
		const after = u.state.selection.main.head;
		// a user event means the user did it on purpose (typing, clicking, arrow keys): not our bug
		const userEvent = u.transactions.map((t) => t.annotation(Transaction.userEvent)).find(Boolean);
		if (userEvent) return;
		// describe the change that moved it, which is the thing worth seeing: a caret collapsing to
		// the start of a big replaced range is the signature we are hunting
		const parts: string[] = [];
		for (const t of u.transactions) t.changes.iterChanges((fA, tA, fB, tB) => parts.push(`${fA}..${tA} -> ${fB}..${tB}`));
		log.push({
			at: Math.round(performance.now()),
			from: before,
			to: after,
			docChanged: u.docChanged,
			userEvent,
			changes: parts.join(', ') || '(none)',
			stack: new Error().stack ?? ''
		});
		if (log.length > 200) log.shift();

		console.warn('[caret-doctor] caret moved %d -> %d without a user event; changes: %s', before, after, parts.join(', ') || '(none)');
	});
}
