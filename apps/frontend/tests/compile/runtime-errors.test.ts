import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileErrorDescriptor } from '../../src/features/compile/workbench-runtime.ts';

test('only native managed and system engine-unavailable display prefixes get the engine summary', () => {
	assert.equal(
		compileErrorDescriptor(new Error('Managed engine unavailable: executable missing'))[1],
		'Compiler unavailable. Check app files.'
	);
	assert.equal(
		compileErrorDescriptor(new Error('System engine unavailable: executable missing'))[1],
		'Compiler unavailable. Check app files.'
	);
	for (const detail of [
		'ENGINE_UNAVAILABLE',
		'Undefined control sequence',
		"LaTeX Error: File `example.sty' not found.",
		'Managed engine unavailable without the native delimiter'
	]) {
		assert.notEqual(
			compileErrorDescriptor(new Error(detail))[1],
			'Compiler unavailable. Check app files.',
			detail
		);
	}
});
