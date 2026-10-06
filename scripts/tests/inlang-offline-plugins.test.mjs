import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadProjectFromDirectory } from '@inlang/sdk';
import { compile } from '@inlang/paraglide-js';

const ROOT = resolve(import.meta.dirname, '../..');
const EDITOR = resolve(ROOT, 'apps/texpile-editor');
const LANDING = resolve(ROOT, 'landing');
const PLUGINS = new Map([
	['@inlang/plugin-message-format', '4.4.0'],
	['@inlang/plugin-m-function-matcher', '2.2.9']
]);

async function json(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

test('editor and lock pin the local Inlang plugins to the reviewed versions', async () => {
	const manifest = await json(resolve(EDITOR, 'package.json'));
	const lock = await json(resolve(ROOT, 'package-lock.json'));
	const settings = await json(resolve(EDITOR, 'project.inlang/settings.json'));
	assert.deepEqual(
		settings.modules,
		[...PLUGINS.keys()].map((name) => `../../node_modules/${name}/dist/index.js`)
	);
	const landing = await json(resolve(LANDING, 'project.inlang/settings.json'));
	assert.deepEqual(
		landing.modules,
		[...PLUGINS.keys()].map((name) => `../node_modules/${name}/dist/index.js`)
	);
	for (const [name, version] of PLUGINS) {
		assert.equal(manifest.devDependencies[name], version);
		assert.equal(lock.packages['apps/texpile-editor'].devDependencies[name], version);
		assert.equal(lock.packages[`node_modules/${name}`].version, version);
		assert.equal((await json(resolve(ROOT, 'node_modules', name, 'package.json'))).version, version);
	}
});

for (const { name, sourceRoot, parent, messageId } of [
	{ name: 'editor', sourceRoot: EDITOR, parent: resolve(ROOT, 'apps'), messageId: 'start_heading' },
	{ name: 'landing', sourceRoot: LANDING, parent: ROOT, messageId: 'meta_site_name' }
])
	test(`${name}: real SDK loads both plugins and Paraglide compiles all locales with HTTP fetch blocked`, async (t) => {
		// Preserve the workspace depth so the unchanged settings resolve the real npm packages.
		// Copy only source files: no plugin cache or generated Paraglide output can mask a failure.
		const fixture = await mkdtemp(resolve(parent, '.issue-66-inlang-'));
		assert.ok(fixture.startsWith(resolve(parent, '.issue-66-inlang-')));
		t.after(() => rm(fixture, { recursive: true, force: true }));
		await writeFile(resolve(fixture, 'package.json'), '{"type":"module"}\n');
		const projectPath = resolve(fixture, 'project.inlang');
		await fs.promises.mkdir(projectPath);
		await cp(resolve(sourceRoot, 'project.inlang/settings.json'), resolve(projectPath, 'settings.json'));
		await cp(resolve(sourceRoot, 'messages'), resolve(fixture, 'messages'), { recursive: true });

		const originalFetch = globalThis.fetch;
		const httpRequests = [];
		globalThis.fetch = async (input, ...args) => {
			const url = typeof input === 'string' ? input : (input.url ?? input.href);
			if (/^https?:/i.test(url)) {
				httpRequests.push(url);
				throw new Error(`HTTP fetch blocked by offline verification: ${url}`);
			}
			return originalFetch(input, ...args);
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const project = await loadProjectFromDirectory({ path: projectPath, fs });
		try {
			assert.deepEqual(await project.errors.get(), []);
			const plugins = await project.plugins.get();
			assert.deepEqual(plugins.map((plugin) => plugin.key).sort(), ['plugin.inlang.mFunctionMatcher', 'plugin.inlang.messageFormat']);
			const matcher = plugins.find((plugin) => plugin.key === 'plugin.inlang.mFunctionMatcher');
			const matches = await matcher.meta['app.inlang.ideExtension'].messageReferenceMatchers[0]({
				documentText: `import * as m from "./paraglide/messages.js"; m.${messageId}()`
			});
			assert.equal(matches[0]?.messageId, messageId);
			const settings = await project.settings.get();
			const messages = await project.db.selectFrom('message').selectAll().execute();
			for (const locale of settings.locales) {
				const source = await json(resolve(fixture, 'messages', `${locale}.json`));
				assert.deepEqual(
					messages
						.filter((message) => message.locale === locale)
						.map((message) => message.bundleId)
						.sort(),
					Object.keys(source)
						.filter((key) => key !== '$schema')
						.sort()
				);
			}
			t.diagnostic(`SDK loaded ${plugins.length} plugins and ${messages.length} messages across ${settings.locales.length} locales`);
		} finally {
			await project.close();
		}

		// Use the production compiler with its own real loader; keep its output in the disposable fixture.
		const outdir = resolve(fixture, 'compiled');
		await compile({ project: projectPath, outdir, emitTsDeclarations: true });
		const generated = await readFile(resolve(outdir, 'messages.js'), 'utf8');
		assert.ok(generated.length > 0);
		const generatedMessages = await import(pathToFileURL(resolve(outdir, 'messages.js')).href);
		const settings = await json(resolve(projectPath, 'settings.json'));
		for (const locale of settings.locales) {
			const source = await json(resolve(fixture, 'messages', `${locale}.json`));
			assert.equal(generatedMessages[messageId]({}, { locale }), source[messageId]);
		}
		assert.deepEqual(httpRequests, [], 'the SDK/compiler must never request an HTTP plugin or cache fallback');
	});
