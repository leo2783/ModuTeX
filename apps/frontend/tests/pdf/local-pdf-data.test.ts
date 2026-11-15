// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const frontendRoot = fileURLToPath(new URL('../..', import.meta.url));
const vite = await createServer({
	configFile: false,
	root: frontendRoot,
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'silent'
});
const { LocalPdfDataReader } = (await vite.ssrLoadModule(
	'/src/features/pdf/local-pdf-data.ts'
)) as typeof import('../../src/features/pdf/local-pdf-data.ts');
const { resources } = (await vite.ssrLoadModule(
	'/src/features/pdf/resources.generated.ts'
)) as typeof import('../../src/features/pdf/resources.generated.ts');

after(async () => {
	await vite.close();
});

test('LocalPdfDataReader rejects unknown kinds and filenames and loads registered resources via fetch', async () => {
	const reader = new LocalPdfDataReader();

	await assert.rejects(
		() => reader.fetch({ kind: 'unknown_kind', filename: 'none.bcmap' }),
		/Unknown PDF resource: unknown_kind\/none\.bcmap/
	);

	const firstKind = Object.keys(resources)[0]!;
	const firstFilename = resources[firstKind]!.keys().next().value!;

	await assert.rejects(
		() => reader.fetch({ kind: firstKind, filename: 'missing-file.bin' }),
		/Unknown PDF resource:/
	);

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => ({
			ok: false,
			async arrayBuffer() {
				return new ArrayBuffer(0);
			}
		})) as unknown as typeof fetch;

		await assert.rejects(
			() => reader.fetch({ kind: firstKind, filename: firstFilename }),
			/Unable to load PDF resource:/
		);

		const sample = new Uint8Array([1, 2, 3, 4, 5]);
		globalThis.fetch = (async () => ({
			ok: true,
			async arrayBuffer() {
				return sample.buffer.slice(0);
			}
		})) as unknown as typeof fetch;

		const loaded = await reader.fetch({ kind: firstKind, filename: firstFilename });
		assert.deepEqual([...loaded], [1, 2, 3, 4, 5]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
