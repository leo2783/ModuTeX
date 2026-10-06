import { describe, it, expect } from 'vitest';
import { buildAnchor } from '$lib/comments/anchor';
import {
	deleteEvent,
	deleteMessageEvent,
	editEvent,
	foldLog,
	moveEvent,
	openEvent,
	parseLog,
	replyEvent,
	resolveEvent,
	serializeLog,
	type CommentEvent
} from '$lib/comments/log';

const anchor = buildAnchor('some text to quote here', 5, 9);
const open = openEvent({ id: 't1', file: 'main.tex', by: 'ana', body: 'why this?', anchor, at: '2026-08-10T00:00:00Z' });

describe('parseLog', () => {
	it('round-trips through serializeLog', () => {
		const events = [open, replyEvent({ id: 'm2', thread: 't1', by: 'bo', body: 'fixed', at: '2026-08-10T00:01:00Z' })];
		expect(parseLog(serializeLog(events))).toEqual(events);
	});

	it('skips unreadable lines instead of losing the file', () => {
		// what a git conflict actually leaves behind, wrapped round a good line
		const text = ['<<<<<<< HEAD', JSON.stringify(open), '=======', '{not json', '>>>>>>> branch', ''].join('\n');
		const events = parseLog(text);
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(open);
	});

	it('drops events from a newer log version', () => {
		const future = JSON.stringify({ ...open, v: 99 });
		expect(parseLog(future)).toEqual([]);
	});

	it('drops events missing the fields their type needs', () => {
		const noAnchor = JSON.stringify({ v: 1, t: 'open', id: 'x', file: 'a.tex', by: 'ana', body: 'hi', at: 'now' });
		expect(parseLog(noAnchor)).toEqual([]);
	});
});

describe('foldLog', () => {
	it('builds a thread from its opening event', () => {
		const [thread] = foldLog([open]);
		expect(thread.id).toBe('t1');
		expect(thread.file).toBe('main.tex');
		expect(thread.resolved).toBe(false);
		expect(thread.messages).toEqual([{ id: 't1', at: '2026-08-10T00:00:00Z', by: 'ana', body: 'why this?' }]);
	});

	it('appends replies and applies the latest resolve', () => {
		const [thread] = foldLog([
			open,
			replyEvent({ id: 'm2', thread: 't1', by: 'bo', body: 'because', at: '2026-08-10T00:01:00Z' }),
			resolveEvent({ thread: 't1', by: 'bo', resolved: true, at: '2026-08-10T00:02:00Z' }),
			resolveEvent({ thread: 't1', by: 'ana', resolved: false, at: '2026-08-10T00:03:00Z' })
		]);
		expect(thread.messages.map((m) => m.body)).toEqual(['why this?', 'because']);
		expect(thread.resolved).toBe(false);
	});

	it('drops a deleted thread', () => {
		expect(foldLog([open, deleteEvent({ thread: 't1', by: 'ana', at: '2026-08-10T00:04:00Z' })])).toEqual([]);
	});

	it('ignores a reply whose thread never arrived', () => {
		const orphan = replyEvent({ id: 'm9', thread: 'gone', by: 'bo', body: 'stray', at: 'now' });
		expect(foldLog([open, orphan])[0].messages).toHaveLength(1);
	});

	it('rewrites a message in place and marks it edited', () => {
		const [thread] = foldLog([open, editEvent({ message: 't1', body: 'why THIS?', by: 'ana', at: '2026-08-10T00:05:00Z' })]);
		expect(thread.messages[0].body).toBe('why THIS?');
		expect(thread.messages[0].editedAt).toBe('2026-08-10T00:05:00Z');
	});

	it('drops one message without touching the rest of the thread', () => {
		const reply = replyEvent({ id: 'm2', thread: 't1', by: 'bo', body: 'because', at: 'now' });
		const [thread] = foldLog([open, reply, deleteMessageEvent({ message: 'm2', by: 'bo', at: 'now' })]);
		expect(thread.messages.map((m) => m.id)).toEqual(['t1']);
	});

	// a thread IS its conversation; delete the last of it and all that is left is a quote nobody
	// said anything about
	it('drops the thread when its last message goes', () => {
		expect(foldLog([open, deleteMessageEvent({ message: 't1', by: 'ana', at: 'now' })])).toEqual([]);
	});

	it('ignores an edit for a message that never arrived', () => {
		const [thread] = foldLog([open, editEvent({ message: 'gone', body: 'nope', by: 'bo', at: 'now' })]);
		expect(thread.messages[0].body).toBe('why this?');
	});

	// git can concatenate the same line twice; folding has to be idempotent or a merge duplicates
	// every message and resets threads that had already been replied to
	it('survives duplicated events', () => {
		const reply = replyEvent({ id: 'm2', thread: 't1', by: 'bo', body: 'because', at: 'now' });
		const events: CommentEvent[] = [open, reply, open, reply];
		const [thread] = foldLog(events);
		expect(thread.messages).toHaveLength(2);
	});

	it('moves a file rename over its threads', () => {
		const [thread] = foldLog([open, moveEvent({ from: 'main.tex', to: 'chapters/intro.tex', by: 'ana', at: 'now' })]);
		expect(thread.file).toBe('chapters/intro.tex');
		// round-trips the log format, so old files with moves keep folding the same way
		const [reparsed] = foldLog(parseLog(serializeLog([open, moveEvent({ from: 'main.tex', to: 'b.tex', by: 'ana', at: 'now' })])));
		expect(reparsed.file).toBe('b.tex');
	});

	it('moves a directory rename over every thread under it', () => {
		const deep = openEvent({ id: 't2', file: 'ch/one.tex', by: 'ana', body: 'x', anchor, at: 'now' });
		const threads = foldLog([open, deep, moveEvent({ from: 'ch', to: 'chapters', by: 'ana', at: 'now' })]);
		expect(threads.find((t) => t.id === 't2')!.file).toBe('chapters/one.tex');
		// main.tex is not under ch/ - and in particular a PREFIX of a filename must not count
		expect(threads.find((t) => t.id === 't1')!.file).toBe('main.tex');
	});

	it('applies a move only to threads that exist at that point in the log', () => {
		const later = openEvent({ id: 't2', file: 'main.tex', by: 'bo', body: 'new one', anchor, at: 'now' });
		const threads = foldLog([open, moveEvent({ from: 'main.tex', to: 'old.tex', by: 'ana', at: 'now' }), later]);
		expect(threads.find((t) => t.id === 't1')!.file).toBe('old.tex');
		// opened AFTER the move, on a file recreated under the old name: stays where it was written
		expect(threads.find((t) => t.id === 't2')!.file).toBe('main.tex');
	});
});
