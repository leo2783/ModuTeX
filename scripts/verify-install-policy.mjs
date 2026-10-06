import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_NODE = 'v24.19.0';
const REQUIRED_NPM = '11.17.0';
const REGISTRY = 'https://registry.npmjs.org/';
const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
const LIFECYCLE_NAMES = ['preinstall', 'install', 'postinstall', 'prepare'];
const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const TEXT_EXTENSIONS = new Set([
	'.bash',
	'.cjs',
	'.cmd',
	'.cts',
	'.js',
	'.json',
	'.md',
	'.mjs',
	'.ps1',
	'.sh',
	'.svelte',
	'.ts',
	'.yaml',
	'.yml'
]);
const PNPM_AUDIT_EXEMPT = new Set([
	'IMPLEMENTATION_PLAN.md',
	'IMPLEMENTATION_ISSUES.json',
	'IMPLEMENTATION_ISSUES.md',
	'IMPLEMENTATION_STATUS.md',
	'docs/security/npm-dependency-review-2026-08-13.md',
	'package-lock.json',
	'scripts/verify-install-policy.mjs',
	'scripts/tests/verify-install-policy.test.mjs'
]);

const normalizeRelative = (value) => value.split(sep).join('/');
const inside = (parent, candidate) => {
	const rel = relative(parent, candidate);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const stableRecord = (value = {}) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

async function walk(root, visit) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.worktrees') continue;
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) await walk(path, visit);
		else if (entry.isFile()) await visit(path, entry.name);
	}
}

async function expandWorkspaceManifests(root, rootPackage, fail) {
	const paths = new Set(['package.json']);
	if (!Array.isArray(rootPackage.workspaces)) {
		fail('package.json: workspaces must be an array');
		return [];
	}
	for (const pattern of rootPackage.workspaces) {
		if (typeof pattern !== 'string' || pattern.length === 0) {
			fail('package.json: workspace entries must be non-empty strings');
			continue;
		}
		if (!pattern.endsWith('/*')) {
			paths.add(`${pattern}/package.json`);
			continue;
		}
		const base = pattern.slice(0, -2);
		const basePath = resolve(root, base);
		if (!inside(root, basePath)) {
			fail(`package.json: workspace escapes repository (${pattern})`);
			continue;
		}
		try {
			for (const entry of await readdir(basePath, { withFileTypes: true })) {
				if (entry.isDirectory()) paths.add(`${base}/${entry.name}/package.json`);
			}
		} catch (error) {
			fail(`${base}: cannot enumerate workspace directory (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	const manifests = [];
	for (const path of [...paths].sort()) {
		const absolute = resolve(root, path);
		if (!inside(root, absolute)) {
			fail(`${path}: manifest escapes repository`);
			continue;
		}
		try {
			manifests.push({ path: normalizeRelative(path), absolute, data: await readJson(absolute) });
		} catch (error) {
			fail(`${path}: cannot read manifest (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return manifests;
}

function parseNpmrc(text, fail) {
	const config = new Map();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const at = line.indexOf('=');
		if (at <= 0) {
			fail(`.npmrc: invalid line ${line}`);
			continue;
		}
		const key = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		if (config.has(key)) fail(`.npmrc: duplicate key ${key}`);
		config.set(key, value);
	}
	return config;
}

async function npmVersion(env) {
	try {
		const npmCli = resolve(env.npm_execpath);
		const npmPackage = await readJson(resolve(dirname(npmCli), '..', 'package.json'));
		if (typeof npmPackage.version === 'string') return npmPackage.version;
	} catch {}
	return env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? null;
}

function lockPackageName(path, entry) {
	if (typeof entry.name === 'string' && entry.name) return entry.name;
	const marker = 'node_modules/';
	const at = path.lastIndexOf(marker);
	return at >= 0 ? path.slice(at + marker.length) : null;
}

function bundledAnchor(packages, path) {
	let parent = path;
	while (true) {
		const at = parent.lastIndexOf('/node_modules/');
		if (at < 0) return null;
		parent = parent.slice(0, at);
		const entry = packages[parent];
		if (!entry) return null;
		if (!entry.inBundle) return { path: parent, entry };
	}
}

export async function verifyInstallPolicy({
	root = DEFAULT_ROOT,
	nodeVersion = process.version,
	env = process.env,
	checkRuntime = true
} = {}) {
	root = resolve(root);
	const errors = [];
	const fail = (message) => errors.push(message);
	let rootPackage;
	let lock;
	try {
		rootPackage = await readJson(resolve(root, 'package.json'));
	} catch (error) {
		return { ok: false, errors: [`package.json: ${error instanceof Error ? error.message : String(error)}`] };
	}

	let npmrcText = '';
	try {
		npmrcText = await readFile(resolve(root, '.npmrc'), 'utf8');
	} catch (error) {
		fail(`.npmrc: ${error instanceof Error ? error.message : String(error)}`);
	}
	const npmrc = parseNpmrc(npmrcText, fail);
	const requiredConfig = {
		registry: REGISTRY,
		'save-exact': 'true',
		'strict-peer-deps': 'true',
		'engine-strict': 'true',
		'allow-directory': 'root',
		'allow-file': 'root',
		'allow-git': 'none',
		'allow-remote': 'none',
		'strict-allow-scripts': 'true',
		audit: 'true',
		'audit-level': 'high',
		'package-lock': 'true'
	};
	for (const [key, expected] of Object.entries(requiredConfig)) {
		if (npmrc.get(key) !== expected) fail(`.npmrc: ${key} must equal ${expected}`);
	}
	for (const key of npmrc.keys()) {
		const normalized = key.toLowerCase();
		if (
			normalized === 'dangerously-allow-all-scripts' ||
			normalized.includes('_auth') ||
			normalized.includes('token') ||
			normalized.includes('password') ||
			normalized.includes('username') ||
			normalized.endsWith(':registry') ||
			normalized.startsWith('@')
		) {
			fail(`.npmrc: forbidden key ${key}`);
		}
		if (normalized === 'proxy' || normalized === 'https-proxy') {
			try {
				const proxy = new URL(npmrc.get(key));
				if (proxy.username || proxy.password) fail(`.npmrc: credential-bearing ${key} is forbidden`);
			} catch {
				fail(`.npmrc: ${key} must be a valid URL`);
			}
		}
	}
	if (/(?:_auth|token|password|username)\s*=/i.test(npmrcText)) fail('.npmrc: possible credential detected');

	const manifests = await expandWorkspaceManifests(root, rootPackage, fail);
	let canonicalRoot = root;
	try {
		canonicalRoot = await realpath(root);
	} catch (error) {
		fail(`repository root cannot be resolved (${error instanceof Error ? error.message : String(error)})`);
	}
	const workspaceDirs = new Set();
	for (const { path, absolute } of manifests.filter(({ path }) => path !== 'package.json')) {
		try {
			const manifestInfo = await lstat(absolute);
			if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
				fail(`${path}: workspace manifest must be a regular file`);
				continue;
			}
			const canonical = await realpath(dirname(absolute));
			if (!inside(canonicalRoot, canonical)) fail(`${path}: workspace resolves outside repository`);
			else workspaceDirs.add(canonical);
		} catch (error) {
			fail(`${path}: cannot resolve workspace (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	for (const { path, absolute, data } of manifests) {
		for (const script of LIFECYCLE_NAMES) {
			if (data.scripts?.[script]) fail(`${path}: install lifecycle script ${script} is forbidden`);
		}
		for (const group of DEPENDENCY_GROUPS) {
			for (const [name, spec] of Object.entries(data[group] ?? {})) {
				const where = `${path} ${group}.${name}`;
				if (typeof spec !== 'string' || !spec) {
					fail(`${where}: dependency spec must be a non-empty string`);
					continue;
				}
				if (/^(?:git\+|git:|github:|https?:|ssh:)/i.test(spec)) {
					fail(`${where}: remote/Git dependency is forbidden`);
					continue;
				}
				if (/^(?:file:|link:)/i.test(spec)) {
					const target = resolve(dirname(absolute), spec.replace(/^(?:file:|link:)/i, ''));
					if (!inside(root, target)) {
						fail(`${where}: local dependency escapes repository`);
						continue;
					}
					try {
						const targetInfo = await lstat(target);
						if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
							fail(`${where}: local dependency must target a regular workspace directory`);
							continue;
						}
						const canonical = await realpath(target);
						if (!inside(canonicalRoot, canonical)) fail(`${where}: local dependency resolves outside repository`);
						else if (!workspaceDirs.has(canonical)) fail(`${where}: local dependency must target a declared workspace`);
					} catch (error) {
						fail(`${where}: cannot resolve local dependency (${error instanceof Error ? error.message : String(error)})`);
					}
					continue;
				}
				if (/^workspace:/i.test(spec)) {
					fail(`${where}: workspace protocol is not valid in the npm lock policy`);
					continue;
				}
				if (!EXACT_VERSION.test(spec)) fail(`${where}: direct dependency is not pinned exactly (${spec})`);
			}
		}
	}

	if (rootPackage.packageManager !== `npm@${REQUIRED_NPM}`) fail(`package.json: packageManager must be npm@${REQUIRED_NPM}`);
	if (rootPackage.engines?.node !== REQUIRED_NODE.slice(1)) fail(`package.json: engines.node must be ${REQUIRED_NODE.slice(1)}`);
	if (rootPackage.engines?.npm !== REQUIRED_NPM) fail(`package.json: engines.npm must be ${REQUIRED_NPM}`);
	if (checkRuntime) {
		if (nodeVersion !== REQUIRED_NODE) fail(`Node.js ${REQUIRED_NODE} required; running ${nodeVersion}`);
		const actualNpm = await npmVersion(env);
		if (actualNpm !== REQUIRED_NPM) fail(`npm ${REQUIRED_NPM} required; running ${actualNpm ?? 'unknown'}`);
	}

	const foundLockfiles = [];
	await walk(root, async (path, name) => {
		const repositoryPath = normalizeRelative(relative(root, path));
		if (LOCKFILE_NAMES.has(name)) foundLockfiles.push(repositoryPath);
		if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || PNPM_AUDIT_EXEMPT.has(repositoryPath))
			return;
		if (/\bpnpm\b/i.test(await readFile(path, 'utf8'))) fail(`${repositoryPath}: stale pnpm reference is forbidden`);
	});
	foundLockfiles.sort();
	if (foundLockfiles.length !== 1 || foundLockfiles[0] !== 'package-lock.json') {
		fail(`exactly root package-lock.json must exist; found ${foundLockfiles.join(', ') || 'none'}`);
	}
	try {
		lock = await readJson(resolve(root, 'package-lock.json'));
	} catch (error) {
		fail(`package-lock.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (lock) {
		if (lock.lockfileVersion !== 3) fail(`package-lock.json: lockfileVersion 3 required`);
		const lockRoot = lock.packages?.[''];
		if (!lockRoot) fail('package-lock.json: root package entry is missing');
		else {
			const manifestWorkspaces = JSON.stringify([...(rootPackage.workspaces ?? [])].sort());
			const lockWorkspaces = JSON.stringify([...(lockRoot.workspaces ?? [])].sort());
			if (manifestWorkspaces !== lockWorkspaces) fail('package-lock.json: workspace list differs from package.json');
		}
		for (const { path, data } of manifests) {
			const lockPath = path === 'package.json' ? '' : normalizeRelative(dirname(path));
			const lockManifest = lock.packages?.[lockPath];
			if (!lockManifest) {
				fail(`package-lock.json: package entry is missing for ${path}`);
				continue;
			}
			for (const group of DEPENDENCY_GROUPS) {
				const declared = JSON.stringify(stableRecord(data[group]));
				const locked = JSON.stringify(stableRecord(lockManifest[group]));
				if (declared !== locked) fail(`package-lock.json: ${group} differs for ${path}`);
			}
		}

		const scriptPackages = new Map();
		const lockPackages = lock.packages ?? {};
		for (const [path, entry] of Object.entries(lockPackages)) {
			if (!path.startsWith('node_modules/') || entry.link) continue;
			if (entry.inBundle) {
				const anchor = bundledAnchor(lockPackages, path);
				if (
					!anchor ||
					typeof anchor.entry.resolved !== 'string' ||
					!anchor.entry.resolved.startsWith(REGISTRY) ||
					typeof anchor.entry.integrity !== 'string' ||
					!INTEGRITY.test(anchor.entry.integrity)
				) {
					fail(`package-lock.json ${path}: bundled package lacks a registry parent with valid integrity`);
				}
			} else if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
				fail(`package-lock.json ${path}: registry package must use ${REGISTRY}`);
			} else if (typeof entry.integrity !== 'string' || !INTEGRITY.test(entry.integrity)) {
				fail(`package-lock.json ${path}: registry package lacks valid SHA-512 integrity`);
			}
			if (entry.hasInstallScript) {
				const name = lockPackageName(path, entry);
				if (!name || !entry.version) fail(`package-lock.json ${path}: scripted package lacks name or version`);
				else scriptPackages.set(`${name}@${entry.version}`, entry);
			}
		}

		const policy = rootPackage.allowScripts;
		if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('package.json: allowScripts object is required');
		else {
			for (const [identity, allowed] of Object.entries(policy)) {
				if (!/^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity)) {
					fail(`allowScripts entry must pin package@version: ${identity}`);
				}
				if (allowed !== true && allowed !== false) fail(`allowScripts value must be boolean: ${identity}`);
				if (!scriptPackages.has(identity)) fail(`allowScripts entry does not match a lockfile install script: ${identity}`);
			}
			for (const identity of scriptPackages.keys()) {
				if (!(identity in policy)) fail(`install script is not reviewed in allowScripts: ${identity}`);
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		manifestCount: manifests.length,
		lockEntryCount: Object.keys(lock?.packages ?? {}).length,
		lockfiles: foundLockfiles
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await verifyInstallPolicy();
	if (!result.ok) {
		console.error(`Install policy failed (${result.errors.length}):`);
		for (const error of result.errors) console.error(`- ${error}`);
		process.exitCode = 1;
	} else {
		console.log(`Install policy passed: ${result.manifestCount} manifests, ${result.lockEntryCount} lock entries.`);
	}
}
