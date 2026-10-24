import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);

test('Vite denies Wasm requests to denied files while serving allowed modules', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'modutex-vite-security-'));
	const root = join(temporary, 'public');
	let server;
	try {
		await mkdir(root);
		await writeFile(join(root, '.env'), 'SECR=test-fixture-only');
		await writeFile(join(temporary, 'outside.txt'), 'SECR=test-fixture-only');
		await writeFile(join(root, 'entry.js'), 'export const allowed = true;');
		server = await createServer({
			root,
			configFile: false,
			logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [root] } }
		});
		await server.listen();
		const address = server.httpServer.address();
		assert.ok(address && typeof address === 'object');
		const origin = `http://127.0.0.1:${address.port}`;
		for (const path of ['/.env?vite-wasm-instance', `/@fs/${join(temporary, 'outside.txt').replaceAll('\\', '/')}?vite-wasm-instance`]) {
			const response = await fetch(origin + path);
			const body = await response.text();
			assert.equal(response.status, 403, path);
			assert.doesNotMatch(body, /SECR|53 45 43 52/);
		}
		const control = await fetch(origin + '/entry.js');
		assert.equal(control.status, 200);
		assert.match(await control.text(), /allowed = true/);
	} finally {
		await server?.close();
		assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
		await rm(temporary, { recursive: true, force: true });
	}
});

test('SvelteKit cookie dependency rejects header injection and preserves valid cookies', () => {
	const kitRequire = createRequire(require.resolve('@sveltejs/kit/package.json'));
	const cookie = kitRequire('cookie');
	assert.equal(cookie.serialize('session', 'a b', { path: '/', httpOnly: true }), 'session=a%20b; Path=/; HttpOnly');
	assert.throws(() => cookie.serialize('session; injected', 'value'), TypeError);
	assert.throws(() => cookie.serialize('session', 'value', { path: '/; injected' }), TypeError);
	assert.throws(() => cookie.serialize('session', 'value', { domain: 'example.com; injected' }), TypeError);
});

test('Typography selector dependency preserves nested and repeated selectors', () => {
	const typographyRequire = createRequire(require.resolve('@tailwindcss/typography'));
	const parser = typographyRequire('postcss-selector-parser');
	for (const selector of [':where(.prose > :not(.not-prose)) a:hover', '.a'.repeat(10_000)]) {
		assert.equal(parser().processSync(selector), selector);
	}
});
