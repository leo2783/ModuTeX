import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	clampSplitterValue,
	splitterBounds,
	splitterKeyboardValue
} from '../../src/components/splitter/resize-logic.ts';

test('splitter bounds preserve both pane minimums at supported workbench sizes', () => {
	const cases = [
		{ width: 1920, min: 180, max: 1352 },
		{ width: 1280, min: 180, max: 712 },
		{ width: 960, min: 180, max: 392 },
		{ width: 800, min: 180, max: 232 },
		{ width: 500, min: 246, max: 246 }
	];
	for (const scenario of cases) {
		assert.deepEqual(splitterBounds(scenario.width, 180, 560, 8), {
			min: scenario.min,
			max: scenario.max
		}, `width ${scenario.width}px`);
	}
});

test('splitter bounds handle unusable geometry and clamp nonfinite positions', () => {
	assert.deepEqual(splitterBounds(0, 180, 560), { min: 0, max: 0 });
	assert.deepEqual(splitterBounds(Number.NaN, 180, 560), { min: 0, max: 0 });
	assert.equal(clampSplitterValue(-20, { min: 180, max: 432 }), 180);
	assert.equal(clampSplitterValue(500, { min: 180, max: 432 }), 432);
	assert.equal(clampSplitterValue(Number.NaN, { min: 180, max: 432 }), 180);
	assert.equal(clampSplitterValue(Number.POSITIVE_INFINITY, { min: 180, max: 432 }), 180);
});

test('splitter keyboard movement follows orientation and stays within pane bounds', () => {
	const bounds = { min: 180, max: 432 };
	const cases = [
		{ key: 'ArrowLeft', axis: 'vertical' as const, start: 220, expected: 204 },
		{ key: 'ArrowRight', axis: 'vertical' as const, start: 420, expected: 432 },
		{ key: 'ArrowUp', axis: 'horizontal' as const, start: 220, expected: 204 },
		{ key: 'ArrowDown', axis: 'horizontal' as const, start: 420, expected: 432 },
		{ key: 'Home', axis: 'vertical' as const, start: 300, expected: 180 },
		{ key: 'End', axis: 'horizontal' as const, start: 300, expected: 432 }
	];
	for (const scenario of cases) {
		assert.equal(
			splitterKeyboardValue(scenario.key, scenario.axis, scenario.start, bounds),
			scenario.expected,
			`${scenario.axis} ${scenario.key}`
		);
	}
	assert.equal(splitterKeyboardValue('ArrowDown', 'vertical', 220, bounds), null);
	assert.equal(splitterKeyboardValue('ArrowRight', 'horizontal', 220, bounds), null);
});
