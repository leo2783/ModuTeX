import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { verifyInstallPolicy } from '../verify-install-policy.mjs';

const NPMRC = `registry=https://registry.npmjs.org/
save-exact=true
strict-peer-deps=true
engine-strict=true
allow-directory=root
allow-file=root
allow-git=none
allow-remote=none
strict-allow-scripts=true
audit=true
audit-level=high
package-lock=true
fund=false
`;

const json = (value) => `${JSON.stringify(value, null, '\t')}\n`;

function rootPackage() {
	return {
		name: 'policy-fixture',
		version: '1.0.0',
		private: true,
		packageManager: 'npm@11.17.0',
		engines: { node: '24.19.0', npm: '11.17.0' },
		workspaces: ['packages/*'],
		dependencies: { 'fixture-workspace': '1.0.0' },
		devDependencies: { esbuild: '0.28.1' },
		allowScripts: { 'esbuild@0.28.1': true }
	};
}

function workspacePackage(name = 'fixture-workspace') {
	return { name, version: '1.0.0', private: true };
}

function packageLock() {
	return {
		name: 'policy-fixture',
		version: '1.0.0',
		lockfileVersion: 3,
		requires: true,
		packages: {
			'': {
				name: 'policy-fixture',
				version: '1.0.0',
				dependencies: { 'fixture-workspace': '1.0.0' },
				devDependencies: { esbuild: '0.28.1' },
				workspaces: ['packages/*']
			},
			'node_modules/esbuild': {
				version: '0.28.1',
				resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz',
				integrity: 'sha512-Zml4dHVyZQ==',
				hasInstallScript: true
			},
			'node_modules/fixture-workspace': {
				resolved: 'packages/workspace',
				link: true
			},
			'packages/workspace': {
				name: 'fixture-workspace',
				version: '1.0.0'
			}
		}
	};
}

async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, json(value), 'utf8');
}

async function makeFixture() {
	const root = await mkdtemp(join(tmpdir(), 'modutex-install-policy-'));
	await mkdir(join(root, 'packages', 'workspace'), { recursive: true });
	await writeFile(join(root, '.npmrc'), NPMRC, 'utf8');
	await writeFile(join(root, 'package.json'), json(rootPackage()), 'utf8');
	await writeFile(join(root, 'package-lock.json'), json(packageLock()), 'utf8');
	await writeFile(join(root, 'packages', 'workspace', 'package.json'), json(workspacePackage()), 'utf8');
	return root;
}

async function withFixture(run) {
	const root = await makeFixture();
	try {
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function verify(root, options = {}) {
	return verifyInstallPolicy({ root, checkRuntime: false, ...options });
}

function assertFails(result, pattern) {
	assert.equal(result.ok, false);
	assert.match(result.errors.join('\n'), pattern);
}

test('accepts the pinned registry, workspace, lockfile and reviewed install script', async () => {
	await withFixture(async (root) => {
		const result = await verify(root);
		assert.deepEqual(result.errors, []);
		assert.equal(result.ok, true);
		assert.deepEqual(result.lockfiles, ['package-lock.json']);
	});
});

test('uses the declaring workspace as the base for a local dependency', async () => {
	await withFixture(async (root) => {
		await mkdir(join(root, 'packages', 'second'), { recursive: true });
		await writeFile(join(root, 'packages', 'second', 'package.json'), json(workspacePackage('second-workspace')), 'utf8');
		const workspace = workspacePackage();
		workspace.dependencies = { 'second-workspace': 'file:../second' };
		await writeFile(join(root, 'packages', 'workspace', 'package.json'), json(workspace), 'utf8');
		const lock = packageLock();
		lock.packages['packages/workspace'].dependencies = { 'second-workspace': 'file:../second' };
		lock.packages['packages/second'] = { name: 'second-workspace', version: '1.0.0' };
		await writeFile(join(root, 'package-lock.json'), json(lock), 'utf8');
		const result = await verify(root);
		assert.equal(result.ok, true, result.errors.join('\n'));
	});
});

test('requires the pinned Node and npm runtime', async () => {
	await withFixture(async (root) => {
		const npmRoot = join(root, 'runtime', 'node_modules', 'npm');
		await mkdir(join(npmRoot, 'bin'), { recursive: true });
		await writeFile(join(npmRoot, 'package.json'), json({ version: '11.17.0' }), 'utf8');
		await writeFile(join(npmRoot, 'bin', 'npm-cli.js'), '', 'utf8');
		const valid = await verify(root, {
			checkRuntime: true,
			nodeVersion: 'v24.19.0',
			env: { npm_execpath: join(npmRoot, 'bin', 'npm-cli.js') }
		});
		assert.equal(valid.ok, true, valid.errors.join('\n'));

		const invalid = await verify(root, {
			checkRuntime: true,
			nodeVersion: 'v24.18.0',
			env: { npm_execpath: join(npmRoot, 'bin', 'npm-cli.js') }
		});
		assertFails(invalid, /Node\.js v24\.19\.0 required/);
	});
});

test('rejects any second lockfile anywhere in the repository', async () => {
	await withFixture(async (root) => {
		await writeJson(join(root, 'packages', 'workspace', 'npm-shrinkwrap.json'), {});
		assertFails(await verify(root), /exactly root package-lock\.json must exist/);
	});
});

test('rejects stale pnpm instructions in executable documentation', async () => {
	await withFixture(async (root) => {
		await mkdir(join(root, '.github', 'workflows'), { recursive: true });
		await mkdir(join(root, 'scripts'), { recursive: true });
		await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'run: pnpm install\n', 'utf8');
		await writeFile(join(root, 'scripts', 'setup.sh'), 'pnpm run build\n', 'utf8');
		const result = await verify(root);
		assertFails(result, /.github\/workflows\/ci\.yml: stale pnpm reference is forbidden/);
		assert.match(result.errors.join('\n'), /scripts\/setup\.sh: stale pnpm reference is forbidden/);
	});
});

test('rejects scoped registries and committed credentials', async (t) => {
	await t.test('scoped registry', async () => {
		await withFixture(async (root) => {
			await writeFile(join(root, '.npmrc'), `${NPMRC}@private:registry=https://registry.example/\n`, 'utf8');
			assertFails(await verify(root), /forbidden key @private:registry/);
		});
	});

	await t.test('auth token', async () => {
		await withFixture(async (root) => {
			await writeFile(join(root, '.npmrc'), `${NPMRC}//registry.npmjs.org/:_authToken=secret\n`, 'utf8');
			assertFails(await verify(root), /forbidden key .*_authToken/);
		});
	});

	await t.test('proxy password', async () => {
		await withFixture(async (root) => {
			await writeFile(join(root, '.npmrc'), `${NPMRC}proxy=https://user:secret@proxy.example/\n`, 'utf8');
			assertFails(await verify(root), /credential-bearing proxy is forbidden/);
		});
	});
});

test('rejects a root install lifecycle script', async () => {
	await withFixture(async (root) => {
		const manifest = rootPackage();
		manifest.scripts = { postinstall: 'node scripts/postinstall.mjs' };
		await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
		assertFails(await verify(root), /install lifecycle script postinstall is forbidden/);
	});
});

test('rejects install lifecycle scripts in first-party workspaces', async () => {
	await withFixture(async (root) => {
		const manifest = workspacePackage();
		manifest.scripts = { install: 'node setup.mjs' };
		await writeFile(join(root, 'packages', 'workspace', 'package.json'), json(manifest), 'utf8');
		assertFails(await verify(root), /packages\/workspace\/package\.json: install lifecycle script install is forbidden/);
	});
});

test('rejects unpinned, remote and workspace-protocol direct dependencies', async (t) => {
	const cases = [
		['range', '^1.2.3', /not pinned exactly/],
		['Git URL', 'git+https://github.com/example/pkg.git', /remote\/Git dependency is forbidden/],
		['tarball URL', 'https://example.test/pkg.tgz', /remote\/Git dependency is forbidden/],
		['workspace protocol', 'workspace:*', /workspace protocol is not valid/]
	];
	for (const [name, spec, pattern] of cases) {
		await t.test(name, async () => {
			await withFixture(async (root) => {
				const manifest = rootPackage();
				manifest.dependencies.unsafe = spec;
				await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
				assertFails(await verify(root), pattern);
			});
		});
	}
});

test('rejects local dependencies outside the repository or outside declared workspaces', async (t) => {
	await t.test('repository escape', async () => {
		await withFixture(async (root) => {
			const manifest = rootPackage();
			manifest.dependencies.unsafe = 'file:../../outside';
			await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
			assertFails(await verify(root), /local dependency escapes repository/);
		});
	});

	await t.test('undeclared in-repository directory', async () => {
		await withFixture(async (root) => {
			await mkdir(join(root, 'fixtures', 'local'), { recursive: true });
			const manifest = rootPackage();
			manifest.dependencies.unsafe = 'file:fixtures/local';
			await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
			assertFails(await verify(root), /must target a declared workspace/);
		});
	});

	await t.test('workspace junction escape', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'modutex-install-policy-outside-'));
		try {
			await writeFile(join(outside, 'package.json'), json(workspacePackage('escaped-workspace')), 'utf8');
			await withFixture(async (root) => {
				await symlink(outside, join(root, 'packages', 'escape'), 'junction');
				const manifest = rootPackage();
				manifest.workspaces = ['packages/workspace', 'packages/escape'];
				await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
				const lock = packageLock();
				lock.packages[''].workspaces = manifest.workspaces;
				lock.packages['packages/escape'] = { name: 'escaped-workspace', version: '1.0.0' };
				await writeFile(join(root, 'package-lock.json'), json(lock), 'utf8');
				assertFails(await verify(root), /packages\/escape\/package\.json: workspace resolves outside repository/);
			});
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test('rejects foreign registry URLs and missing integrity in the lockfile', async (t) => {
	await t.test('foreign URL', async () => {
		await withFixture(async (root) => {
			const lock = packageLock();
			lock.packages['node_modules/esbuild'].resolved = 'https://packages.example/esbuild.tgz';
			await writeFile(join(root, 'package-lock.json'), json(lock), 'utf8');
			assertFails(await verify(root), /registry package must use https:\/\/registry\.npmjs\.org\//);
		});
	});

	await t.test('missing integrity', async () => {
		await withFixture(async (root) => {
			const lock = packageLock();
			delete lock.packages['node_modules/esbuild'].integrity;
			await writeFile(join(root, 'package-lock.json'), json(lock), 'utf8');
			assertFails(await verify(root), /registry package lacks valid SHA-512 integrity/);
		});
	});
});

test('accepts bundled entries only when a verified registry parent covers their bytes', async (t) => {
	await t.test('verified parent', async () => {
		await withFixture(async (root) => {
			const lock = packageLock();
			lock.packages['node_modules/esbuild/node_modules/bundled-helper'] = {
				version: '1.0.0',
				inBundle: true
			};
			await writeFile(join(root, 'package-lock.json'), json(lock), 'utf8');
			const result = await verify(root);
			assert.equal(result.ok, true, result.errors.join('\n'));
		});
	});

	await t.test('missing parent evidence', async () => {
		await withFixture(async (root) => {
			const lock = packageLock();
			lock.packages['node_modules/missing-parent/node_modules/bundled-helper'] = {
				version: '1.0.0',
				inBundle: true
			};
			await writeFile(join(root, 'package-lock.json'), json(lock), 'utf8');
			assertFails(await verify(root), /bundled package lacks a registry parent with valid integrity/);
		});
	});
});

test('rejects manifest and lockfile dependency drift', async () => {
	await withFixture(async (root) => {
		const manifest = rootPackage();
		manifest.devDependencies.esbuild = '0.28.2';
		manifest.allowScripts = { 'esbuild@0.28.1': true };
		await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
		assertFails(await verify(root), /package-lock\.json: devDependencies differs for package\.json/);
	});
});

test('reconciles every lockfile install script with an exact allowScripts entry', async (t) => {
	await t.test('unreviewed script', async () => {
		await withFixture(async (root) => {
			const manifest = rootPackage();
			manifest.allowScripts = {};
			await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
			assertFails(await verify(root), /install script is not reviewed.*esbuild@0\.28\.1/);
		});
	});

	await t.test('stale policy entry', async () => {
		await withFixture(async (root) => {
			const manifest = rootPackage();
			manifest.allowScripts['unused@1.0.0'] = false;
			await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
			assertFails(await verify(root), /does not match a lockfile install script: unused@1\.0\.0/);
		});
	});

	await t.test('unpinned policy identity', async () => {
		await withFixture(async (root) => {
			const manifest = rootPackage();
			manifest.allowScripts.esbuild = true;
			await writeFile(join(root, 'package.json'), json(manifest), 'utf8');
			assertFails(await verify(root), /allowScripts entry must pin package@version: esbuild/);
		});
	});
});
