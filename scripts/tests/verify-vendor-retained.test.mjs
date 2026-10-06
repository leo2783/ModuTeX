import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { verifyDrawioInstallation, verifyRetainedVendor } from '../verify-vendor.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await readFile(join(root, 'vendor/vendor-lock.json'), 'utf8'));
const entry = manifest.artifacts['drawio-offline'];

test('default production CLI verifies actual retained vendors without network access', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-vendor-network-'));
	try {
		const guard = join(directory, 'no-network.mjs');
		await writeFile(guard, "globalThis.fetch = () => { throw new Error('network forbidden'); };\n");
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, 'scripts/verify-vendor.mjs'], {
			cwd: root,
			encoding: 'utf8',
			timeout: 240000
		});
		assert.equal(result.status, 0, result.stderr);
		const reports = result.stdout
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			reports.map((report) => report.artifact),
			['drawio-offline', 'tectonic-windows-x64']
		);
		assert.ok(reports.every((report) => report.source === 'retained-installation'));
		assert.equal(reports[0].installation.files, 3378);
		assert.equal(reports[1].installation.executable.machine, 'AMD64');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('manifest rejection precedes missing retained installations', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-vendor-manifest-'));
	try {
		await mkdir(join(directory, 'vendor'));
		const changed = structuredClone(manifest);
		changed.artifacts['tectonic-windows-x64'].version = '0.16.0';
		await writeFile(join(directory, 'vendor/vendor-lock.json'), JSON.stringify(changed));
		await assert.rejects(verifyRetainedVendor(directory), /reviewed evidence mismatch for version/);
		const changedNotice = structuredClone(manifest);
		changedNotice.artifacts['drawio-offline'].notice = 'vendor/notices/OTHER.md';
		await writeFile(join(directory, 'vendor/vendor-lock.json'), JSON.stringify(changedNotice));
		await assert.rejects(verifyRetainedVendor(directory), /reviewed notice path mismatch/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('real retained Draw.io rejects VERSION, nested license, filename case, server, byte and inventory drift', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'modutex-drawio-retained-'));
	try {
		await cp(join(root, 'vendor/drawio'), join(directory, 'vendor/drawio'), { recursive: true });
		await cp(join(root, 'vendor/notices'), join(directory, 'vendor/notices'), { recursive: true });
		await cp(join(root, 'apps/texpile-editor/tests/fixtures/diagram'), join(directory, 'apps/texpile-editor/tests/fixtures/diagram'), {
			recursive: true
		});
		const tree = join(directory, 'vendor/drawio');
		for (const [name, relative, content, expected] of [
			['wrong VERSION', 'VERSION', '31.1.7\n', /VERSION mismatch/],
			['changed webapp bytes', 'src/main/webapp/js/app.min.js', 'corrupt', /byte count mismatch/],
			['server runtime', 'src/main/webapp/server/config.json', '{}', /forbidden server content/],
			['extra static file', 'src/main/webapp/extra.txt', 'unexpected', /inventory count mismatch/]
		]) {
			await t.test(name, async () => {
				const target = join(tree, relative);
				let original;
				try {
					original = await readFile(target);
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}
				if (name === 'server runtime') await mkdir(join(tree, 'src/main/webapp/server'));
				await writeFile(target, content);
				try {
					await assert.rejects(verifyDrawioInstallation(directory, entry), expected);
				} finally {
					if (original) await writeFile(target, original);
					else await rm(target);
				}
			});
		}
		await t.test('missing nested license', async () => {
			const target = join(tree, 'src/main/webapp/templates/LICENSE');
			const original = await readFile(target);
			await rm(target);
			try {
				await assert.rejects(verifyDrawioInstallation(directory, entry), /exact webapp\/templates\/LICENSE filename required/);
			} finally {
				await writeFile(target, original);
			}
		});
		await t.test('same-length webapp tamper fails raw-byte digest', async () => {
			const target = join(tree, 'src/main/webapp/js/app.min.js');
			const original = await readFile(target);
			const changed = Buffer.from(original);
			changed[1000] ^= 1;
			await writeFile(target, changed);
			try {
				await assert.rejects(verifyDrawioInstallation(directory, entry), /static webapp bytes do not match reviewed inventory/);
			} finally {
				await writeFile(target, original);
			}
		});
		await t.test('notice byte drift', async () => {
			const target = join(directory, 'vendor/notices/DRAWIO-NOTICE.md');
			const original = await readFile(target);
			await writeFile(target, 'corrupt notice');
			try {
				await assert.rejects(verifyDrawioInstallation(directory, entry), /DRAWIO-NOTICE.md SHA-256 mismatch/);
			} finally {
				await writeFile(target, original);
			}
		});
		await t.test('wrong filename case', async () => {
			const target = join(tree, 'src/main/webapp/templates/LICENSE');
			const changed = join(tree, 'src/main/webapp/templates/license');
			await rename(target, changed);
			try {
				await assert.rejects(verifyDrawioInstallation(directory, entry), /exact webapp\/templates\/LICENSE filename required/);
			} finally {
				await rename(changed, target);
			}
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('real retained Tectonic rejects missing executable, version, byte hash, notice and platform drift', async (t) => {
	const { verifyTectonicInstallation, verifyPeAmd64 } = await import('../vendor/tectonic-vendor.mjs');
	const directory = await mkdtemp(join(tmpdir(), 'modutex-tectonic-retained-'));
	try {
		await cp(join(root, 'vendor/tectonic'), join(directory, 'vendor/tectonic'), { recursive: true });
		await cp(join(root, 'vendor/notices'), join(directory, 'vendor/notices'), { recursive: true });
		const executablePath = join(directory, 'vendor/tectonic/windows-x64/tectonic.exe');
		const executable = await readFile(executablePath);
		await t.test('wrong platform', () => {
			const wrong = Buffer.from(executable);
			wrong.writeUInt16LE(0x014c, wrong.readUInt32LE(0x3c) + 4);
			assert.throws(() => verifyPeAmd64(wrong), /PE machine is not AMD64/);
		});
		for (const [name, relative, content, expected] of [
			['wrong version', 'tectonic/VERSION', Buffer.from('0.16.0\n'), /retained version mismatch/],
			['wrong executable hash', 'tectonic/windows-x64/tectonic.exe', Buffer.from(executable), /executable SHA-256 mismatch/],
			['wrong notice', 'notices/TECTONIC-NOTICE.md', Buffer.from('corrupt notice'), /notice SHA-256 mismatch/]
		]) {
			await t.test(name, async () => {
				const path = join(directory, 'vendor', relative);
				const original = await readFile(path);
				if (name === 'wrong executable hash') content[1000] ^= 1;
				await writeFile(path, content);
				try {
					await assert.rejects(verifyTectonicInstallation(directory), expected);
				} finally {
					await writeFile(path, original);
				}
			});
		}
		await t.test('missing executable', async () => {
			await rm(executablePath);
			try {
				await assert.rejects(verifyTectonicInstallation(directory), /retained inventory mismatch/);
			} finally {
				await writeFile(executablePath, executable);
			}
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
