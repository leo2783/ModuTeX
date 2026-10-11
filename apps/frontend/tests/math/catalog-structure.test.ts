import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATH_CATALOG } from '../../src/features/math/catalog.ts';

test('graphical catalogue retains unique structures and all integral placements', () => {
	assert.equal(new Set(MATH_CATALOG.map(category => category.id)).size, MATH_CATALOG.length);
	for (const id of ['fractions', 'scripts', 'radicals', 'brackets', 'accents', 'matrix', 'greek', 'lim-sum-prod', 'multiline']) {
		assert.ok(MATH_CATALOG.some(category => category.id === id), id);
	}
	const calculus = MATH_CATALOG.find(category => category.id === 'calculus')!;
	for (const command of ['int', 'iint', 'iiint', 'oint', 'oiint', 'oiiint']) {
		const items = calculus.items.filter(item => item.id.startsWith(command + '-variant-'));
		assert.equal(items.length, 3, command);
		assert.equal(items[0]!.latex, '\\' + command + ' #@');
		assert.match(items[1]!.latex, /\\nolimits_\{#\?\}\^\{#\?\}/);
		assert.match(items[2]!.latex, /\\limits_\{#\?\}\^\{#\?\}/);
	}
	assert.ok(calculus.items.some(item => item.id === 'diff-dy'));
	assert.ok(calculus.items.some(item => item.id === 'diff-theta'));
	assert.ok(MATH_CATALOG.find(category => category.id === 'greek')!.items.some(item => item.id === 'Gamma'));
});
