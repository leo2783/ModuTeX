import type { Preferences } from '../../state/preferences.ts';

export type DocumentCommand = 'open' | 'save' | 'compile';
export function documentCommand(event: KeyboardEvent, binding: Preferences['compileShortcut']): DocumentCommand | null {
	if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey === event.metaKey) return null;
	const key = event.key.toLowerCase();
	if (!event.shiftKey && key === 'o') return 'open';
	if (!event.shiftKey && key === 's') return 'save';
	if (binding === 'mod-enter' && key === 'enter' && !event.shiftKey || binding === 'mod-shift-b' && key === 'b' && event.shiftKey) {
		// Editors own their text keys; application form fields must retain their own input behavior.
		const target = event.target;
		if (target && 'closest' in target && typeof target.closest === 'function' &&
			target.closest('input, textarea, select, [contenteditable="true"]') && !target.closest('.cm-editor, .ProseMirror')) return null;
		return 'compile';
	}
	return null;
}
