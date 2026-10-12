import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { inputOnlyMathLive } from '../../scripts/mathlive-input-only.mjs';

test('input-only build excludes keyboard implementations and fails closed on upstream changes', async () => {
	const upstream = await readFile(new URL('../../../../node_modules/mathlive/mathlive.mjs', import.meta.url), 'utf8');
	const input = inputOnlyMathLive(upstream);
	assert.doesNotMatch(input, /^\/\/ src\/virtual-keyboard\//m);
	assert.doesNotMatch(input, /var VirtualKeyboard(?:Proxy)? = class/);
	assert.doesNotMatch(input, /Object\.defineProperty\(window, "mathVirtualKeyboard"/);
	assert.doesNotMatch(input, /<[^>]+part=["']virtual-keyboard-toggle/);
	assert.match(input, /\/\/ src\/editor-mathfield\/keyboard-input\.ts/);
	assert.match(input, /\/\/ src\/public\/mathfield-element\.ts/);
	assert.throws(() => inputOnlyMathLive(upstream + '\n'), /audited/);
});
