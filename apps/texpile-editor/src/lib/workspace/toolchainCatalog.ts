// What each external program is FOR, and how to get it — the descriptive half of the Toolchain
// panel. The probing half lives in the main process (electron/src/toolchain.ts); this file is pure
// data so it can be unit-tested without spawning anything.
//
// Install hints are per-platform because the honest answer differs: tinymist is on brew, winget and
// scoop but on no Debian/Ubuntu/Fedora package, while a TeX distribution is a 5GB download that no
// package manager should be blamed for.
import { isMac } from '$lib/platform';

export type ToolGroup = 'latex' | 'typst' | 'general';

export interface ToolInfo {
	/** matches ToolProbe.id from the main process, or 'tinymist' which is probed separately */
	id: string;
	/** the binary's own name; a proper noun, never translated */
	name: string;
	group: ToolGroup;
	/** what stops working without it */
	purpose: string;
	/** true when the app still works without it, just with one feature missing */
	optional: boolean;
	install: { win: string; mac: string; linux: string };
}

const TEX_DISTRO = {
	win: 'Install MiKTeX or TeX Live',
	mac: 'Install MacTeX',
	linux: 'Install TeX Live (texlive-full)'
};

export const TOOLS: ToolInfo[] = [
	{
		id: 'latexmk',
		name: 'latexmk',
		group: 'latex',
		purpose: 'Runs the LaTeX compile, re-running passes until references settle.',
		optional: true,
		install: TEX_DISTRO
	},
	{ id: 'pdflatex', name: 'pdflatex', group: 'latex', purpose: 'TeX engine.', optional: true, install: TEX_DISTRO },
	{
		id: 'lualatex',
		name: 'lualatex',
		group: 'latex',
		purpose: 'TeX engine; also the one live preview uses.',
		optional: true,
		install: TEX_DISTRO
	},
	{ id: 'xelatex', name: 'xelatex', group: 'latex', purpose: 'TeX engine.', optional: true, install: TEX_DISTRO },
	{ id: 'biber', name: 'biber', group: 'latex', purpose: 'Bibliography backend for biblatex.', optional: true, install: TEX_DISTRO },
	{
		id: 'bibtex',
		name: 'bibtex',
		group: 'latex',
		purpose: 'Bibliography backend for classic \\bibliography.',
		optional: true,
		install: TEX_DISTRO
	},
	{
		id: 'latexindent',
		name: 'latexindent',
		group: 'latex',
		purpose: 'Reindents the document (Format Document).',
		optional: true,
		install: TEX_DISTRO
	},
	{
		id: 'synctex',
		name: 'synctex',
		group: 'latex',
		purpose: 'Jumps between the source and the matching place in the PDF.',
		optional: true,
		install: TEX_DISTRO
	},
	{
		id: 'tinymist',
		name: 'tinymist',
		group: 'typst',
		purpose: 'Compiles Typst documents and provides completion, hover and live errors.',
		optional: true,
		install: {
			win: 'winget install Myriad-Dreamin.Tinymist',
			mac: 'brew install tinymist',
			linux: 'curl -LsSf https://github.com/Myriad-Dreamin/tinymist/releases/latest/download/tinymist-installer.sh | sh'
		}
	},
	{
		id: 'git',
		name: 'git',
		group: 'general',
		purpose: 'Source control panel and file history.',
		optional: true,
		install: {
			win: 'winget install Git.Git',
			mac: 'brew install git',
			linux: 'Install git with your package manager'
		}
	}
];

/** The install command for the platform this window is running on. */
export function installHint(tool: ToolInfo): string {
	if (isMac) return tool.install.mac;
	// the renderer has no process.platform; anything not macOS and not Windows-shaped is Linux
	const win = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
	return win ? tool.install.win : tool.install.linux;
}

export const toolsInGroup = (group: ToolGroup): ToolInfo[] => TOOLS.filter((t) => t.group === group);
