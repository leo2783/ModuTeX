// SPDX-License-Identifier: Apache-2.0
/*
 * After the Windows packaging step, optionally write one JSON
 * receipt shaped as {installerPath, installerSha256, bundledExeSha256,
 * files:[{path,sha256,sizeBytes,role?,license?}], thirdPartySignatures?:[]}.
 * Paths are project-root-relative; the receipt producer supplies actual hashes.
 * Run this script with --payload-receipt <path> to consume it. The default
 * invocation needs no receipt and marks payload evidence unverified. Receipt
 * license/signature declarations are retained as declarations, not verified
 * legal conclusions. This project-specific inventory is not a standard SBOM.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
	existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync,
	statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET = 'x86_64-pc-windows-msvc';
const DEFAULT_OUTPUT = '.verification-artifacts/tauri/component-inventory.json';
const WORKSPACES = [
	['apps/frontend', 'Tauri desktop frontend source and build'],
	['packages/frontend-contracts', 'desktop shared frontend contracts source and build'],
	['landing', 'separate landing-site source and build; not part of the desktop payload']
];
const INPUT_PATHS = [
	'package.json', 'package-lock.json', 'apps/desktop-tauri/Cargo.toml',
	'apps/desktop-tauri/Cargo.lock', 'apps/desktop-tauri/tauri.conf.json',
	...WORKSPACES.map(([path]) => `${path}/package.json`),
	'vendor/tectonic/VERSION', 'vendor/tectonic/windows-x64/tectonic.exe',
	'vendor/notices/TECTONIC-LICENSE.txt', 'vendor/notices/TECTONIC-NOTICE.md'
];

function fail(field, message) {
	throw new Error(`${field}: ${message}`);
}

function object(value, field) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		fail(field, 'Expected an object');
	}
	return value;
}

function text(value, field) {
	if (typeof value !== 'string' || !value.trim()) fail(field, 'Expected non-empty text');
	return value.trim();
}

function safeRelative(value, field) {
	const path = text(value, field);
	if (
		path.includes('\\') || path.includes('\0') || path.startsWith('/') ||
		/^[A-Za-z]:/.test(path) ||
		path.split('/').some((part) => !part || part === '.' || part === '..')
	) fail(field, 'Expected a safe project-relative path using forward slashes');
	return path;
}

function inside(root, path) {
	const part = relative(root, path);
	return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function projectPath(root, value, field) {
	const raw = text(value, field);
	let path;
	if (isAbsolute(raw)) {
		path = resolve(raw);
	} else {
		path = resolve(root, ...safeRelative(raw, field).split('/'));
	}
	if (!inside(root, path)) fail(field, 'Path is outside the project root');
	return path;
}

function displayPath(root, path) {
	return relative(root, path).split(sep).join('/') || '.';
}

function pathExistsWithoutLinks(root, path, field) {
	const parts = relative(root, path).split(sep).filter(Boolean);
	let current = root;
	for (let index = 0; index < parts.length; index++) {
		current = resolve(current, parts[index]);
		let info;
		try {
			info = lstatSync(current);
		} catch (error) {
			if (error.code === 'ENOENT') return false;
			fail(field, `Cannot inspect path (${error.code ?? 'I/O error'})`);
		}
		if (info.isSymbolicLink()) fail(field, 'Symlink or reparse point is not allowed');
		if (index < parts.length - 1 && !info.isDirectory()) {
			fail(field, 'A parent path is not a directory');
		}
	}
	return true;
}

function inspectFile(root, value, field, optional = false) {
	const path = projectPath(root, value, field);
	if (!pathExistsWithoutLinks(root, path, field)) {
		if (optional) return null;
		fail(field, 'Required file is missing');
	}
	const before = lstatSync(path);
	if (!before.isFile()) fail(field, 'Expected a regular file');
	const bytes = readFileSync(path);
	const after = statSync(path);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
		fail(field, 'File changed while being read');
	}
	return {
		path: displayPath(root, path),
		absolutePath: path,
		bytes,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		sizeBytes: bytes.length,
		prefixHex: bytes.subarray(0, 2).toString('hex')
	};
}

function parseJson(bytes, field) {
	let value;
	try {
		value = JSON.parse(bytes.toString('utf8'));
	} catch (error) {
		fail(field, `Malformed JSON (${error.message})`);
	}
	return object(value, field);
}

function jsonFile(root, path, field, optional = false) {
	const file = inspectFile(root, path, field, optional);
	return file ? { file, value: parseJson(file.bytes, field) } : null;
}

function licenseInfo(value) {
	if (typeof value === 'string' && value.trim()) {
		return {
			license: value.trim(),
			declaredLicense: value.trim(),
			licenseStatus: 'declared in metadata; not legally evaluated'
		};
	}
	return {
		license: 'unknown/unresolved',
		declaredLicense: value ?? null,
		licenseStatus: 'unknown/unresolved'
	};
}

function dependencyMap(pkg, key, field) {
	const value = pkg[key];
	if (value === undefined) return {};
	object(value, field);
	for (const [name, range] of Object.entries(value)) {
		text(name, `${field}.name`);
		if (typeof range !== 'string' || !range) fail(`${field}.${name}`, 'Expected a dependency range');
	}
	return value;
}

function sameMap(left, right) {
	const sorted = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function npmInventory(root, npmLock) {
	const rootFile = jsonFile(root, 'package.json', 'package.json');
	const lock = parseJson(npmLock.bytes, 'package-lock.json');
	if (lock.lockfileVersion !== 3 || !lock.packages) {
		fail('package-lock.json', 'Expected npm lockfileVersion 3 with a packages map');
	}
	const packages = object(lock.packages, 'package-lock.json packages');
	const sources = [{ key: '', path: 'package.json', role: 'repository root and development tooling' }];
	for (const [path, role] of WORKSPACES) sources.push({ key: path, path: `${path}/package.json`, role });
	const sourceByKey = new Map();

	for (const source of sources) {
		const manifestFile = source.key ? jsonFile(root, source.path, source.path).file : rootFile.file;
		const manifest = source.key ? jsonFile(root, source.path, source.path).value : rootFile.value;
		const name = text(manifest.name, `${source.path}.name`);
		const version = text(manifest.version, `${source.path}.version`);
		const locked = object(packages[source.key], `package-lock.json ${source.key || 'root'}`);
		if (locked.name !== name || locked.version !== version) {
			fail(`package-lock.json ${source.key || 'root'}`, 'Package name/version do not match its source manifest');
		}
		for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
			const declared = dependencyMap(manifest, kind, `${source.path}.${kind}`);
			const recorded = dependencyMap(locked, kind, `package-lock.json ${source.key || 'root'}.${kind}`);
			if (!sameMap(declared, recorded)) {
				fail(`package-lock.json ${source.key || 'root'}.${kind}`, 'Dependency map is stale or inconsistent with its source manifest');
			}
		}
		sourceByKey.set(source.key, { ...source, manifest, manifestFile, name, version });
	}

	for (const [key, item] of Object.entries(packages)) {
		if (key) safeRelative(key, 'package-lock.json package path');
		object(item, `package-lock.json ${key || 'root'}`);
	}

	function linkTarget(key) {
		const item = packages[key];
		if (item.link !== true) return key;
		const target = safeRelative(item.resolved, `package-lock.json ${key}.resolved`);
		if (!Object.hasOwn(packages, target)) fail('package-lock.json', `Unresolved workspace link ${key}`);
		return target;
	}
	for (const key of Object.keys(packages)) if (key) linkTarget(key);

	function resolveDependency(from, name) {
		let directory = from;
		for (;;) {
			if (directory && !directory.toLowerCase().endsWith('/node_modules')) {
				const candidate = `${directory}/node_modules/${name}`;
				if (Object.hasOwn(packages, candidate)) return candidate;
			}
			if (!directory) return Object.hasOwn(packages, `node_modules/${name}`)
				? `node_modules/${name}` : null;
			const slash = directory.lastIndexOf('/');
			directory = slash < 0 ? '' : directory.slice(0, slash);
		}
	}

	const reached = new Map();
	const visited = new Set();
	const edges = [];
	const unresolved = [];
	const queue = [];
	const mark = (key, scope, kind) => {
		if (!reached.has(key)) reached.set(key, { scopes: new Set(), kinds: new Set() });
		reached.get(key).scopes.add(scope);
		reached.get(key).kinds.add(kind);
	};
	const enqueue = (from, name, range, kind, scope, strict) => {
		const key = resolveDependency(from, name);
		const edge = { from: from || 'repository root', dependency: name, declaredRange: range, kind, scope };
		if (!key) {
			const missing = { ...edge, status: 'unresolved' };
			edges.push(missing);
			unresolved.push(missing);
			if (strict) fail('package-lock.json', `Missing locked ${kind} dependency ${name}`);
			return;
		}
		edges.push({ ...edge, lockPath: key, status: 'resolved' });
		queue.push({ key, scope, kind });
	};

	for (const source of sourceByKey.values()) {
		for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
			const scope = source.key === 'landing'
				? `landing-site:${kind} (not evidence of Tauri desktop payload inclusion)`
				: source.key
					? `${source.key}:${kind}`
					: `repository-root:${kind} (not evidence of Tauri desktop payload inclusion)`;
			for (const [name, range] of Object.entries(dependencyMap(source.manifest, kind, source.path))) {
				enqueue(source.key, name, range, kind, scope, kind === 'dependencies' || kind === 'devDependencies');
			}
		}
	}

	while (queue.length) {
		const current = queue.pop();
		const target = linkTarget(current.key);
		mark(current.key, current.scope, current.kind);
		mark(target, current.scope, current.kind);
		const visitKey = `${target}\0${current.scope}`;
		if (visited.has(visitKey)) continue;
		visited.add(visitKey);
		for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
			for (const [name, range] of Object.entries(dependencyMap(packages[target], kind, target))) {
				const child = resolveDependency(target, name);
				if (!child) {
					const missing = {
						from: target, dependency: name, declaredRange: range, kind,
						scope: current.scope, status: 'unresolved'
					};
					edges.push(missing);
					unresolved.push(missing);
					if (kind === 'dependencies') fail('package-lock.json', `Missing locked dependency ${name} from ${target}`);
				} else {
					edges.push({
						from: target, dependency: name, declaredRange: range, kind,
						scope: current.scope, lockPath: child, status: 'resolved'
					});
					queue.push({ key: child, scope: current.scope, kind });
				}
			}
		}
	}

	const sourceManifests = [...sourceByKey.values()].map((source) => {
		const counts = {};
		for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
			counts[kind] = Object.keys(dependencyMap(source.manifest, kind, source.path)).length;
		}
		return {
			path: source.path, name: source.name, version: source.version,
			...licenseInfo(source.manifest.license), role: source.role, dependencyCounts: counts
		};
	});
	const records = Object.keys(packages).filter(Boolean).sort().map((key) => {
		const locked = packages[key];
		const target = linkTarget(key);
		const effective = packages[target];
		const source = sourceByKey.get(target);
		const name = effective.name ?? source?.name ??
			(key.includes('node_modules/') ? key.slice(key.lastIndexOf('node_modules/') + 13) : key);
		const reach = reached.get(key) ?? reached.get(target);
		const rawLicense = Object.hasOwn(effective, 'license') ? effective.license : source?.manifest.license;
		return {
			lockPath: key, name,
			version: effective.version ?? source?.version ?? null,
			...licenseInfo(rawLicense),
			license_file: effective.licenseFile ?? effective.license_file ??
				source?.manifest.licenseFile ?? source?.manifest.license_file ?? null,
			source: typeof effective.resolved === 'string' ? effective.resolved : null,
			integrity: typeof effective.integrity === 'string' ? effective.integrity : null,
			integrityKind: typeof effective.integrity === 'string' ? 'npm lock integrity' : null,
			reachableFrom: reach ? [...reach.scopes].sort() : [],
			dependencyTypes: reach ? [...reach.kinds].sort() : [],
			relationship: reach ? 'reachable in selected source/build graph' : 'lock entry not reached from selected source/build graph',
			payloadStatus: 'not established by npm lock or source metadata'
		};
	});
	return {
		lockfile: { path: npmLock.path, sha256: npmLock.sha256, lockfileVersion: 3 },
		scope: 'All lock entries; reachability is calculated from repository-root tooling, the Tauri frontend/contracts, and the separate landing-site manifest. Landing-site dependencies are not desktop dependencies; source/build reachability does not establish Tauri payload inclusion.',
		sourceManifests,
		dependencyEdges: edges,
		unresolvedRelationships: unresolved,
		packages: records
	};
}

function cargoPackageManifest(bytes) {
	let active = false;
	const fields = {};
	for (const line of bytes.toString('utf8').split(/\r?\n/)) {
		if (/^\s*\[/.test(line)) {
			if (active) break;
			active = /^\s*\[package\]\s*$/.test(line);
		} else if (active) {
			const match = line.match(/^\s*(name|version)\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
			if (match) fields[match[1]] = match[2];
		}
	}
	if (!fields.name || !fields.version) fail('Cargo.toml', 'Missing literal [package] name/version');
	return fields;
}

function cargoLockPackages(bytes) {
	const contents = bytes.toString('utf8');
	if (!/^\s*version\s*=\s*[1-4]\s*$/m.test(contents)) fail('Cargo.lock', 'Missing supported lockfile version');
	const blocks = contents.split(/^\[\[package\]\]\s*$/m).slice(1);
	if (!blocks.length) fail('Cargo.lock', 'No package records found');
	const field = (block, name) => {
		const match = block.match(new RegExp(`^${name}\\s*=\\s*"([^"\\r\\n]*)"\\s*(?:#.*)?$`, 'm'));
		return match ? match[1] : null;
	};
	return blocks.map((block) => {
		const name = field(block, 'name');
		const version = field(block, 'version');
		if (!name || !version) fail('Cargo.lock', 'Package record is missing name or version');
		const raw = field(block, 'checksum');
		if (raw !== null && !/^[a-f0-9]{64}$/i.test(raw)) fail('Cargo.lock', `Invalid checksum for ${name}`);
		return { name, version, source: field(block, 'source'), checksum: raw?.toLowerCase() ?? null };
	});
}

function childEnvironment() {
	const allowed = new Set([
		'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
		'HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'APPDATA', 'LOCALAPPDATA',
		'TEMP', 'TMP', 'COMSPEC'
	]);
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (allowed.has(key.toUpperCase())) env[key] = value;
	}
	env.CARGO_NET_OFFLINE = 'true';
	env.CARGO_TERM_COLOR = 'never';
	env.GIT_TERMINAL_PROMPT = '0';
	return env;
}

function run(command, args, cwd, field) {
	const result = spawnSync(command, args, {
		cwd, env: childEnvironment(), encoding: 'utf8', shell: false,
		windowsHide: true, maxBuffer: 128 * 1024 * 1024
	});
	if (result.error) fail(field, `Could not start command (${result.error.code ?? result.error.message})`);
	if (result.status !== 0) {
		const detail = (result.stderr ?? '').trim().slice(0, 1000);
		fail(field, `Command exited ${result.status ?? 'without an exit status'}${detail ? `: ${detail}` : ''}`);
	}
	return result.stdout;
}

function cargoInventory(root, manifest, lock, cargoBin, cargoArgs) {
	const identity = cargoPackageManifest(manifest.bytes);
	const command = [
		...cargoArgs, 'metadata', '--locked', '--format-version', '1',
		'--filter-platform', TARGET, '--offline'
	];
	const stdout = run(cargoBin, command, resolve(root, 'apps/desktop-tauri'), 'cargo metadata');
	let metadata;
	try {
		metadata = object(JSON.parse(stdout), 'cargo metadata output');
	} catch (error) {
		if (error.message.startsWith('cargo metadata output:')) throw error;
		fail('cargo metadata output', `Malformed JSON (${error.message})`);
	}
	if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.workspace_members) ||
		!metadata.resolve || !Array.isArray(metadata.resolve.nodes)) {
		fail('cargo metadata output', 'Missing packages, workspace members, or resolved graph');
	}
	const packages = new Map();
	for (const item of metadata.packages) {
		object(item, 'cargo metadata package');
		const id = text(item.id, 'cargo metadata package.id');
		if (packages.has(id)) fail('cargo metadata output', `Duplicate package id ${id}`);
		packages.set(id, item);
	}
	const nodes = new Map();
	for (const node of metadata.resolve.nodes) {
		object(node, 'cargo metadata node');
		if (!packages.has(node.id) || nodes.has(node.id)) fail('cargo metadata output', `Unknown or repeated graph node ${node.id}`);
		nodes.set(node.id, node);
	}
	const members = metadata.workspace_members;
	if (!members.length) fail('cargo metadata output', 'Empty workspace member list');
	const host = members.map((id) => {
		const pkg = packages.get(id);
		if (typeof id !== 'string' || !pkg || !nodes.has(id)) fail('cargo metadata output', `Invalid workspace member ${String(id)}`);
		return pkg;
	});
	if (!host.some((pkg) => pkg.name === identity.name && pkg.version === identity.version)) {
		fail('cargo metadata output', 'Cargo metadata does not contain the Cargo.toml package identity');
	}

	const children = new Map();
	const kinds = new Map();
	for (const [id, node] of nodes) {
		const deps = new Set();
		const add = (target, depKinds = []) => {
			if (!packages.has(target)) fail('cargo metadata output', `Dependency package is missing: ${target}`);
			deps.add(target);
			if (!kinds.has(target)) kinds.set(target, new Set());
			for (const kind of depKinds) {
				object(kind, 'cargo metadata dependency kind');
				kinds.get(target).add(`${kind.kind ?? 'normal'}${kind.target ? ` (${kind.target})` : ''}`);
			}
		};
		if (Array.isArray(node.dependencies)) {
			for (const target of node.dependencies) {
				if (typeof target !== 'string') fail('cargo metadata output', 'Invalid dependency id');
				add(target);
			}
		}
		if (Array.isArray(node.deps)) {
			for (const dep of node.deps) {
				object(dep, 'cargo metadata dependency');
				add(text(dep.pkg, 'cargo metadata dependency.pkg'), Array.isArray(dep.dep_kinds) ? dep.dep_kinds : []);
			}
		}
		if (!Array.isArray(node.dependencies) && !Array.isArray(node.deps)) {
			fail('cargo metadata output', `Missing dependency edges for ${id}`);
		}
		children.set(id, deps);
	}

	const reached = new Map();
	for (const rootId of members) {
		const seen = new Set();
		const stack = [rootId];
		while (stack.length) {
			const id = stack.pop();
			if (seen.has(id)) continue;
			seen.add(id);
			if (!nodes.has(id)) fail('cargo metadata output', `Resolved graph node is missing: ${id}`);
			if (!reached.has(id)) reached.set(id, new Set());
			reached.get(id).add(rootId);
			for (const child of children.get(id)) stack.push(child);
		}
	}
	const lockPackages = cargoLockPackages(lock.bytes);
	const records = [...packages.entries()].map(([id, pkg]) => {
		const matches = lockPackages.filter((entry) =>
			entry.name === pkg.name && entry.version === pkg.version && entry.source === (pkg.source ?? null));
		const checksum = matches.length === 1 ? matches[0].checksum : null;
		const roots = [...(reached.get(id) ?? [])].sort();
		return {
			id, name: pkg.name, version: pkg.version,
			...licenseInfo(pkg.license),
			license_file: pkg.license_file ?? null,
			source: pkg.source ?? null,
			checksum,
			checksumKind: checksum ? 'Cargo.lock SHA-256' : null,
			reachability: {
				workspaceMember: members.includes(id),
				reachableFromWorkspaceMembers: roots,
				reachableFromWorkspace: roots.length > 0
			},
			dependencyTypes: [...(kinds.get(id) ?? [])].sort(),
			relationship: members.includes(id) ? 'workspace source package' :
				roots.length ? 'resolved Rust dependency' : 'metadata package not reached from workspace members',
			payloadStatus: 'build-graph evidence only; artifact inclusion is not established'
		};
	}).sort((a, b) => `${a.name}@${a.version}:${a.source ?? ''}`.localeCompare(`${b.name}@${b.version}:${b.source ?? ''}`));
	return {
		command: 'cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --offline',
		target: TARGET,
		manifest: { path: manifest.path, sha256: manifest.sha256, package: identity },
		lockfile: { path: lock.path, sha256: lock.sha256 },
		workspaceMembers: host.map((pkg) => ({ name: pkg.name, version: pkg.version })),
		packages: records
	};
}

function tectonicSource(root) {
	const versionFile = inspectFile(root, 'vendor/tectonic/VERSION', 'Tectonic VERSION');
	const version = text(versionFile.bytes.toString('utf8'), 'Tectonic VERSION');
	const binary = inspectFile(root, 'vendor/tectonic/windows-x64/tectonic.exe', 'Tectonic executable');
	const license = inspectFile(root, 'vendor/notices/TECTONIC-LICENSE.txt', 'Tectonic license');
	const notice = inspectFile(root, 'vendor/notices/TECTONIC-NOTICE.md', 'Tectonic notice');
	const licenseText = license.bytes.toString('utf8');
	const noticeText = notice.bytes.toString('utf8');
	if (!/Tectonic is licensed under the MIT License/i.test(licenseText)) {
		fail('Tectonic license', 'Supplied license text does not state MIT');
	}
	if (!/^[\da-f]{4}$/i.test(binary.prefixHex) || binary.prefixHex !== '4d5a') {
		fail('Tectonic executable', 'Expected a Windows PE executable');
	}
	if (!noticeText.includes(`Tectonic ${version}`) || !noticeText.includes('TECTONIC-LICENSE.txt')) {
		fail('Tectonic notice', 'Notice does not identify the version and license file');
	}
	return {
		name: 'Tectonic',
		version,
		relationship: 'vendored source binary and license evidence',
		license: 'MIT',
		declaredLicense: 'MIT',
		licenseStatus: 'MIT is stated in the supplied license text; no eligibility conclusion',
		binary: { path: binary.path, sha256: binary.sha256, sizeBytes: binary.sizeBytes },
		licenseEvidence: { path: license.path, sha256: license.sha256 },
		upstreamNotice: {
			path: notice.path, sha256: notice.sha256,
			embeddedLicenseVarietyDisclosed: /wide variety of open-source licenses/i.test(licenseText)
		},
		payloadStatus: 'not verified without a payload receipt'
	};
}

function sha(value, field) {
	const result = text(value, field).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(result)) fail(field, 'Expected a SHA-256 digest');
	return result;
}

function artifactReceipt(root, value) {
	const source = inspectFile(root, value, 'payload receipt');
	const receipt = parseJson(source.bytes, 'payload receipt');
	for (const key of ['installerPath', 'installerSha256', 'bundledExeSha256', 'files']) {
		if (!Object.hasOwn(receipt, key)) fail('payload receipt', `Missing ${key}`);
	}
	const installerPath = safeRelative(receipt.installerPath, 'payload receipt.installerPath');
	const installerSha = sha(receipt.installerSha256, 'payload receipt.installerSha256');
	const exeSha = sha(receipt.bundledExeSha256, 'payload receipt.bundledExeSha256');
	if (!Array.isArray(receipt.files)) fail('payload receipt.files', 'Expected an array');
	const seen = new Set();
	const files = receipt.files.map((item, index) => {
		object(item, `payload receipt.files[${index}]`);
		const path = safeRelative(item.path, `payload receipt.files[${index}].path`);
		const key = path.toLowerCase();
		if (seen.has(key)) fail('payload receipt.files', `Repeated path ${path}`);
		seen.add(key);
		const digest = sha(item.sha256, `payload receipt.files[${index}].sha256`);
		if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
			fail(`payload receipt.files[${index}].sizeBytes`, 'Expected a non-negative safe integer');
		}
		if (item.role !== undefined && typeof item.role !== 'string') fail('payload receipt.files.role', 'Expected text');
		if (item.license !== undefined && typeof item.license !== 'string') fail('payload receipt.files.license', 'Expected text');
		const actual = inspectFile(root, path, `payload file ${path}`, true);
		if (actual && (actual.sha256 !== digest || actual.sizeBytes !== item.sizeBytes)) {
			fail(`payload file ${path}`, 'Actual hash or size differs from the receipt');
		}
		if (actual && path.toLowerCase().endsWith('.exe') && actual.prefixHex !== '4d5a') {
			fail(`payload file ${path}`, 'Expected a PE executable');
		}
		return {
			path, sha256: digest, sizeBytes: item.sizeBytes,
			role: item.role ?? null,
			license: typeof item.license === 'string' && item.license.trim() ? item.license.trim() : 'unknown/unresolved',
			declaredLicense: item.license ?? null,
			licenseStatus: item.license ? 'receipt declaration; not independently evaluated' : 'unknown/unresolved',
			fileHashStatus: actual ? 'verified against local file' : 'local file unavailable; declaration only'
		};
	});
	const installer = inspectFile(root, installerPath, 'installer', true);
	if (installer && installer.sha256 !== installerSha) fail('installer', 'Actual SHA-256 differs from receipt');
	if (installer && installerPath.toLowerCase().endsWith('.exe') && installer.prefixHex !== '4d5a') {
		fail('installer', 'Expected a PE executable');
	}
	const declaredInstallerFile = files.find((file) => file.path.toLowerCase() === installerPath.toLowerCase());
	if (declaredInstallerFile && declaredInstallerFile.sha256 !== installerSha) {
		fail('payload receipt', 'Installer file entry disagrees with installerSha256');
	}
	const explicitExe = files.filter((file) =>
		/(application|bundled|built|desktop|app).*(exe|pe)|(exe|pe).*(application|bundled|built|desktop|app)/i.test(file.role ?? ''));
	const fallbackExe = files.filter((file) =>
		file.path.toLowerCase().endsWith('.exe') && file.path.toLowerCase() !== installerPath.toLowerCase());
	const exeCandidates = explicitExe.length ? explicitExe : fallbackExe;
	const exeMatches = exeCandidates.filter((file) => file.sha256 === exeSha);
	if (explicitExe.length && !exeMatches.length) {
		fail('payload receipt', 'Declared application executable does not match bundledExeSha256');
	}

	const signatures = receipt.thirdPartySignatures ?? [];
	if (!Array.isArray(signatures)) fail('payload receipt.thirdPartySignatures', 'Expected an array');
	const signatureEvidence = signatures.map((entry, index) => {
		object(entry, `thirdPartySignatures[${index}]`);
		if (entry.path !== undefined) projectPath(root, entry.path, `thirdPartySignatures[${index}].path`);
		if (entry.sha256 !== undefined) sha(entry.sha256, `thirdPartySignatures[${index}].sha256`);
		return { declaration: entry, verificationStatus: 'receipt-declared; not cryptographically verified' };
	});
	const webFiles = files.filter((file) =>
		`${file.path} ${file.declaredLicense ?? ''}`.toLowerCase().includes('webview2'));
	const webSignatures = signatureEvidence.filter((entry) =>
		JSON.stringify(entry.declaration).toLowerCase().includes('webview2'));
	return {
		path: source.path,
		sha256: source.sha256,
		scope: 'installer identity and receipt-declared files; not a complete extracted payload or standard SBOM',
		installer: {
			path: installerPath, sha256: installerSha,
			fileHashStatus: installer ? 'verified against local file' : 'local file unavailable; declaration only'
		},
		bundledExecutable: {
			sha256: exeSha,
			fileHashStatus: exeMatches.some((file) => file.fileHashStatus === 'verified against local file')
				? 'verified against local file'
				: exeMatches.length ? 'receipt hash matched; local file unavailable' : 'no matching executable file path in receipt',
			matchingFiles: exeMatches.map((file) => file.path)
		},
		files,
		thirdPartySignatures: signatureEvidence,
		webView2Review: {
			status: webFiles.length || webSignatures.length ? 'receipt declarations present' : 'no WebView2 receipt evidence',
			classificationCandidate: webFiles.length || webSignatures.length
				? 'Microsoft WebView2 runtime; system-library classification is not established'
				: 'unknown/unresolved',
			licenseEvidence: webFiles.map((file) => ({
				path: file.path, declaredLicense: file.declaredLicense,
				status: file.licenseStatus
			})),
			signatureEvidence: webSignatures,
			eligibilityDecision: 'not-established'
		}
	};
}

function parseArgs(argv) {
	const options = { root: process.cwd(), output: DEFAULT_OUTPUT, cargoBin: 'cargo', cargoArgs: [] };
	const used = new Set();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const split = arg.indexOf('=');
		const key = split < 0 ? arg : arg.slice(0, split);
		let value = split < 0 ? undefined : arg.slice(split + 1);
		if (key === '--help') return null;
		if (key === '--cargo-arg') {
			if (value === undefined) {
				if (index + 1 >= argv.length) fail(key, 'Missing value');
				value = argv[++index];
			}
			options.cargoArgs.push(value);
			continue;
		}
		const fields = {
			'--root': 'root', '--output': 'output',
			'--payload-receipt': 'payloadReceipt', '--cargo-bin': 'cargoBin'
		};
		if (!Object.hasOwn(fields, key)) fail('arguments', `Unknown option ${key}`);
		if (used.has(key)) fail(key, 'Option may only be specified once');
		used.add(key);
		if (value === undefined) {
			if (index + 1 >= argv.length) fail(key, 'Missing value');
			value = argv[++index];
		}
		options[fields[key]] = value;
	}
	return options;
}

function prepareOutput(root, options) {
	const output = projectPath(root, options.output, 'output');
	if (output === root) fail('output', 'Cannot replace the project root');
	const protectedPaths = [...INPUT_PATHS];
	if (options.payloadReceipt) protectedPaths.push(options.payloadReceipt);
	const outputKey = displayPath(root, output).toLowerCase();
	if (protectedPaths.some((path) => displayPath(root, projectPath(root, path, 'protected input')).toLowerCase() === outputKey)) {
		fail('output', 'Output collides with a protected inventory input');
	}
	const parts = relative(root, output).split(sep);
	if (parts.some((part) => part.toLowerCase() === '.git')) fail('output', 'Cannot write inside Git metadata');
	if (pathExistsWithoutLinks(root, output, 'output')) {
		if (!lstatSync(output).isFile()) fail('output', 'Existing output is not a regular file');
		unlinkSync(output);
	}
	return output;
}

function ensureOutputDirectory(root, output) {
	const parent = dirname(output);
	const parts = relative(root, parent).split(sep).filter(Boolean);
	let current = root;
	for (const part of parts) {
		current = resolve(current, part);
		if (!existsSync(current)) mkdirSync(current);
		const info = lstatSync(current);
		if (info.isSymbolicLink() || !info.isDirectory()) fail('output', 'Unsafe output directory');
	}
}

function writeInventory(root, output, inventory) {
	ensureOutputDirectory(root, output);
	const temporary = `${output}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
		renameSync(temporary, output);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		fail('output', `Cannot write inventory (${error.code ?? error.message})`);
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options) {
		console.log('Usage: node generate-component-inventory.mjs [--root path] [--output path] [--cargo-bin executable] [--cargo-arg arg] [--payload-receipt path]');
		return;
	}
	let root;
	try {
		root = realpathSync(resolve(options.root));
		if (!statSync(root).isDirectory()) fail('root', 'Expected a project directory');
	} catch (error) {
		fail('root', `Project directory is unavailable (${error.code ?? error.message})`);
	}
	const output = prepareOutput(root, options);
	const npmLock = inspectFile(root, 'package-lock.json', 'package-lock.json');
	const cargoManifest = inspectFile(root, 'apps/desktop-tauri/Cargo.toml', 'Cargo.toml');
	const cargoLock = inspectFile(root, 'apps/desktop-tauri/Cargo.lock', 'Cargo.lock');
	const configFile = jsonFile(root, 'apps/desktop-tauri/tauri.conf.json', 'Tauri config', true);
	const config = configFile?.value ?? null;
	const npm = npmInventory(root, npmLock);
	let cargoBin = options.cargoBin;
	if (isAbsolute(cargoBin) || cargoBin.includes('/') || cargoBin.includes('\\')) {
		cargoBin = resolve(root, cargoBin);
	}
	const cargo = cargoInventory(root, cargoManifest, cargoLock, cargoBin, options.cargoArgs);
	const tectonic = tectonicSource(root);
	const receipt = options.payloadReceipt ? artifactReceipt(root, options.payloadReceipt) : null;
	if (receipt) {
		const matches = (digest) => receipt.files.filter((file) => file.sha256 === digest).map((file) => ({
			path: file.path, fileHashStatus: file.fileHashStatus
		}));
		tectonic.payloadEvidence = {
			binaryHashMatches: matches(tectonic.binary.sha256),
			licenseHashMatches: matches(tectonic.licenseEvidence.sha256),
			noticeHashMatches: matches(tectonic.upstreamNotice.sha256),
			status: 'receipt-declared hash matches only; package inclusion is not established'
		};
		tectonic.payloadStatus = 'payload inclusion is not established';
	}
	const commit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], root, 'source git commit').trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) fail('source git commit', 'Invalid commit id');
	const sourceFiles = [
		npmLock, cargoManifest, cargoLock,
		jsonFile(root, 'package.json', 'package.json').file,
		...WORKSPACES.map(([,], index) => inspectFile(root, `${WORKSPACES[index][0]}/package.json`, 'workspace package manifest'))
	];
	if (configFile) sourceFiles.push(configFile.file);
	const unknownLicenses = {
		rustPackages: cargo.packages.filter((item) => item.license === 'unknown/unresolved').length,
		npmPackages: npm.packages.filter((item) => item.license === 'unknown/unresolved').length,
		payloadFiles: receipt ? receipt.files.filter((item) => item.license === 'unknown/unresolved').length : null
	};
	const inventory = {
		format: 'ModuTeX component inventory v1; not CycloneDX or SPDX',
		generatedAt: new Date().toISOString(),
		source: {
			gitCommit: commit,
			target: TARGET,
			inputFiles: sourceFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
			cargoLock: cargo.lockfile,
			npmLock: npm.lockfile
		},
		product: {
			sourcePackage: { name: npm.sourceManifests[0].name, version: npm.sourceManifests[0].version },
			productName: typeof config?.productName === 'string' ? config.productName : null,
			version: typeof config?.version === 'string' ? config.version : null,
			config: configFile ? { path: configFile.file.path, sha256: configFile.file.sha256 } : null,
			bundleConfig: config?.bundle ?? null,
			artifactStatus: receipt ? 'receipt supplied; verification scope is recorded below' : 'payload unverified; no receipt supplied'
		},
		rust: cargo,
		npm,
		vendoredComponents: [tectonic],
		payloadReceipt: receipt,
		distributionEligibility: {
			decision: 'not-established',
			unknownLicenseCounts: unknownLicenses,
			evidenceScope: 'Source/build graph and any supplied receipt; no complete payload closure or legal eligibility determination.'
		}
	};
	writeInventory(root, output, inventory);
	console.log(`Component inventory generated: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		main();
	} catch (error) {
		console.error(`component inventory: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
