import assert from 'node:assert/strict';
import test from 'node:test';

import Ajv from 'ajv';

const SCHEMA_ID = 'https://schemas.modutex.invalid/base.json';
const MALFORMED_REFERENCES = [
	'http:\\\\evil.example/path',
	'https:/\\evil.example/path',
	'/\\\\evil.example/path'
];

test('Ajv URI-reference resolution rejects malformed authorities and backslash-based host confusion', () => {
	for (const reference of MALFORMED_REFERENCES) {
		const ajv = new Ajv();
		ajv.addSchema({ $id: SCHEMA_ID, type: 'string' });
		assert.throws(
			() => ajv.compile({ $id: 'https://schemas.modutex.invalid/root.json', $ref: reference }),
			/URI authority (?:must not contain a literal backslash|introducer must not contain whitespace)/,
			reference
		);
	}
});

test('Ajv URI-reference resolution continues to resolve a valid schema URI', () => {
	const ajv = new Ajv();
	ajv.addSchema({ $id: SCHEMA_ID, type: 'string' });

	const validate = ajv.compile({ $ref: SCHEMA_ID });
	assert.equal(validate('valid'), true);
	assert.equal(validate(42), false);
});
