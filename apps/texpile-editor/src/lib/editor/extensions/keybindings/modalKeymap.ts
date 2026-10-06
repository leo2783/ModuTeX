// Vim and Emacs keybindings for the source editor
// Loaded on demand, never at startup: the vim implementation is a couple of hundred KB of key
// Source editor only.
import { Compartment, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { settings, type AppSettings } from '$lib/settings';

export type EditorKeymap = AppSettings['editorKeymap'];

// One Extension value per mode, shared across every view that asks. CodeMirror extensions are
// declarations rather than instances, so reusing them is how they are meant to be used - and it
// keeps a file switch (which remounts the editor) from re-importing the module.
const cache = new Map<EditorKeymap, Extension>();

/** the extension for a mode; an empty one for 'default', so the caller needs no branch */
export async function loadModalKeymap(mode: EditorKeymap): Promise<Extension> {
	if (mode !== 'vim' && mode !== 'emacs') return [];
	const hit = cache.get(mode);
	if (hit) return hit;
	// both put their handlers at Prec.highest, so this can sit anywhere in the extension list and
	// still win over defaultKeymap / searchKeymap / our own Mod-z boundary bindings
	const ext =
		mode === 'vim' ? (await import('@replit/codemirror-vim')).vim({ status: true }) : (await import('@replit/codemirror-emacs')).emacs();
	cache.set(mode, ext);
	return ext;
}

/**
 * Keep a view's keymap compartment following the setting, and return an unsubscribe.
 *
 * The load is async, so a fast switch (vim -> emacs before vim resolved) could apply the two out of
 * order; `wanted` is re-checked after the await and a stale result is dropped.
 */
export function bindModalKeymap(view: EditorView, compartment: Compartment): () => void {
	let wanted: EditorKeymap | null = null;
	return settings.subscribe((s) => {
		const mode = s.editorKeymap ?? 'default';
		if (mode === wanted) return;
		wanted = mode;
		void loadModalKeymap(mode).then((ext) => {
			if (wanted !== mode) return;
			// the view can be destroyed while the import is in flight (file switch, mode toggle)
			try {
				view.dispatch({ effects: compartment.reconfigure(ext) });
			} catch {
				/* destroyed view */
			}
		});
	});
}

/** a fresh compartment for the modal keymap; one per view */
export function modalKeymapCompartment(): Compartment {
	return new Compartment();
}
