import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const SECURITY_FLOORS = new Map([
	['axios', '1.20.0'],
	['@xmldom/xmldom', '0.8.15'],
	['fast-uri', '3.1.7'],
	['js-yaml', '4.3.2']
]);
const BRACE_EXPANSION_FLOORS = new Map([
	[1, '1.1.21'],
	[2, '2.1.7'],
	[5, '5.0.12']
]);
const POST_BASELINE_LOCK_PATHS = new Map([
	[
		'brace-expansion',
		['node_modules/brace-expansion', 'node_modules/filelist/node_modules/brace-expansion', 'node_modules/glob/node_modules/brace-expansion']
	],
	['joi', ['node_modules/joi']],
	['undici', ['node_modules/node-gyp/node_modules/undici', 'node_modules/undici']],
	['electron', ['node_modules/electron']]
]);
const FORBIDDEN_PACKAGES = new Set(['miniflare', 'sharp', 'workerd', 'wrangler']);

test('wait-on resolves only the exact reviewed Axios remediation', async () => {
	const manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
	const lock = JSON.parse(await readFile(resolve(ROOT, 'package-lock.json'), 'utf8'));
	assert.equal(manifest.devDependencies['wait-on'], '8.0.5');
	assert.deepEqual(manifest.overrides['wait-on@8.0.5'], { axios: '1.20.0' });
	const entries = lockEntries(lock.packages, 'axios');
	assert.equal(entries.length, 1);
	assert.equal(entries[0][1].version, '1.20.0');
	assert.equal(entries[0][1].license, 'MIT');
	assert.equal(entries[0][1].resolved, 'https://registry.npmjs.org/axios/-/axios-1.20.0.tgz');
	assert.equal(entries[0][1].hasInstallScript, undefined);
});

function compareVersions(left, right) {
	const leftParts = left.split('.').map(Number);
	const rightParts = right.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
	}
	return 0;
}

function lockEntries(packages, packageName) {
	const suffix = `/node_modules/${packageName}`;
	return Object.entries(packages).filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(suffix));
}

test('lockfile meets reviewed dependency security floors without adding excluded packages', async () => {
	const [manifestText, lockText] = await Promise.all([
		readFile(resolve(ROOT, 'package.json'), 'utf8'),
		readFile(resolve(ROOT, 'package-lock.json'), 'utf8')
	]);
	const manifest = JSON.parse(manifestText);
	const lock = JSON.parse(lockText);

	assert.equal(manifest.devDependencies?.['js-yaml'], '4.3.2', 'js-yaml must be an exact root development dependency');
	for (const [name, minimum] of SECURITY_FLOORS) {
		const entries = lockEntries(lock.packages ?? {}, name);
		assert.ok(entries.length > 0, `package-lock.json must contain ${name}`);
		for (const [path, entry] of entries) {
			assert.match(entry.version ?? '', /^\d+\.\d+\.\d+$/, `${path} must have a stable semantic version`);
			assert.ok(compareVersions(entry.version, minimum) >= 0, `${path} ${entry.version} is below the reviewed floor ${minimum}`);
		}
	}

	const forbidden = Object.keys(lock.packages ?? {}).filter((path) =>
		[...FORBIDDEN_PACKAGES].some((name) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
	);
	assert.deepEqual(forbidden, [], 'dependency update must not reintroduce Wrangler, Miniflare, workerd, or sharp');
});

test('post-baseline advisory floors cover every affected lockfile path', async () => {
	const [manifestText, lockText] = await Promise.all([
		readFile(resolve(ROOT, 'package.json'), 'utf8'),
		readFile(resolve(ROOT, 'package-lock.json'), 'utf8')
	]);
	const manifest = JSON.parse(manifestText);
	const lock = JSON.parse(lockText);

	assert.equal(manifest.devDependencies?.electron, '43.5.0');
	assert.equal(manifest.overrides?.['brace-expansion@^1'], '1.1.21');
	assert.equal(manifest.overrides?.['brace-expansion@^2'], '2.1.7');
	assert.equal(manifest.overrides?.['brace-expansion@^5'], '5.0.12');
	assert.equal(manifest.overrides?.joi, '18.2.6');
	assert.equal(manifest.overrides?.['undici@^6'], '6.28.1');
	assert.equal(manifest.overrides?.['undici@^7'], '7.29.1');

	for (const [name, expectedPaths] of POST_BASELINE_LOCK_PATHS) {
		const entries = lockEntries(lock.packages ?? {}, name);
		assert.deepEqual(
			entries.map(([path]) => path).sort(),
			expectedPaths.sort(),
			`${name} lock paths must remain the reviewed consumer graph`
		);

		for (const [path, entry] of entries) {
			const floor =
				name === 'brace-expansion'
					? BRACE_EXPANSION_FLOORS.get(Number(entry.version?.split('.')[0]))
					: { joi: '18.2.6', undici: path.includes('node-gyp') ? '6.28.1' : '7.29.1', electron: '43.5.0' }[name];
			assert.ok(floor, `${path} ${entry.version} must use a reviewed package version line`);
			assert.ok(compareVersions(entry.version, floor) >= 0, `${path} ${entry.version} is below ${floor}`);
		}
	}

	assert.deepEqual(
		[...new Set(lockEntries(lock.packages ?? {}, 'brace-expansion').map(([, entry]) => Number(entry.version.split('.')[0])))].sort(),
		[1, 2, 5],
		'no additional brace-expansion major line may enter without review'
	);
});
