export type HelpTopic = 'getting-started' | 'editing' | 'tables-math' | 'compilation' | 'shortcuts' | 'installation' | 'licenses' | 'agpl' | 'apache' | 'notices';
/** Routing does not need the lazy Help page's title catalogue. */
export function helpTopic(hash: string): HelpTopic {
	return hash.slice('#/help/'.length).match(/^(getting-started|editing|tables-math|compilation|shortcuts|installation|licenses|agpl|apache|notices)$/)?.[0] as HelpTopic ?? 'getting-started';
}
