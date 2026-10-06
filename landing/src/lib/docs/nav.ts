import {
	HardDriveDownload,
	Monitor,
	Rocket,
	Eye,
	PenLine,
	Code,
	Sparkles,
	Play,
	Files,
	GitBranch,
	Users,
	Bot,
	Sigma,
	Image,
	Table,
	BookMarked,
	BoxSelect,
	SpellCheck,
	type Icon
} from '@lucide/svelte';

export interface Topic {
	/** path segment under its parent (or under /docs for a top-level topic) */
	slug: string;
	title: string;
	blurb: string;
	icon: typeof Icon;
	children?: Topic[];
}

// order here is the sidebar order and the prev/next order; keep it in sync with
// `docsEntries` in svelte.config.js, which prerenders the localized variants
export const TOPICS: Topic[] = [
	{
		slug: 'installation',
		title: 'Installation',
		blurb: 'Install Texpile, then a TeX distribution for it to compile with.',
		icon: HardDriveDownload,
		children: [
			{ slug: 'windows', title: 'Windows x64', blurb: 'The installer, then TeX Live or MiKTeX.', icon: Monitor }
		]
	},
	{
		slug: 'getting-started',
		title: 'Getting started',
		blurb: 'Open a folder, pick a main file, and understand what a save actually writes.',
		icon: Rocket
	},
	{
		slug: 'live-preview',
		title: 'Live preview',
		blurb: 'Pages typeset as you type, by your own TeX, with no manual compile step.',
		icon: Eye
	},
	{
		slug: 'visual-editing',
		title: 'Visual editing',
		blurb: 'Your .tex rendered as formatted text, math, figures, and tables, and saved back unchanged.',
		icon: PenLine,
		children: [
			{ slug: 'math', title: 'Equations', blurb: 'Inline and display math, numbered and referenced, with a symbol toolbar.', icon: Sigma },
			{ slug: 'images', title: 'Images', blurb: 'Drag, paste, or insert a figure; resize, caption, and number it visually.', icon: Image },
			{
				slug: 'tables',
				title: 'Tables',
				blurb: 'Insert by size, edit cells directly, merge, and control rules from a settings panel.',
				icon: Table
			},
			{
				slug: 'citations',
				title: 'Citations',
				blurb: 'Type @ for a picker across your bibliography and your own figures, tables, and equations.',
				icon: BookMarked
			},
			{
				slug: 'smart-selection',
				title: 'Smart selection',
				blurb: 'Select a whole block, then its parent, straight from the toolbar.',
				icon: BoxSelect
			}
		]
	},
	{
		slug: 'source-editing',
		title: 'Source editing',
		blurb: 'A full LaTeX code editor, with Vim and Emacs keymaps and multiple cursors.',
		icon: Code
	},
	{
		slug: 'spell-check',
		title: 'Spell check',
		blurb: 'Catches typos and grammar in your prose, and never flags your LaTeX.',
		icon: SpellCheck
	},
	{
		slug: 'intellisense',
		title: 'Intellisense',
		blurb: 'Completion, go-to-definition, and hover, built from a static parse of the whole project.',
		icon: Sparkles
	},
	{
		slug: 'compiling',
		title: 'Compiling',
		blurb: 'Your own command, in a real shell, with the log read into a Problems panel.',
		icon: Play
	},
	{
		slug: 'projects',
		title: 'Projects and files',
		blurb: 'The folder is the project: explorer, tabs, multi-file documents, search, and references.',
		icon: Files
	},
	{
		slug: 'version-control',
		title: 'Version control',
		blurb: 'Stage, commit, and diff against the last commit without leaving the editor.',
		icon: GitBranch
	},
	{
		slug: 'collaboration',
		title: 'Real-time collaboration',
		blurb: 'Edit a folder with other people in real time, end to end encrypted, with no account.',
		icon: Users
	},
	{
		slug: 'mcp',
		title: 'AI assistants (MCP)',
		blurb: 'Let Claude Code or Codex read your editor state and drive the app, locally.',
		icon: Bot
	}
];

export const hrefFor = (slug: string) => `/docs/${slug}`;

interface FlatEntry {
	topic: Topic;
	path: string;
	parent: Topic | null;
}

/** depth-first flattening (parent immediately followed by its children), for the pager and route
 * lookups. Computed once at module load; TOPICS is static per page render. */
const FLAT: FlatEntry[] = (() => {
	const out: FlatEntry[] = [];
	for (const t of TOPICS) {
		out.push({ topic: t, path: t.slug, parent: null });
		for (const c of t.children ?? []) out.push({ topic: c, path: `${t.slug}/${c.slug}`, parent: t });
	}
	return out;
})();

/** prev/next for the footer pager; nulls at the ends. `path` is the full slug (e.g. "visual-editing/math"). */
export function siblings(path: string) {
	const i = FLAT.findIndex((e) => e.path === path);
	return {
		prev: i > 0 ? { slug: FLAT[i - 1].path, title: FLAT[i - 1].topic.title } : null,
		next: i >= 0 && i < FLAT.length - 1 ? { slug: FLAT[i + 1].path, title: FLAT[i + 1].topic.title } : null
	};
}

/** the topic (and its parent, if any) for a full slug path, for the sidebar's active-state and breadcrumb. */
export function lookup(path: string): { topic: Topic; parent: Topic | null } | null {
	const e = FLAT.find((e) => e.path === path);
	return e ? { topic: e.topic, parent: e.parent } : null;
}
