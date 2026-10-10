import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('../', import.meta.url)),
	test: { include: ['electron/tests/frontend-compile.integration.ts', 'electron/tests/frontend-cancel-drain.integration.ts',
		'electron/tests/frontend-compile-input-lifetime.integration.ts',
		'electron/tests/frontend-included-diagnostics.integration.ts'], environment: 'node', fileParallelism: false } });
