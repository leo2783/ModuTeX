// persisted app settings: userData/settings.json via the native bridge in Electron, localStorage in
// browser dev. new settings also go in the main process DEFAULT_SETTINGS so on-disk defaults match.
import { browser } from '$lib/runtime';
import { writable, get } from 'svelte/store';
import { setLocale as setParaglideLocale } from '$lib/paraglide/runtime';
import { trailingDebounce } from '$lib/trailingDebounce';

export interface AppSettings {
	reopenLastFolder: boolean;
	/** autosave edits (debounced); when off the user is warned before switching files. */
	autosave: boolean;
	lastFolder: string | null;
	sidebarOpen: boolean;
	sidebarWidth: number;
	/** Harper spell-check enabled. */
	spellcheck: boolean;
	/** custom spell-check dictionary (words to ignore). */
	dictionary: string[];
	/** table-of-contents share of the sidebar height (0..1). */
	tocFraction: number;
	/** LaTeX compile command run in the terminal; {main} expands to the main file. */
	compileCommand: string;
	compileEngine: 'tectonic' | 'system';
	/** append a marker echo after the compile command to detect when it finishes. */
	compileSentinel: boolean;
	terminalVisible: boolean;
	terminalHeight: number;
	pdfPaneWidth: number;
	pdfPaneOpen: boolean;
	/** image resize snap step as a fraction of \textwidth (0.25 = 25/50/75/100%). */
	figureResizeStep: number;
	/** render PDF pages inverted in dark mode. */
	pdfDarkPages: boolean;
	/** Draft mode: preview via the incremental per-page engine extractor instead of the
	 *  terminal compile command. Requires lualatex. */
	draftMode: boolean;
	/** name put on review comments. Blank falls back to the repo's git user.name. */
	commentAuthor: string;
	/** let an MCP client (Claude Code, Claude Desktop) read what the editor is showing. Off by
	 * default: connecting also needs a config snippet pasted into the client, so defaulting this on
	 * would open a loopback port for everyone while buying nothing until they act anyway. */
	mcpEnabled: boolean;
	/**
	 * Let a connected MCP client REWRITE the compile command outright.
	 *
	 * Separate from mcpEnabled, and off even when that is on, because it is a different kind of
	 * permission: the compile command is a shell command line, so a client that can set it can run
	 * anything this user can. Everything else the server exposes reads state or moves the window.
	 *
	 * Retargeting the OUTPUT DIRECTORY does not need this - that path goes through
	 * sanitizeOutputDir and can only ever change where the build lands.
	 */
	mcpAllowCompileCommand: boolean;
	/** whole-window zoom factor (1 = 100%), applied via webContents.setZoomFactor. */
	uiZoom: number;
	/** newest changelog version the What's New modal was dismissed for. */
	whatsNewSeen: string;
	/** live math preview tooltip in source mode. */
	mathPreview: boolean;
	/** soft-wrap long lines in Source mode instead of scrolling horizontally. */
	sourceLineWrap: boolean;
	/** widest the visual editor's text column may grow, in px. Past this the window pads with
	 *  empty space rather than stretching the measure, which is why it is adjustable. */
	visualMaxWidth: number;
	/** recompile a Typst document shortly after typing stops, rather than only on Compile.
	 *  On by default: a warm Typst rebuild is ~230ms, so unlike LaTeX's live mode there is no
	 *  cost that would justify making the user opt in. */
	typstLiveMode: boolean;
	/** the Typst preview scrolls to follow the caret. Off by default, as in tinymist */
	typstPreviewFollow: boolean;
	/** modal keybindings for the source editor and code blocks. */
	editorKeymap: 'default' | 'vim' | 'emacs';
	/** UI display language. Not the LaTeX document language (see DocumentLanguage). */
	uiLocale: 'en' | 'zh-Hans' | 'zh-Hant' | 'de';
	/** folders open across windows; maintained by the MAIN process for session restore.
	 *  read-only here: renderers never write it. */
	openFolders: string[];
}

/** default compile command. -interaction=nonstopmode keeps errors from parking the engine at its
 *  interactive prompt; -synctex=1 enables source<->PDF sync; -file-line-error gives file:line attribution. */
export const DEFAULT_COMPILE_COMMAND =
	'latexmk -lualatex -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=output {main}';

const DEFAULTS: AppSettings = {
	reopenLastFolder: true,
	autosave: true,
	lastFolder: null,
	sidebarOpen: true,
	sidebarWidth: 256,
	spellcheck: false,
	dictionary: [],
	tocFraction: 0.5,
	compileCommand: DEFAULT_COMPILE_COMMAND,
	compileEngine: 'tectonic',
	compileSentinel: true,
	terminalVisible: false,
	terminalHeight: 240,
	pdfPaneWidth: 480,
	pdfPaneOpen: false,
	figureResizeStep: 0.25,
	pdfDarkPages: true,
	draftMode: false,
	commentAuthor: '',
	mcpEnabled: false,
	mcpAllowCompileCommand: false,
	uiZoom: 1,
	whatsNewSeen: '',
	mathPreview: true,
	sourceLineWrap: true,
	// 768px = the max-w-3xl the editor column was pinned to before this became adjustable
	visualMaxWidth: 768,
	typstLiveMode: true,
	typstPreviewFollow: false,
	editorKeymap: 'default',
	uiLocale: 'en',
	openFolders: []
};

const LS_KEY = 'texpile:settings';

interface NativeSettings {
	getSettings?: () => Promise<Partial<AppSettings>>;
	setSettings?: (partial: Partial<AppSettings>) => Promise<AppSettings>;
}
function native(): NativeSettings | undefined {
	if (!browser) return undefined;
	return (window as unknown as { texpileNative?: NativeSettings }).texpileNative;
}

/** reactive global settings; defaults until loadSettings() hydrates it. */
export const settings = writable<AppSettings>({ ...DEFAULTS });

// memoize the load promise, not a boolean: every caller awaits the same hydration.
// a flag flipped before the await let early callers read stale defaults.
let loadPromise: Promise<AppSettings> | null = null;

/** hydrates settings from disk (Electron) or localStorage. idempotent. */
export function loadSettings(): Promise<AppSettings> {
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		let raw: Partial<AppSettings> = {};
		const n = native();
		if (n?.getSettings) {
			try {
				raw = await n.getSettings();
			} catch {
				/* fall back to defaults */
			}
		} else if (browser) {
			try {
				raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
			} catch {
				/* ignore malformed json */
			}
		}
		// Settings removed from the production surface must not be reintroduced by an older
		// settings.json/localStorage payload. Pick only the current schema's own keys.
		const merged = Object.fromEntries(
			Object.keys(DEFAULTS).map((key) => [key, raw[key as keyof AppSettings] ?? DEFAULTS[key as keyof AppSettings]])
		) as unknown as AppSettings;
		merged.compileEngine =
			raw.compileEngine === 'system' || raw.compileEngine === 'tectonic'
				? raw.compileEngine
				: raw.compileCommand && raw.compileCommand !== DEFAULT_COMPILE_COMMAND
					? 'system'
					: 'tectonic';
		settings.set(merged);
		// reload:false: this runs before main.ts mounts the app, so nothing has rendered
		// the base locale yet and there's nothing to correct with a reload.
		applyUiLocale(merged.uiLocale, { reload: false });
		return merged;
	})();
	return loadPromise;
}

/** syncs Paraglide's runtime locale and <html lang> to match a uiLocale value. reload defaults
 *  to true (Paraglide's default): none of the app's message() calls are reactive in place, so
 *  a locale switch after the app has already rendered needs a full reload to take effect. */
export function applyUiLocale(locale: AppSettings['uiLocale'], opts?: { reload?: boolean }): void {
	if (typeof document !== 'undefined') document.documentElement.lang = locale;
	setParaglideLocale(locale, opts);
}

/** back-compat alias used by the start screen. */
export async function getSettings(): Promise<AppSettings> {
	return loadSettings();
}

// send ONLY the changed fields: the main process merges them into settings.json, so two
// windows writing different settings can't clobber each other's fields with stale copies
function persist(patch: Partial<AppSettings>): void {
	const n = native();
	if (n?.setSettings) {
		n.setSettings(patch).catch(() => {});
		return;
	}
	if (browser) {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify(get(settings)));
		} catch {
			/* ignore */
		}
	}
}

/** merges a partial update into the global settings and persists it immediately. */
export function updateSettings(partial: Partial<AppSettings>): void {
	const next = { ...get(settings), ...partial };
	settings.set(next);
	persist(partial);
}

// A dragged slider emits a value per pointer move. The STORE has to take every one of them - that
// is what makes the editor resize under the cursor - but each persist is an IPC round trip and a
// settings.json rewrite in main, so only the value the user settles on is worth writing.
const persistSoon = trailingDebounce<Partial<AppSettings>>(250, persist);

/** updateSettings for a continuous control: applies at once, writes to disk once it settles. */
export function updateSettingsLive(partial: Partial<AppSettings>): void {
	settings.set({ ...get(settings), ...partial });
	persistSoon(partial);
}

/**
 * Deliberately NOT routed through updateSettings: flipping this also has to start or stop the
 * loopback MCP server, which only the main process can do, and main persists the setting itself as
 * part of that. Writing it here too would just race main's own write.
 *
 * Applied optimistically so the switch responds, and rolled back if main could not bind the port.
 */
export async function setMcpEnabled(enabled: boolean): Promise<void> {
	const api = (window as unknown as { texpileNative?: { mcpSetEnabled?: (v: boolean) => Promise<unknown> } }).texpileNative;
	const before = get(settings).mcpEnabled;
	settings.update((s) => ({ ...s, mcpEnabled: enabled }));
	try {
		await api?.mcpSetEnabled?.(enabled);
	} catch (e) {
		console.error('Failed to change AI assistant access:', e);
		settings.update((s) => ({ ...s, mcpEnabled: before }));
	}
}

// hydrate at module load so the store holds real values before any UI writes,
// otherwise a saved lastFolder gets clobbered with defaults
if (browser) void loadSettings();
