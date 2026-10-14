import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { documentCommand } from '../../src/features/shortcuts/keyboard.ts';
import { readPreferences, savePreference, DEFAULT_PREFERENCES } from '../../src/state/preferences.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('real keyboard events match only exact modifiers and reject repeat, composition and prevented commands', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const key = (value: KeyboardEventInit) => new dom.window.KeyboardEvent('keydown', { cancelable: true, ctrlKey: true, ...value });
		assert.equal(documentCommand(key({ key: 'O' }), 'mod-enter'), 'open');
		assert.equal(documentCommand(key({ key: 's', ctrlKey: false, metaKey: true }), 'none'), 'save');
		assert.equal(documentCommand(key({ key: 'Enter' }), 'mod-enter'), 'compile');
		assert.equal(documentCommand(key({ key: 'B', shiftKey: true }), 'mod-shift-b'), 'compile');
		for (const event of [key({ key: 'o', repeat: true }), key({ key: 'o', isComposing: true }), key({ key: 'o', altKey: true }),
			key({ key: 'o', shiftKey: true }), key({ key: 'o', metaKey: true }), key({ key: 'o', ctrlKey: false }), key({ key: 's', keyCode: 229 })]) {
			assert.equal(documentCommand(event, 'mod-enter'), null);
		}
		const prevented = key({ key: 'o' }); prevented.preventDefault(); assert.equal(documentCommand(prevented, 'mod-enter'), null);
		assert.equal(documentCommand(key({ key: 'Enter' }), 'none'), null);
		assert.equal(documentCommand(key({ key: 'Enter' }), 'mod-shift-b'), null);
		assert.equal(documentCommand(key({ key: 'b' }), 'mod-shift-b'), null);
	} finally { dom.window.close(); }
});

test('compile keys do not steal form input, but actual editor DOM remains eligible', () => {
	const dom = new JSDOM('<input><textarea></textarea><select></select><div contenteditable="true"></div><div class="cm-editor"><div contenteditable="true"></div></div><div class="ProseMirror" contenteditable="true"></div>');
	try {
		const seen: (string | null)[] = [];
		dom.window.addEventListener('keydown', (event: KeyboardEvent) => seen.push(documentCommand(event, 'mod-enter')));
		for (const element of dom.window.document.querySelectorAll('input,textarea,select,[contenteditable]')) {
			element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
		}
		assert.deepEqual(seen, [null, null, null, null, 'compile', 'compile']);
	} finally { dom.window.close(); }
});

test('shortcut preferences persist independently and invalid bindings cannot execute', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		savePreference(dom.window.localStorage, 'compileShortcut', 'mod-shift-b');
		savePreference(dom.window.localStorage, 'appearance', 'dark');
		assert.equal(readPreferences(dom.window.localStorage).preferences.compileShortcut, 'mod-shift-b');
		assert.throws(() => savePreference(dom.window.localStorage, 'compileShortcut', 'arbitrary-shell' as never), /INVALID_PREFERENCE/);
		dom.window.localStorage.setItem('modutex.frontend.preferences.v1.compileShortcut', '"invalid"');
		const current = readPreferences(dom.window.localStorage);
		assert.equal(current.invalid, true);
		assert.equal(current.preferences.compileShortcut, DEFAULT_PREFERENCES.compileShortcut);
		assert.equal(current.preferences.appearance, 'dark');
	} finally { dom.window.close(); }
});
