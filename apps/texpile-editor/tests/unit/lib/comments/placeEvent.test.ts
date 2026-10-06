import { describe, it, expect } from 'vitest';
import { buildAnchor } from '$lib/comments/anchor';
import { foldLog, openEvent, parseLog, placeEvent, serializeLog, type CommentEvent } from '$lib/comments/log';

const SRC = 'The introduction says something worth arguing with.\n';
const at = SRC.indexOf('worth arguing with');
const anchor = buildAnchor(SRC, at, at + 18);

const open = (id: string, file = 'main.tex'): CommentEvent =>
	openEvent({ id, file, anchor, body: 'note', by: 'test', at: '2026-01-01T00:00:00Z' });
const place = (o: { thread: string; detached?: boolean; hidden?: boolean }): CommentEvent =>
	placeEvent({ ...o, by: 'test', at: '2026-01-02T00:00:00Z' });

describe('place events', () => {
	it('is undefined until someone has looked', () => {
		const [t] = foldLog([open('a')]);
		expect(t.detached).toBeUndefined();
		expect(t.hidden).toBeUndefined();
	});

	it('records each observation', () => {
		const [t] = foldLog([open('a'), place({ thread: 'a', detached: true })]);
		expect(t.detached).toBe(true);
	});

	// the two are seen by different halves of the app - source placement by the controller, visual
	// placement by whichever editor rendered it - so one must never wipe the other
	it('a source observation leaves a visual one alone, and vice versa', () => {
		const [t] = foldLog([open('a'), place({ thread: 'a', hidden: true }), place({ thread: 'a', detached: false })]);
		expect(t.hidden).toBe(true);
		expect(t.detached).toBe(false);
	});

	it('the last observation wins', () => {
		const [t] = foldLog([open('a'), place({ thread: 'a', detached: true }), place({ thread: 'a', detached: false })]);
		expect(t.detached).toBe(false);
	});

	it('survives a round trip through the file', () => {
		const events = [open('a'), place({ thread: 'a', detached: true, hidden: false })];
		const [t] = foldLog(parseLog(serializeLog(events)));
		expect([t.detached, t.hidden]).toEqual([true, false]);
	});

	it('drops a place for a thread that is not here', () => {
		expect(foldLog([place({ thread: 'ghost', detached: true })])).toEqual([]);
	});

	// a half-written line from a bad merge must lose the observation, not fold a string into a field
	// the panel reads as a verdict
	it('rejects a malformed flag rather than trusting it', () => {
		const bad = JSON.stringify({ v: 1, t: 'place', thread: 'a', detached: 'yes', at: 'x', by: 'y' });
		const good = JSON.stringify(open('a'));
		const [t] = foldLog(parseLog(`${good}\n${bad}\n`));
		expect(t.detached).toBeUndefined();
	});

	// an older build's isEvent skips an unknown `t`, so it sees threads with no recorded status -
	// exactly the pre-feature behaviour, rather than a broken log
	it('is ignorable: dropping every place leaves the threads intact', () => {
		const events = parseLog(serializeLog([open('a'), place({ thread: 'a', detached: true })]));
		const withoutPlace = foldLog(events.filter((e) => e.t !== 'place'));
		expect(withoutPlace).toHaveLength(1);
		expect(withoutPlace[0].detached).toBeUndefined();
	});
});
