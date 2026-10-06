import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { load } from 'js-yaml';
import { verifyPackagedVendorResources } from '../verify-packaged-vendor.mjs';
import { verifyDrawioInstallation } from '../verify-vendor.mjs';
import { verifyPackagedTectonicResources } from '../vendor/tectonic-vendor.mjs';

const root = resolve(import.meta.dirname, '../..');
const afterPack = createRequire(import.meta.url)('../after-pack.cjs').default;
const notices = ['DRAWIO-LICENSE.txt', 'DRAWIO-NOTICE.md', 'TECTONIC-LICENSE.txt', 'TECTONIC-NOTICE.md'];
const entry = { version: '31.1.8' };

async function copyRuntime(resources) {
	for (const name of ['drawio', 'tectonic']) {
		await cp(join(root, 'vendor', name), join(resources, 'vendor', name), { recursive: true });
	}
	await mkdir(join(resources, 'vendor/notices'));
	for (const name of notices) await cp(join(root, 'vendor/notices', name), join(resources, 'vendor/notices', name));
}

test('packaging config includes only exact reviewed runtime resources and the real verification hook', async () => {
	const config = load(await readFile(join(root, 'electron-builder.yml'), 'utf8'));
	assert.equal(config.afterPack, 'scripts/after-pack.cjs');
	const vendor = config.extraResources.filter(({ from }) => from === 'vendor');
	assert.equal(vendor.length, 1);
	assert.equal(vendor[0].to, 'vendor');
	assert.deepEqual(vendor[0].filter, [
		'tectonic/VERSION',
		'tectonic/windows-x64/tectonic.exe',
		'notices/TECTONIC-LICENSE.txt',
		'notices/TECTONIC-NOTICE.md',
		'drawio/VERSION',
		'drawio/LICENSE',
		'drawio/src/main/webapp/**/*',
		'notices/DRAWIO-LICENSE.txt',
		'notices/DRAWIO-NOTICE.md'
	]);
	assert.equal(config.extraResources.filter(({ from }) => /vendor|fixtures|archive|\.jar$/i.test(from)).length, 1);
	assert.deepEqual(config.win.target, ['nsis']);
});

test('real temporary packaged bytes are verified without fixtures, while source still requires every fixture', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-packaged-vendor-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const resources = join(directory, 'resources');
	await copyRuntime(resources);
	const report = await verifyPackagedVendorResources(resources);
	assert.equal(report.drawio.files, 3378);
	assert.equal(report.tectonic.executable.machine, 'AMD64');
	assert.equal(Object.hasOwn(report.drawio, 'fixtures'), false);
	await assert.rejects(verifyDrawioInstallation(resources, entry), /diagram fixture inventory is missing/);
	const fixtureRoot = join(resources, 'apps/texpile-editor/tests/fixtures/diagram');
	await cp(join(root, 'apps/texpile-editor/tests/fixtures/diagram'), fixtureRoot, { recursive: true });
	assert.equal((await verifyDrawioInstallation(resources, entry)).fixtures.files, 4);
	await rm(join(fixtureRoot, 'offline.drawio'));
	await assert.rejects(verifyDrawioInstallation(resources, entry), /fixture inventory does not match/);
	await cp(join(root, 'apps/texpile-editor/tests/fixtures/diagram/offline.drawio'), join(fixtureRoot, 'offline.drawio'));
	await writeFile(join(fixtureRoot, 'offline.drawio'), '<mxfile>https://unexpected.example/</mxfile>');
	await assert.rejects(verifyDrawioInstallation(resources, entry), /offline fixture contains an external URL/);

	await t.test('default Tectonic profile still rejects additional notices and unknown profiles', async () => {
		await assert.rejects(verifyPackagedTectonicResources(resources), /notice inventory mismatch/);
		await assert.rejects(verifyPackagedTectonicResources(resources, ['arbitrary.txt']), /unknown packaged notice profile/);
	});
	for (const [name, relative, expected] of [
		['Draw.io app missing', 'drawio/src/main/webapp/js/app.min.js', /exact webapp\/js\/app.min.js filename required/],
		['Tectonic executable missing', 'tectonic/windows-x64/tectonic.exe', /retained inventory mismatch/],
		...notices.map((name) => [`notice missing ${name}`, `notices/${name}`, /missing regular|missing or unreadable/])
	]) {
		await t.test(name, async () => {
			const target = join(resources, 'vendor', relative);
			const original = await readFile(target);
			await rm(target);
			try {
				await assert.rejects(verifyPackagedVendorResources(resources), expected);
			} finally {
				await writeFile(target, original);
			}
		});
	}
	for (const [name, relative, expected] of [
		['Draw.io hash tamper', 'drawio/src/main/webapp/js/app.min.js', /static webapp bytes do not match/],
		['Tectonic hash tamper', 'tectonic/windows-x64/tectonic.exe', /executable SHA-256 mismatch/],
		...notices.map((name) => [`notice tamper ${name}`, `notices/${name}`, /SHA-256 mismatch/])
	]) {
		await t.test(name, async () => {
			const target = join(resources, 'vendor', relative);
			const original = await readFile(target);
			const changed = Buffer.from(original);
			changed[Math.min(1000, changed.length - 1)] ^= 1;
			await writeFile(target, changed);
			try {
				await assert.rejects(verifyPackagedVendorResources(resources), expected);
			} finally {
				await writeFile(target, original);
			}
		});
	}
	for (const [relative, expected] of [
		['notices/EXTRA.md', /notice inventory mismatch/],
		['drawio/src/main/webapp/server/payload.jar', /forbidden/],
		['archive.zip', /exact runtime directory inventory/]
	]) {
		await t.test(`unreviewed packaged resource ${relative}`, async () => {
			const target = join(resources, 'vendor', relative);
			if (relative.includes('/server/')) await mkdir(join(resources, 'vendor/drawio/src/main/webapp/server'));
			await writeFile(target, 'unexpected');
			try {
				await assert.rejects(verifyPackagedVendorResources(resources), expected);
			} finally {
				await rm(target);
			}
		});
	}

	await t.test('actual Windows x64 afterPack verifies resources and preserves node-pty pruning/helper', async () => {
		const prebuilds = join(resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds');
		await mkdir(join(prebuilds, 'win32-x64'), { recursive: true });
		await mkdir(join(prebuilds, 'linux-x64'));
		const helper = join(prebuilds, 'win32-x64/spawn-helper');
		await writeFile(helper, 'retained helper');
		const context = { appOutDir: directory, electronPlatformName: 'win32', arch: 1 };
		await afterPack(context);
		assert.equal(await readFile(helper, 'utf8'), 'retained helper');
		await assert.rejects(stat(join(prebuilds, 'linux-x64')), { code: 'ENOENT' });
		await mkdir(join(prebuilds, 'linux-x64'));
		await rm(join(resources, 'vendor/notices/DRAWIO-LICENSE.txt'));
		await assert.rejects(afterPack(context), /missing regular/);
		assert.ok((await stat(join(prebuilds, 'linux-x64'))).isDirectory(), 'verification failure precedes pruning');
	});
});

test('packaged verifier rejects missing resources and linked vendor boundaries; hook rejects unsupported targets', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-packaged-boundary-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(verifyPackagedVendorResources(join(directory, 'missing')), { code: 'ENOENT' });
	await assert.rejects(verifyPackagedVendorResources(directory), { code: 'ENOENT' });
	const outside = join(directory, 'outside');
	const resources = join(directory, 'resources');
	await mkdir(outside);
	await mkdir(resources);
	await symlink(outside, join(resources, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(verifyPackagedVendorResources(resources), /root must be a regular directory/);
	for (const [platform, arch] of [
		['linux', 1],
		['darwin', 1],
		['win32', 3],
		['win32', 0]
	]) {
		await assert.rejects(afterPack({ appOutDir: directory, electronPlatformName: platform, arch }), /requires Windows x64/);
	}
});
