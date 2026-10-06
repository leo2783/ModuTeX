// reactive state for the open workspace; the file path is the identity, no doc ids
import { writable } from 'svelte/store';
import { browser } from '$lib/runtime';
import { isTypstCommand } from './typstCommand';
import type { TexFile, TreeEntry } from './fileSystem';
import type { FoldedSectionState } from 'modutex-contracts';

const RECENT_KEY = 'texpile:recentFolders';
// ONE entry per workspace folder, everything the app remembers about it grouped together —
// see WorkspaceEntry. (recentFolders stays its own ordered list: it is an MRU, not per-folder config.)
const WORKSPACES_KEY = 'texpile:workspaces';
// the four parallel per-folder maps this store grew historically; migrated into WORKSPACES_KEY
// on first load and then removed
const LEGACY_KEYS = {
	main: 'texpile:mainFiles',
	lastFile: 'texpile:lastFiles',
	cmd: 'texpile:compileCommands',
	outputs: 'texpile:compileOutputs'
} as const;

export const workspaceRoot = writable<string | null>(null);

export const texFiles = writable<TexFile[]>([]);

export const fileTree = writable<TreeEntry[]>([]);

export const activeFilePath = writable<string | null>(null);

/** the main entry .tex, anchors cross-file macro resolution. auto-detected, user-overridable, persisted per folder. */
export const mainFile = writable<string | null>(null);

export const isDirty = writable<boolean>(false);

// Declared BEFORE the store below, and it has to stay there. loadRecent() is hoisted so calling it
// at init works, but the const is not: reading it from inside that call hits the temporal dead zone,
// throws, and the catch quietly returns [] - so the list loaded as empty every launch and the first
// folder opened overwrote the whole history with itself.
const MAX_RECENT = 8;

/** most-recent first, persisted to localStorage. */
export const recentFolders = writable<string[]>(loadRecent());

// cap on READ as well as write: the stored value is just localStorage, so a hand-edited or
// older-format entry would otherwise render an unbounded list until the next folder open trims it
function loadRecent(): string[] {
	if (!browser) return [];
	try {
		const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT) : [];
	} catch {
		return [];
	}
}

export function addRecentFolder(path: string): void {
	recentFolders.update((list) => {
		const next = [path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENT);
		if (browser) localStorage.setItem(RECENT_KEY, JSON.stringify(next));
		return next;
	});
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Windows volumes and UNC shares are case-insensitive; POSIX workspaces are not. */
function isWindowsPath(path: string): boolean {
	const normalized = norm(path);
	return /^[a-z]:($|\/)/i.test(normalized) || normalized.startsWith('//');
}

function workspaceStorageKey(root: string): string {
	const normalized = norm(root);
	return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** path of abs relative to root (forward slashes), or abs unchanged if not under root. */
function relInRoot(root: string, abs: string): string {
	const r = norm(root) + '/';
	const a = norm(abs);
	const caseInsensitive = isWindowsPath(root);
	const comparableRoot = caseInsensitive ? r.toLowerCase() : r;
	const comparablePath = caseInsensitive ? a.toLowerCase() : a;
	return comparablePath.startsWith(comparableRoot) ? a.slice(r.length) : a;
}
/** joins a folder + a stored relative path back into an absolute path (native-ish separators). */
function absInRoot(root: string, rel: string): string {
	const sep = root.includes('\\') ? '\\' : '/';
	// join the WHOLE path in the root's own separator. norm() forward-slashes the root, so
	// appending a backslash-joined tail to it produced "C:/dir\sub\file.tex" -- fine for the fs,
	// which accepts either, but it matches nothing when compared against the tree's own
	// all-backslash paths, so a restored file never highlighted as the open one.
	return norm(root).split('/').join(sep) + sep + rel.split('/').join(sep);
}

/** manual overrides for where the compile writes its PDF/log, when auto-detection guesses wrong. */
export interface CompileOutputs {
	/** path to the compiled PDF (relative to root, or absolute); blank = auto-detect from command. */
	pdf?: string;
	/** path to the .log (relative to root, or absolute); blank = auto-detect (next to the PDF). */
	log?: string;
}

/** which typesetter Compile drives. 'auto' (the default for every new workspace) follows the
 *  main file's extension. Stored EXPLICITLY - never inferred from the command string. */
export type CompileFormat = 'latex' | 'typst' | 'auto';

/** one format's own compile config; latex and typst each keep theirs, so switching the format
 *  switch never throws the other side's command away. */
interface FormatConfig {
	engine?: 'tectonic' | 'system';
	command?: string;
	outputs?: CompileOutputs;
}

/** everything the app remembers about one workspace folder, grouped under its root path. */
interface WorkspaceEntry {
	/** root-relative main file (compile target + macro-scan anchor) */
	main?: string;
	/** root-relative last-open file, restored on reopening the folder */
	lastFile?: string;
	/** the format switch; absent = 'auto' */
	compile?: 'latex' | 'typst';
	/** folded visual-editor sections, indexed by root-relative file path */
	foldedSections?: Record<string, FoldedSectionState[]>;
	latex?: FormatConfig;
	typst?: FormatConfig;
	/**
	 * Compile commands accepted for this folder, per format.
	 *
	 * Texpile executes the compile command, so one arriving in .texpile/config.json from a cloned
	 * repository is not run until the user has said yes to it (see projectConfig.ts). That decision
	 * belongs to THIS MACHINE, never to the project file - a config that could mark itself trusted
	 * would be no protection at all - and it is per folder, so it lives here with everything else
	 * this app remembers about a folder rather than in a second map beside it.
	 */
	trusted?: { latex?: string; typst?: string };
	/** pre-format-split fields, migrated on load and never written again */
	compileCommand?: string;
	outputs?: CompileOutputs;
}

function readJsonObject<T extends object>(key: string): T | null {
	try {
		const v = JSON.parse(localStorage.getItem(key) || 'null');
		return isPlainRecord(v) ? (v as T) : null;
	} catch {
		return null;
	}
}

function canonicalWorkspaceMap(value: Record<string, unknown>): { map: Record<string, WorkspaceEntry>; changed: boolean } {
	const map = Object.create(null) as Record<string, WorkspaceEntry>;
	const collisions = new Set<string>();
	let changed = false;

	for (const [root, rawEntry] of Object.entries(value)) {
		const key = workspaceStorageKey(root);
		if (!key || !isPlainRecord(rawEntry)) {
			changed = true;
			continue;
		}

		if (collisions.has(key)) {
			changed = true;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(map, key)) {
			// Two persisted aliases can disagree. Drop both rather than choosing one by key order.
			delete map[key];
			collisions.add(key);
			changed = true;
			continue;
		}

		map[key] = { ...rawEntry } as WorkspaceEntry;
		if (key !== root) changed = true;
	}

	return { map, changed };
}

/**
 * A pre-format-split entry stored one flat compileCommand/outputs; sort those into the format
 * slots. This is the ONLY place a format is ever inferred from a command string - one time, at
 * migration - and an inferred pin is kept so migrated folders behave exactly as before.
 */
function normalizeEntry(e: WorkspaceEntry): boolean {
	if (e.compileCommand === undefined && e.outputs === undefined) return false;
	const legacyCommand = typeof e.compileCommand === 'string' ? e.compileCommand : undefined;
	const legacyOutputs = isPlainRecord(e.outputs) ? e.outputs : undefined;
	const fmt: 'latex' | 'typst' = legacyCommand
		? isTypstCommand(legacyCommand)
			? 'typst'
			: 'latex'
		: e.main && /\.typ$/i.test(e.main)
			? 'typst'
			: 'latex';
	const cfg = isPlainRecord(e[fmt]) ? e[fmt] : {};
	if (legacyCommand && !cfg.command) cfg.command = legacyCommand;
	if (legacyOutputs && !cfg.outputs) cfg.outputs = legacyOutputs as CompileOutputs;
	if (cfg.command || cfg.outputs) e[fmt] = cfg;
	if (legacyCommand) e.compile = fmt;
	delete e.compileCommand;
	delete e.outputs;
	return true;
}

/**
 * The per-workspace map, migrating the four parallel legacy maps into it on first load. The
 * migration runs at most once: as soon as WORKSPACES_KEY exists it is the only source of truth,
 * and the legacy keys are deleted so stale copies can't shadow later edits.
 */
function loadWorkspaces(): Record<string, WorkspaceEntry> {
	if (!browser) return {};
	const current = readJsonObject<Record<string, unknown>>(WORKSPACES_KEY);
	if (current) {
		const canonical = canonicalWorkspaceMap(current);
		let changed = canonical.changed;
		for (const e of Object.values(canonical.map)) if (normalizeEntry(e)) changed = true;
		if (changed) localStorage.setItem(WORKSPACES_KEY, JSON.stringify(canonical.map));
		return canonical.map;
	}
	const merged: Record<string, WorkspaceEntry> = {};
	const entry = (root: string) => (merged[root] ??= {});
	for (const [root, v] of Object.entries(readJsonObject<Record<string, string>>(LEGACY_KEYS.main) ?? {})) {
		if (typeof v === 'string' && v) entry(root).main = v;
	}
	for (const [root, v] of Object.entries(readJsonObject<Record<string, string>>(LEGACY_KEYS.lastFile) ?? {})) {
		if (typeof v === 'string' && v) entry(root).lastFile = v;
	}
	for (const [root, v] of Object.entries(readJsonObject<Record<string, string>>(LEGACY_KEYS.cmd) ?? {})) {
		if (typeof v === 'string' && v) entry(root).compileCommand = v;
	}
	for (const [root, v] of Object.entries(readJsonObject<Record<string, CompileOutputs>>(LEGACY_KEYS.outputs) ?? {})) {
		if (v && typeof v === 'object') entry(root).outputs = v;
	}
	for (const e of Object.values(merged)) normalizeEntry(e);
	if (Object.keys(merged).length > 0) {
		localStorage.setItem(WORKSPACES_KEY, JSON.stringify(merged));
		for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
	}
	return merged;
}

// Storage keys are canonicalized during load. Windows and UNC paths are folded; POSIX stays exact.
function keyFor(map: Record<string, unknown>, root: string): string {
	void map;
	return workspaceStorageKey(root);
}

function workspaceEntry(root: string): WorkspaceEntry {
	const map = loadWorkspaces();
	return map[keyFor(map, root)] ?? {};
}

/** read-modify-write one folder's entry; an entry with nothing left in it disappears entirely. */
function updateWorkspace(root: string, mutate: (entry: WorkspaceEntry) => void): void {
	if (!browser) return;
	const map = loadWorkspaces();
	const key = keyFor(map, root);
	const entry = map[key] ?? {};
	mutate(entry);
	if (Object.keys(entry).length > 0) map[key] = entry;
	else delete map[key];
	localStorage.setItem(WORKSPACES_KEY, JSON.stringify(map));
}

/** the persisted main-file path for a folder (absolute), or null if none was saved. */
export function savedMainFile(root: string): string | null {
	const rel = workspaceEntry(root).main;
	return rel ? absInRoot(root, rel) : null;
}

/**
 * The same value ROOT-RELATIVE, exactly as stored, for writing into .texpile/config.json.
 *
 * Not savedMainFile() put back through a relativiser: fileSystem's relativeTo compares
 * case-sensitively, and Windows hands us the drive letter in either case - which is why relInRoot
 * below lowercases before comparing. It silently returned the absolute path instead, and an
 * absolute path in a file meant to travel between machines is worse than no file at all.
 */
export function savedMainFileRel(root: string): string | null {
	return workspaceEntry(root).main ?? null;
}

/** remembers (or clears) the chosen main file for a folder, and updates the live store. */
export function setMainFile(root: string, path: string | null): void {
	mainFile.set(path);
	updateWorkspace(root, (e) => {
		if (path) e.main = relInRoot(root, path);
		else delete e.main;
	});
}

/** the last file that was open in a folder (absolute), or null if none was recorded. */
export function savedLastFile(root: string): string | null {
	const rel = workspaceEntry(root).lastFile;
	return rel ? absInRoot(root, rel) : null;
}

/** records the file currently open in a folder (called on every active-file change). */
export function setLastFile(root: string, path: string): void {
	const rel = relInRoot(root, path);
	if (rel === norm(path)) return; // not under this root (mid folder-switch): never record cross-root
	updateWorkspace(root, (e) => {
		e.lastFile = rel;
	});
}

function foldedSectionFile(root: string, path: string): string | null {
	const relativeFile = relInRoot(root, path);
	return relativeFile === norm(path) ? null : workspaceRelativeFile(relativeFile, isWindowsPath(root));
}

/** A storage key is always a normalized file path below a workspace, never an OS path. */
function workspaceRelativeFile(value: string, caseInsensitive: boolean): string | null {
	const relativeFile = norm(value);
	if (!relativeFile || relativeFile.startsWith('/') || /^[a-z]:/i.test(relativeFile)) return null;
	const segments = relativeFile.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
	return caseInsensitive ? relativeFile.toLowerCase() : relativeFile;
}

function canonicalFoldedSectionState(state: unknown, relativeFile: string, caseInsensitive: boolean): FoldedSectionState | null {
	if (!isPlainRecord(state)) return null;
	const candidate = state as Partial<FoldedSectionState>;
	const candidateFile = typeof candidate.relativeFile === 'string' ? workspaceRelativeFile(candidate.relativeFile, caseInsensitive) : null;
	if (
		candidateFile !== relativeFile ||
		!Array.isArray(candidate.ancestorHeadingChain) ||
		!candidate.ancestorHeadingChain.every((heading) => typeof heading === 'string') ||
		typeof candidate.level !== 'number' ||
		!Number.isInteger(candidate.level) ||
		candidate.level <= 0 ||
		typeof candidate.occurrence !== 'number' ||
		!Number.isInteger(candidate.occurrence) ||
		candidate.occurrence < 0 ||
		candidate.folded !== true
	) {
		return null;
	}

	return {
		relativeFile,
		ancestorHeadingChain: [...candidate.ancestorHeadingChain],
		level: candidate.level,
		occurrence: candidate.occurrence,
		folded: true
	};
}

function cloneFoldedSectionState(state: FoldedSectionState): FoldedSectionState {
	return { ...state, ancestorHeadingChain: [...state.ancestorHeadingChain] };
}

/** Canonicalize the complete array or reject it. `for...of` deliberately sees sparse-array holes. */
function canonicalFoldedSectionStates(
	states: readonly unknown[],
	relativeFile: string,
	caseInsensitive: boolean
): FoldedSectionState[] | null {
	const canonical: FoldedSectionState[] = [];
	for (const state of states) {
		const next = canonicalFoldedSectionState(state, relativeFile, caseInsensitive);
		if (!next) return null;
		canonical.push(next);
	}
	return canonical;
}

/** Discard malformed persisted data before it can be spread back into the workspace entry. */
function canonicalFoldedSections(value: unknown, caseInsensitive: boolean): Record<string, FoldedSectionState[]> {
	const canonical = Object.create(null) as Record<string, FoldedSectionState[]>;
	const collisions = new Set<string>();
	if (!isPlainRecord(value)) return canonical;

	for (const [relativeFile, states] of Object.entries(value)) {
		const canonicalFile = workspaceRelativeFile(relativeFile, caseInsensitive);
		if (!canonicalFile || !Array.isArray(states) || !states.length || collisions.has(canonicalFile)) continue;
		if (Object.prototype.hasOwnProperty.call(canonical, canonicalFile)) {
			delete canonical[canonicalFile];
			collisions.add(canonicalFile);
			continue;
		}
		const valid = canonicalFoldedSectionStates(states, canonicalFile, caseInsensitive);
		if (valid) canonical[canonicalFile] = valid;
	}
	return canonical;
}

function hasFoldedSections(entry: WorkspaceEntry): boolean {
	return Object.prototype.hasOwnProperty.call(entry, 'foldedSections');
}

/** Rewrites just this optional field, preserving all other workspace metadata. */
function normalizePersistedFoldedSections(root: string): Record<string, FoldedSectionState[]> {
	const current = workspaceEntry(root);
	const caseInsensitive = isWindowsPath(root);
	const canonical = canonicalFoldedSections(current.foldedSections, caseInsensitive);
	if (!hasFoldedSections(current)) return canonical;

	updateWorkspace(root, (entry) => {
		const next = canonicalFoldedSections(entry.foldedSections, caseInsensitive);
		if (Object.keys(next).length) entry.foldedSections = next;
		else delete entry.foldedSections;
	});
	return canonical;
}

/** Returns the saved folds for one workspace-relative file, never accepting cross-workspace state. */
export function savedFoldedSections(root: string, path: string): FoldedSectionState[] {
	const relativeFile = foldedSectionFile(root, path);
	if (!relativeFile) return [];
	const saved = normalizePersistedFoldedSections(root)[relativeFile] ?? [];
	return saved.map(cloneFoldedSectionState);
}

/**
 * Replaces one file's fold state. The plugin emits only folded descriptors; once the final one is
 * removed, this deletes both the file entry and the containing field so reopening has no stale UI.
 */
export function setFoldedSections(root: string, path: string, states: readonly FoldedSectionState[]): void {
	const relativeFile = foldedSectionFile(root, path);
	if (!relativeFile) return;
	const caseInsensitive = isWindowsPath(root);
	const next = canonicalFoldedSectionStates(states, relativeFile, caseInsensitive);
	const current = workspaceEntry(root);
	if (!next) {
		if (hasFoldedSections(current)) normalizePersistedFoldedSections(root);
		return;
	}
	if (!next.length && !hasFoldedSections(current)) return;

	updateWorkspace(root, (entry) => {
		const canonical = canonicalFoldedSections(entry.foldedSections, caseInsensitive);
		if (next.length) {
			canonical[relativeFile] = next;
		} else {
			delete canonical[relativeFile];
		}
		if (Object.keys(canonical).length) entry.foldedSections = canonical;
		else delete entry.foldedSections;
	});
}

/** the folder's format switch; 'auto' when never set - every new workspace starts there. */
export function savedCompileFormat(root: string): CompileFormat {
	return workspaceEntry(root).compile ?? 'auto';
}

/** pins the format switch; 'auto' clears the field back to the default. */
export function setCompileFormat(root: string, format: CompileFormat): void {
	updateWorkspace(root, (e) => {
		if (format === 'auto') delete e.compile;
		else e.compile = format;
	});
}

/** the CONCRETE format in effect: a pin wins, Auto follows the main file's extension. */
export function effectiveCompileFormat(root: string | null, main: string | null): 'latex' | 'typst' {
	const pinned = root ? savedCompileFormat(root) : 'auto';
	if (pinned !== 'auto') return pinned;
	return main && /\.typ$/i.test(main) ? 'typst' : 'latex';
}

/** the saved command for ONE format's slot, or null when that slot is empty. */
export function savedFormatCommand(root: string, format: 'latex' | 'typst'): string | null {
	return workspaceEntry(root)[format]?.command ?? null;
}

/** An explicit engine wins; legacy project commands remain system commands. */
export function savedLatexEngine(root: string): 'tectonic' | 'system' | null {
	const config = workspaceEntry(root).latex;
	return config?.engine === 'tectonic' || config?.engine === 'system' ? config.engine : config?.command ? 'system' : null;
}

export function setLatexEngine(root: string, engine: 'tectonic' | 'system'): void {
	updateWorkspace(root, (entry) => {
		entry.latex = { ...entry.latex, engine };
	});
}

/** saves (or clears) one format's command without touching the other format's slot. */
export function setFormatCommand(root: string, format: 'latex' | 'typst', cmd: string | null): void {
	updateWorkspace(root, (e) => {
		const cfg = e[format] ?? {};
		if (cmd) cfg.command = cmd;
		else delete cfg.command;
		if (cfg.command || cfg.outputs || cfg.engine) e[format] = cfg;
		else delete e[format];
	});
}

/** one format's manual output-path overrides (empty object if none saved). */
export function savedFormatOutputs(root: string, format: 'latex' | 'typst'): CompileOutputs {
	return workspaceEntry(root)[format]?.outputs ?? {};
}

/** persists one format's output overrides; an all-blank set removes them. */
export function setFormatOutputs(root: string, format: 'latex' | 'typst', outputs: CompileOutputs): void {
	const clean: CompileOutputs = {};
	if (outputs.pdf) clean.pdf = outputs.pdf;
	if (outputs.log) clean.log = outputs.log;
	updateWorkspace(root, (e) => {
		const cfg = e[format] ?? {};
		if (clean.pdf || clean.log) cfg.outputs = clean;
		else delete cfg.outputs;
		if (cfg.command || cfg.outputs || cfg.engine) e[format] = cfg;
		else delete e[format];
	});
}

/**
 * Has this exact command been accepted for this folder?
 *
 * Exact string equality, deliberately. Anything looser - a prefix, the leading binary - would let
 * an accepted command be extended into something else without asking again, which is the whole
 * thing this guards against.
 */
export function isCommandTrusted(root: string, format: 'latex' | 'typst', command: string): boolean {
	return workspaceEntry(root).trusted?.[format] === command;
}

/** record a command as accepted: the user typed it here, or pressed Use it on the project bar. */
export function trustCommand(root: string, format: 'latex' | 'typst', command: string): void {
	updateWorkspace(root, (e) => {
		e.trusted = { ...e.trusted, [format]: command };
	});
}
