import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: fileURLToPath(new URL('../', import.meta.url)),
	test: {
		include: ['electron/tests/**/*.test.ts'],
		environment: 'node'
	}
});
