// A one-way tick from "follow just sent a scroll" to the preview frame host.
//
// The viewer draws its jump ripple for every jump frame, and a follow jump must not draw one -
// but follow's frames are indistinguishable from a one-shot sync's on the wire. Only the sender
// knows which is which, and the sender (WorkspaceView's caret debounce) has no reference to the
// frame. This store is the wire between them: the sender bumps it, TypstPreview forwards a
// `quiet` message into the frame, and the bridge there swallows ripples for the next half second.
import { writable } from 'svelte/store';

/** bumped once per follow scroll actually sent (after every guard has passed) */
export const followScrollTick = writable(0);

export const noteFollowScroll = (): void => followScrollTick.update((n) => n + 1);
