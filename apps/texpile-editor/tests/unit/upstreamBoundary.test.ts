import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSourceBoundary, collaborationPatterns } from './helpers/sourceBoundary';

const repoRoot = path.resolve(process.cwd(), '../..');

function source(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('0.1.0 production upstream boundary', () => {
	it('has no updater startup, IPC, renderer bridge, or modal entrypoint', () => {
		const electronMain = source('electron/src/main.ts');
		const preload = source('electron/src/preload.ts');
		const app = source('apps/texpile-editor/src/App.svelte');
		const chrome = source('electron/src/window-chrome.ts');
		const combined = [electronMain, preload, app, chrome].join('\n');

		expect(combined).not.toMatch(
			/(?:autoUpdater|checkForUpdate|claimStartupTasks|update:(?:check|download|install|progress|downloaded|error)|UpdateAvailableModal|\$lib\/updates|menubar_check_for_updates)/
		);
		expect(source('electron-builder.yml')).not.toMatch(/(?:^|\n)publish:|latest[^\n]*\.yml|target:\s*zip/);
	});

	it('has no collaboration endpoint, route, or production import', async () => {
		const roots = [path.join(repoRoot, 'electron/src'), path.join(repoRoot, 'apps/texpile-editor/src')];
		const report = await assertSourceBoundary(roots, collaborationPatterns);
		expect(report.sourceFiles).toBeGreaterThan(0);
		expect(report.bytes).toBeGreaterThan(0);
	});

	it('keeps unknown hashes outside the route table and renders the 404 fallback', () => {
		const router = source('apps/texpile-editor/src/lib/router.svelte.ts');
		const app = source('apps/texpile-editor/src/App.svelte');

		expect(router).toContain("export const ROUTES = ['/', '/workspace'] as const");
		expect(app).toMatch(/\{:else\}\s*<ErrorView status=\{404\} \/>/);
	});

	it('allows renderer connections only to bundled/local resources', () => {
		const electronMain = source('electron/src/main.ts');
		const connectSrc = electronMain.match(/"connect-src ([^"]+)"/)?.[1] ?? '';

		expect(connectSrc).toBe("'self' texfile: blob: data:");
		expect(connectSrc).not.toMatch(/(?:https:|wss:|ws:|http:)/);
	});
});
