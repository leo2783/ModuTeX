import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSourceBoundary, collaborationPatterns, productionFiles, telemetryPatterns } from './sourceBoundary';

const fixtures: string[] = [];
async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'modutex-source-boundary-'));
	fixtures.push(root);
	return root;
}
async function source(root: string, relative: string, content: string): Promise<void> {
	const file = path.join(root, relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, content);
}
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('complete production source boundary', () => {
	it.each([
		'@plausible-analytics/tracker',
		'plausible.io',
		'/api/event',
		'initAnalytics',
		'trackEvent',
		'trackFeatureUsed',
		'setReferralSource',
		'outboundLinks',
		'fileDownloads'
	])('rejects nested telemetry mutation %s', async (forbidden) => {
		const root = await fixture();
		await source(root, 'nested/production/main.ts', forbidden);
		await expect(assertSourceBoundary([root], telemetryPatterns)).rejects.toThrow('Forbidden production source');
	});
	it.each([
		'collab.texpile.com',
		'$lib/collab',
		'./views/SessionRoute.svelte',
		"'/session'",
		'openShareSession',
		'file.shareSession',
		'menubar_share_session'
	])('rejects nested production mutation %s', async (forbidden) => {
		const root = await fixture();
		await source(root, 'views/nested/route.svelte', forbidden);
		await expect(assertSourceBoundary([root], collaborationPatterns)).rejects.toThrow('Forbidden production source');
	});
	it('covers both extensions and same-name non-generated directories', async () => {
		const root = await fixture();
		await source(root, 'nested/main.ts', 'export const local = true;');
		await source(root, 'paraglide/route.svelte', 'collab.texpile.com');
		await source(root, 'nested/lib/paraglide/import.ts', '$lib/collab');
		expect((await productionFiles(root)).map((file) => path.relative(root, file)).sort()).toEqual(
			['nested/main.ts', 'paraglide/route.svelte', 'nested/lib/paraglide/import.ts'].map((file) => path.normalize(file)).sort()
		);
		await expect(assertSourceBoundary([root], collaborationPatterns)).rejects.toThrow('Forbidden production source');
	});
	it('prunes only the exact generated subtree before descending', async () => {
		const root = await fixture();
		const outside = await fixture();
		await source(root, 'main.ts', 'export const local = true;');
		await source(root, 'lib/paraglide/generated.ts', 'collab.texpile.com');
		await symlink(outside, path.join(root, 'lib/paraglide/not-traversed'), process.platform === 'win32' ? 'junction' : 'dir');
		expect(await assertSourceBoundary([root], collaborationPatterns)).toEqual({ sourceFiles: 1, bytes: 26 });
	});
	it('fails closed for a source symlink or Windows junction', async () => {
		const root = await fixture();
		const outside = await fixture();
		await source(outside, 'hidden.ts', 'collab.texpile.com');
		await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		await expect(productionFiles(root)).rejects.toThrow('Linked source entry');
		await expect(productionFiles(path.join(root, 'linked'))).rejects.toThrow('Invalid source root');
	});
	it('rejects a junction replacing the generated directory itself', async () => {
		const root = await fixture();
		const outside = await fixture();
		await mkdir(path.join(root, 'lib'));
		await symlink(outside, path.join(root, 'lib/paraglide'), process.platform === 'win32' ? 'junction' : 'dir');
		await expect(productionFiles(root)).rejects.toThrow('Linked source entry');
	});
});
