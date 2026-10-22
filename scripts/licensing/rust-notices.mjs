// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repositoryRoot, 'crates', 'document-core', 'Cargo.toml');
const outputDirectory = path.join(repositoryRoot, 'apps', 'frontend', 'src', 'features', 'document-core', 'generated');
const outputPath = path.join(outputDirectory, 'RUST_THIRD_PARTY_NOTICES.md');
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_LICENSE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_LICENSE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const MAX_PACKAGES = 512;
const MAX_LICENSE_FILES = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const cratesIoSources = new Set([
	'registry+https://github.com/rust-lang/crates.io-index',
	'registry+sparse+https://index.crates.io/'
]);
const licenseFile = (name) => new RegExp(`^LICEN[CS]E-${name}(?:\\.[A-Za-z0-9_-]+)?$`, 'i');
const requiredFiles = new Map([
	['0BSD OR MIT OR Apache-2.0', [licenseFile('0BSD'), licenseFile('MIT'), licenseFile('APACHE')]],
	['MIT OR Apache-2.0', [licenseFile('APACHE'), licenseFile('MIT')]],
	['Unlicense OR MIT', [/^COPYING$/i, licenseFile('MIT')]],
	['MIT OR Zlib OR Apache-2.0', [/^LICEN[CS]E$/i, licenseFile('APACHE'), licenseFile('MIT'), licenseFile('ZLIB')]],
	['Apache-2.0 OR BSL-1.0', [licenseFile('APACHE'), licenseFile('BOOST')]],
	['MIT', [/^LICEN[CS]E(?:\.md)?$/i]],
	['(MIT OR Apache-2.0) AND Unicode-3.0', [licenseFile('APACHE'), licenseFile('MIT'), licenseFile('UNICODE')]]
]);
const rootLegalName = /^(?:licen[cs]es?|notices?|copying|copyrights?)(?:$|[._-])/i;

function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function metadata() {
	const result = spawnSync('cargo', [
		'metadata', '--locked', '--offline', '--manifest-path', manifestPath,
		'--features', 'wasm', '--filter-platform', 'wasm32-unknown-unknown', '--format-version', '1'
	], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_METADATA_BYTES });
	if (result.error) throw new Error(`cargo metadata failed: ${result.error.message}`);
	if (result.signal || result.status !== 0) {
		const detail = String(result.stderr ?? '').trim().slice(0, 4096);
		throw new Error(`cargo metadata failed${result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}${detail ? `: ${detail}` : ''}`);
	}
	try {
		const value = JSON.parse(result.stdout ?? '');
		if (!Array.isArray(value.packages) || !Array.isArray(value.resolve?.nodes)) throw new Error('missing resolved package graph');
		return value;
	} catch (error) {
		throw new Error(`Invalid cargo metadata: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function packageClosure(value) {
	const root = value.packages.find((pkg) =>
		pkg.name === 'modutex-document-core' && path.resolve(pkg.manifest_path) === path.resolve(manifestPath)
	);
	if (!root) throw new Error('cargo metadata did not resolve crates/document-core/Cargo.toml');
	const nodes = new Map(value.resolve.nodes.map((node) => [node.id, node]));
	const packages = new Map(value.packages.map((pkg) => [pkg.id, pkg]));
	const visited = new Set();
	const pending = [root.id];
	while (pending.length) {
		const id = pending.pop();
		if (visited.has(id)) continue;
		const node = nodes.get(id);
		if (!node || !Array.isArray(node.deps)) throw new Error(`Incomplete Cargo resolve node: ${id}`);
		visited.add(id);
		for (const dependency of node.deps) {
			if (typeof dependency.pkg !== 'string' || !Array.isArray(dependency.dep_kinds)) {
				throw new Error(`Invalid dependency edge in Cargo resolve node: ${id}`);
			}
			if (dependency.dep_kinds.some((kind) => kind && (kind.kind === null || kind.kind === 'build'))) {
				pending.push(dependency.pkg);
			}
		}
	}
	const result = [...visited].filter((id) => id !== root.id).map((id) => {
		const pkg = packages.get(id);
		if (!pkg) throw new Error(`Cargo resolve references a missing package: ${id}`);
		return pkg;
	});
	if (result.length === 0 || result.length > MAX_PACKAGES) throw new Error('Unexpected resolved dependency count');
	for (const pkg of result) {
		if (typeof pkg.source !== 'string' || !cratesIoSources.has(pkg.source)) {
			throw new Error(`Unsupported non-local package source: ${pkg.name} ${pkg.version}`);
		}
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(pkg.name) || !/^[A-Za-z0-9.+-]+$/.test(pkg.version)) {
			throw new Error('Invalid Cargo package name or version');
		}
	}
	return result.sort((left, right) => compareText(left.name, right.name) ||
		compareText(left.version, right.version) || compareText(left.id, right.id));
}

function safeRelativePath(value, context) {
	if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value) ||
		path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
		throw new Error(`Unsafe ${context} path`);
	}
	const parts = value.split(/[\\/]/);
	if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe ${context} path`);
	return parts.join(path.sep);
}

async function readPackageFile(root, relative, usage) {
	const safePath = safeRelativePath(relative, 'license');
	const absolutePath = path.resolve(root, safePath);
	const withinPackage = path.relative(root, absolutePath);
	if (!withinPackage || withinPackage === '..' || withinPackage.startsWith(`..${path.sep}`) || path.isAbsolute(withinPackage)) {
		throw new Error('License path escapes its packaged source');
	}
	let current = root;
	let info;
	for (const [index, part] of safePath.split(path.sep).entries()) {
		current = path.join(current, part);
		info = await lstat(current);
		if (info.isSymbolicLink()) throw new Error(`Symlink in license path: ${relative}`);
		if (index < safePath.split(path.sep).length - 1 && !info.isDirectory()) {
			throw new Error(`Invalid license path component: ${relative}`);
		}
	}
	if (!info?.isFile()) throw new Error(`License path is not a regular file: ${relative}`);
	if (info.size > MAX_LICENSE_FILE_BYTES) throw new Error(`License file exceeds size limit: ${relative}`);
	const bytes = await readFile(current);
	if (!bytes.length || bytes.length > MAX_LICENSE_FILE_BYTES) throw new Error(`Empty or oversized license file: ${relative}`);
	usage.bytes += bytes.length;
	usage.files++;
	if (usage.bytes > MAX_TOTAL_LICENSE_BYTES || usage.files > MAX_LICENSE_FILES) {
		throw new Error('Rust license text exceeds the generation limits');
	}
	let text;
	try {
		text = decoder.decode(bytes);
	} catch {
		throw new Error(`License file is not valid UTF-8: ${relative}`);
	}
	return { path: safePath.split(path.sep).join('/'), text };
}

async function packageTexts(pkg, usage) {
	if (typeof pkg.license !== 'string' || !requiredFiles.has(pkg.license)) {
		throw new Error(`Missing or unexpected SPDX license expression for ${pkg.name} ${pkg.version}`);
	}
	const root = await realpath(path.dirname(pkg.manifest_path));
	const names = new Set();
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!rootLegalName.test(entry.name)) continue;
		if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Unexpected non-file license entry: ${pkg.name}/${entry.name}`);
		names.add(entry.name);
	}
	if (pkg.license_file !== null && pkg.license_file !== undefined) names.add(pkg.license_file);
	if (names.size === 0) throw new Error(`No license or notice files found for ${pkg.name} ${pkg.version}`);
	const files = [];
	for (const name of [...names].map((item) => safeRelativePath(item, 'license')).sort(compareText)) {
		files.push(await readPackageFile(root, name, usage));
	}
	for (const expected of requiredFiles.get(pkg.license)) {
		if (!files.some((file) => expected.test(path.posix.basename(file.path)))) {
			throw new Error(`Missing license text required by ${pkg.license}: ${pkg.name} ${pkg.version}`);
		}
	}
	return files;
}

function codeFence(text) {
	let ticks = 0;
	let tildes = 0;
	let currentTicks = 0;
	let currentTildes = 0;
	for (let i = 0; i < text.length; i++) {
		const character = text[i];
		if (character === '`') {
			currentTicks++;
			if (currentTicks > ticks) ticks = currentTicks;
			currentTildes = 0;
		} else if (character === '~') {
			currentTildes++;
			if (currentTildes > tildes) tildes = currentTildes;
			currentTicks = 0;
		} else {
			currentTicks = 0;
			currentTildes = 0;
		}
	}
	const marker = ticks <= tildes ? '`' : '~';
	const fence = marker.repeat(Math.max(3, (marker === '`' ? ticks : tildes) + 1));
	return `${fence}text\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

function inlineCode(text) {
	let ticks = 0;
	let currentTicks = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '`') {
			currentTicks++;
			if (currentTicks > ticks) ticks = currentTicks;
		} else {
			currentTicks = 0;
		}
	}
	const fence = '`'.repeat(ticks + 1);
	return `${fence}${text}${fence}`;
}

async function main() {
	const value = metadata();
	const dependencies = packageClosure(value);
	const usage = { bytes: 0, files: 0 };
	const notices = [];
	const header = '# Rust/WASM third-party notices\n\n' +
		'Locked document-core Rust/WASM dependency and build-input licenses. ' +
		'Original upstream license and notice texts follow.\n\n';
	let outputBytes = Buffer.byteLength(header);
	notices.push(header);
	for (const pkg of dependencies) {
		const files = await packageTexts(pkg, usage);
		const url = `https://crates.io/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
		const entry = `## ${pkg.name} ${pkg.version}\n\n` +
			`- SPDX license expression: ${inlineCode(pkg.license)}\n` +
			`- Crate version: [${pkg.name} ${pkg.version}](${url})\n`;
		outputBytes += Buffer.byteLength(entry);
		notices.push(entry);
		for (const file of files) {
			const section = `\n### ${inlineCode(file.path)}\n\n${codeFence(file.text)}\n`;
			outputBytes += Buffer.byteLength(section);
			if (outputBytes > MAX_OUTPUT_BYTES) throw new Error('Generated Rust notices exceed the output size limit');
			notices.push(section);
		}
		notices.push('\n');
	}
	await mkdir(outputDirectory, { recursive: true });
	await writeFile(outputPath, notices.join(''), 'utf8');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
