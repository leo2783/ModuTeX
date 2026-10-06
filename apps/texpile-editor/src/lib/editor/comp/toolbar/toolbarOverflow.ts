import type { Snippet } from 'svelte';

export interface OverflowItem {
	id: string;
	/** never collapses; the bar's essential controls */
	pinned?: boolean;
	/** payload for bars whose controls come from a list rather than being written out one by one:
	 *  one snippet reads this instead of needing a snippet per control */
	data?: unknown;
	render: Snippet<[OverflowItem]>;
}
