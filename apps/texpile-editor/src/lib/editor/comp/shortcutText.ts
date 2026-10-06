// A shortcut as plain text, per OS: Ctrl+Shift+F on win/linux, ⇧⌘F on mac.
//
// One copy. This existed three times - the menu bar's trailing hints, the shortcut sheet and the
// palette's hint column - with two different argument orders between them, which is a drift waiting
// to happen when a modifier convention changes.
//
// Text, not markup. Kbd is the component for a rendered key cap; this is for the places that need
// the string itself, inside a span the caller has already styled.
import { isMac } from '$lib/platform';

export function combo(key: string, mods: { shift?: boolean; alt?: boolean } = {}): string {
	if (isMac) return `${mods.alt ? '⌥' : ''}${mods.shift ? '⇧' : ''}⌘${key}`;
	const parts = ['Ctrl'];
	if (mods.shift) parts.push('Shift');
	if (mods.alt) parts.push('Alt');
	parts.push(key);
	return parts.join('+');
}
