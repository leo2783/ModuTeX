// Keep active first-party release manifests in lockstep. Historical projects and
// third-party dependencies intentionally retain their own versions.
//
// Usage:
//   node scripts/set-version.mjs 0.9.1   set the app version everywhere
//   node scripts/set-version.mjs         sync the others to the root's current version
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const maxVersionLength = 128;
const versionPattern =
	/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (process.argv.length > 3) {
	console.error('Usage: node scripts/set-version.mjs [version]');
	process.exit(1);
}

const arg = process.argv[2];
const version = arg ?? rootPkg.version;
if (
	typeof version !== 'string' ||
	version.length > maxVersionLength ||
	!versionPattern.test(version)
) {
	console.error(
		`Invalid version "${version}". Expected strict semver, at most ${maxVersionLength} characters.`
	);
	process.exit(1);
}

// Only active first-party release manifests belong here. Do not add history/,
// archived landing, or third-party dependency manifests.
const jsonTargets = [
	{ path: 'package.json' },
	{
		path: 'apps/frontend/package.json',
		references: [['dependencies', '@modutex/frontend-contracts']]
	},
	{ path: 'apps/desktop-tauri/tauri.conf.json' },
	{ path: 'packages/frontend-contracts/package.json' }
];
const cargoTargets = [
	'apps/desktop-tauri/Cargo.toml',
	'crates/document-core/Cargo.toml'
];

function updateJsonManifest(target) {
	const filePath = path.join(root, target.path);
	const source = fs.readFileSync(filePath, 'utf8');
	const manifest = JSON.parse(source);
	if (
		typeof manifest !== 'object' ||
		manifest === null ||
		Array.isArray(manifest) ||
		typeof manifest.version !== 'string'
	) {
		throw new Error(`Missing version field in ${target.path}`);
	}

	let dirty = false;
	if (manifest.version !== version) {
		manifest.version = version;
		dirty = true;
	}

	for (const [section, name] of target.references ?? []) {
		const dependencies = manifest[section];
		if (
			typeof dependencies !== 'object' ||
			dependencies === null ||
			Array.isArray(dependencies) ||
			!Object.hasOwn(dependencies, name)
		) {
			throw new Error(`Missing internal reference ${section}.${name} in ${target.path}`);
		}
		if (dependencies[name] !== version) {
			dependencies[name] = version;
			dirty = true;
		}
	}

	if (dirty) {
		const indentation = source.match(/^[\t ]+(?=")/m)?.[0] ?? '\t';
		fs.writeFileSync(filePath, JSON.stringify(manifest, null, indentation) + '\n');
		console.log(`updated ${target.path} -> ${version}`);
	} else {
		console.log(`= ${target.path} already ${version}`);
	}
	return dirty;
}

function updateCargoManifest(rel) {
	const filePath = path.join(root, rel);
	const source = fs.readFileSync(filePath, 'utf8');
	const packageHeader = /^\[package\][ \t]*$/m.exec(source);
	if (!packageHeader) throw new Error(`Missing [package] section in ${rel}`);

	const contentStart = packageHeader.index + packageHeader[0].length;
	const nextHeader = source.indexOf('\n[', contentStart);
	const sectionEnd = nextHeader === -1 ? source.length : nextHeader + 1;
	const section = source.slice(packageHeader.index, sectionEnd);
	const versionLine =
		/^([ \t]*version[ \t]*=[ \t]*)"[^"\r\n]+"([ \t]*(?:#.*)?)$/m.exec(section);
	if (!versionLine) throw new Error(`Missing package version field in ${rel}`);

	const updatedSection = section.replace(
		versionLine[0],
		`${versionLine[1]}"${version}"${versionLine[2]}`
	);
	if (updatedSection === section) {
		console.log(`= ${rel} already ${version}`);
		return false;
	}

	fs.writeFileSync(
		filePath,
		source.slice(0, packageHeader.index) + updatedSection + source.slice(sectionEnd)
	);
	console.log(`updated ${rel} -> ${version}`);
	return true;
}

let changed = 0;
for (const target of jsonTargets) {
	if (updateJsonManifest(target)) changed++;
}
for (const rel of cargoTargets) {
	if (updateCargoManifest(rel)) changed++;
}
console.log(
	changed
		? `\nActive release versions are now ${version}.`
		: `\nAll active versions are in sync at ${version}.`
);
