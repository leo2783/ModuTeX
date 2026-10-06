import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify, uneval } from 'devalue';

function ownedBufferView() {
	// Every byte is initialized and owned by this test, never a shared Buffer pool.
	const owned = Uint8Array.from([201, 202, 17, 23, 203, 204, 205, 206]);
	return Buffer.from(owned.buffer, 2, 2);
}

test('installed devalue stringify/parse excludes bytes outside an owned Buffer view', () => {
	const view = ownedBufferView();
	const restored = parse(stringify(view));
	assert.ok(restored instanceof Uint8Array);
	assert.deepEqual([...restored], [...view]);
	assert.equal(restored.byteOffset, 0);
	assert.equal(restored.buffer.byteLength, view.byteLength);
	assert.deepEqual([...new Uint8Array(restored.buffer)], [...view]);
});

test('installed devalue uneval emits only owned Buffer view bytes without executing code', () => {
	const source = uneval(ownedBufferView());
	// Match the public serializer output, but do not eval/execute generated code.
	assert.ok(source === 'new Uint8Array([17,23])', 'generated code must contain only the view bytes');
});

test('installed devalue preserves a complete ordinary typed-array value', () => {
	const input = Uint8Array.from([17, 23]);
	const restored = parse(stringify(input));
	assert.deepEqual([...restored], [...input]);
	assert.equal(restored.buffer.byteLength, input.byteLength);
	assert.equal(uneval(input), 'new Uint8Array([17,23])');
});
