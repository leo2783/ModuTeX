import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { assertSourceBoundary, telemetryPatterns } from './helpers/sourceBoundary';

const repoRoot = path.resolve(process.cwd(), '../..');

describe('production telemetry boundary', () => {
	it('has no telemetry API, package import, endpoint, or analytics initialization', async () => {
		const roots = [path.join(repoRoot, 'landing/src'), path.join(repoRoot, 'apps/texpile-editor/src')];
		const report = await assertSourceBoundary(roots, telemetryPatterns);
		expect(report.sourceFiles).toBeGreaterThan(0);
		expect(report.bytes).toBeGreaterThan(0);
	});

	it('does not expose an unverified public download action', () => {
		const page = readFileSync(path.join(repoRoot, 'landing/src/routes/download/+page.svelte'), 'utf8');
		const ast = parse(page, { modern: true });
		const collect = (root: unknown) => {
			const nodes: Record<string, unknown>[] = [];
			const pending: unknown[] = [root];
			const seen = new Set<object>();
			while (pending.length > 0) {
				const value = pending.pop();
				if (Array.isArray(value)) {
					pending.push(...value);
				} else if (value && typeof value === 'object' && !seen.has(value)) {
					seen.add(value);
					nodes.push(value as Record<string, unknown>);
					pending.push(...Object.values(value as Record<string, unknown>));
				}
			}
			return nodes;
		};
		const templateNodes = collect(ast.fragment);
		const scriptNodes = collect(ast.instance?.content);
		const hasDownloadAttribute = templateNodes.some(
			(node) =>
				node.type === 'RegularElement' &&
				Array.isArray(node.attributes) &&
				(node.attributes as Array<Record<string, unknown>>).some((attribute) => attribute.name === 'download')
		);
		const hasFetchCall = scriptNodes.some(
			(node) =>
				node.type === 'CallExpression' &&
				node.callee &&
				typeof node.callee === 'object' &&
				(node.callee as Record<string, unknown>).type === 'Identifier' &&
				(node.callee as Record<string, unknown>).name === 'fetch'
		);

		expect(hasDownloadAttribute).toBe(false);
		expect(hasFetchCall).toBe(false);
		expect(page).not.toMatch(/dl\.texpile\.com|updates\.texpile\.com|github\.com\/texpile\/texpile\/(?:releases|download)/i);
	});
});
