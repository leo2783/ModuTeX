import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '../../..');
const appRoot = path.join(root, 'apps/frontend');
const evidenceFileName = 'frontend-build-evidence.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const portable = value => value.split(path.sep).join('/');
const inside = (base, candidate) => {
	const relative = path.relative(base, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function queryOf(id) {
	const index = id.indexOf('?');
	return new URLSearchParams(index < 0 ? '' : id.slice(index + 1).split('#', 1)[0]);
}

function pathFromId(id) {
	if (typeof id !== 'string' || id.startsWith('\0')) return null;
	let value = id.split(/[?#]/, 1)[0];
	if (value.startsWith('file://')) {
		try {
			value = fileURLToPath(value);
		} catch {
			return null;
		}
	}
	if (value.startsWith('/@fs/')) value = value.slice(4);
	if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
	if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) return null;
	return path.resolve(value);
}

async function inputFromAbsolute(candidate) {
	let absolute;
	try {
		absolute = await realpath(candidate);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
	if (!inside(root, absolute) || !(await stat(absolute)).isFile()) return null;
	const bytes = await readFile(absolute);
	return { absolute, path: portable(path.relative(root, absolute)), sha256: sha256(bytes) };
}

async function packageManifest(name) {
	let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
	while (inside(root, directory)) {
		const candidate = path.join(directory, 'package.json');
		try {
			const absolute = await realpath(candidate);
			const bytes = await readFile(absolute);
			const manifest = JSON.parse(bytes);
			if (manifest.name === name) return { absolute, bytes, manifest };
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_NOT_FOUND: ${name}`);
}

async function npmCompilerIdentity(name, role, frontendManifest, frontendBytes, lock, lockBytes, pinField) {
	const installed = await packageManifest(name);
	const packageDirectory = path.dirname(installed.absolute);
	const lockKey = portable(path.relative(root, packageDirectory));
	const locked = lock.packages?.[lockKey];
	if (!locked || locked.version !== installed.manifest.version) {
		throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_NOT_LOCKED: ${name}`);
	}
	if (pinField) {
		const pin = pinField.split('.').reduce((value, key) => value?.[key], frontendManifest);
		if (pin !== installed.manifest.version) {
			throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_NOT_EXACTLY_PINNED: ${name}`);
		}
	}
	return {
		kind: 'npm',
		role,
		name,
		version: installed.manifest.version,
		packagePath: portable(path.relative(root, installed.absolute)),
		packageSha256: sha256(installed.bytes),
		pinPath: pinField ? 'apps/frontend/package.json' : null,
		pinField,
		pinSha256: pinField ? sha256(frontendBytes) : null,
		lockPath: 'package-lock.json',
		lockKey,
		lockSha256: sha256(lockBytes)
	};
}

async function compilerIdentities(rustWasmActive) {
	const frontendPath = path.join(appRoot, 'package.json');
	const frontendBytes = await readFile(frontendPath);
	const frontendManifest = JSON.parse(frontendBytes);
	const lockBytes = await readFile(path.join(root, 'package-lock.json'));
	const lock = JSON.parse(lockBytes);
	const vite = await packageManifest('vite');
	const dependencies = { ...vite.manifest.dependencies, ...vite.manifest.optionalDependencies };
	const bundlerName = dependencies.rolldown ? 'rolldown' : dependencies.rollup ? 'rollup' : 'vite';
	const compilers = [
		await npmCompilerIdentity('vite', 'vite', frontendManifest, frontendBytes, lock, lockBytes, 'devDependencies.vite'),
		await npmCompilerIdentity(bundlerName, 'bundler', frontendManifest, frontendBytes, lock, lockBytes, bundlerName === 'vite' ? 'devDependencies.vite' : null),
		await npmCompilerIdentity(
			'@sveltejs/vite-plugin-svelte',
			'svelte-plugin',
			frontendManifest,
			frontendBytes,
			lock,
			lockBytes,
			'devDependencies.@sveltejs/vite-plugin-svelte'
		),
		await npmCompilerIdentity('svelte', 'svelte', frontendManifest, frontendBytes, lock, lockBytes, 'dependencies.svelte')
	];
	if (rustWasmActive) {
		const pinPath = 'crates/document-core/Cargo.toml';
		const pinBytes = await readFile(path.join(root, pinPath));
		const pinMatch = pinBytes.toString('utf8').match(/^\s*wasm-bindgen\s*=\s*\{\s*version\s*=\s*"(=[^"]+)"[^}]*\}/m);
		if (!pinMatch) throw new Error('FRONTEND_BUILD_EVIDENCE_WASM_COMPILER_NOT_PINNED');
		const locked = await cargoCompilerLock(pinMatch[1].slice(1));
		compilers.push({
			kind: 'cargo-pin',
			role: 'rust-wasm',
			name: 'wasm-bindgen',
			version: pinMatch[1].slice(1),
			pin: pinMatch[1],
			pinPath,
			pinSha256: sha256(pinBytes),
			...locked
		});
	}
	return compilers;
}

function styleModule(id) {
	const query = queryOf(id);
	const extension = path.extname(id.split('?', 1)[0]).toLowerCase();
	return query.get('type') === 'style' || ['.css', '.pcss', '.scss', '.sass', '.less', '.styl', '.stylus'].includes(extension);
}

function generatedCoreWasm(sourcePath) {
	return typeof sourcePath === 'string' &&
		sourcePath.startsWith('apps/frontend/src/features/document-core/generated/') &&
		sourcePath.toLowerCase().endsWith('.wasm');
}

function iterableStrings(value) {
	if (!value || typeof value === 'string' || typeof value[Symbol.iterator] !== 'function') return [];
	return [...value].filter(item => typeof item === 'string');
}

async function cargoCompilerLock(version) {
	for (const lockPath of ['crates/document-core/Cargo.lock', 'apps/desktop-tauri/Cargo.lock', 'Cargo.lock']) {
		let bytes;
		try {
			bytes = await readFile(path.join(root, lockPath));
		} catch (error) {
			if (error.code === 'ENOENT') continue;
			throw error;
		}
		const found = bytes.toString('utf8').split(/^\[\[package\]\]\s*$/m).slice(1).some(block =>
			/^name = "wasm-bindgen"$/m.test(block) &&
			block.match(/^version = "([^"]+)"$/m)?.[1] === version &&
			/^source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"$/m.test(block) &&
			/^checksum = "[\da-f]{64}"$/m.test(block)
		);
		if (found) return { lockPath, lockSha256: sha256(bytes) };
	}
	throw new Error('FRONTEND_BUILD_EVIDENCE_WASM_COMPILER_LOCK_NOT_FOUND');
}

export function frontendBuildEvidencePlugin(enabled) {
	const snapshots = new Map();
	const currentInputs = new Map();
	return {
		name: 'frontend-build-evidence',
		enforce: 'pre',
		async transform(_code, id) {
			if (!enabled) return null;
			const candidate = pathFromId(id);
			if (!candidate) return null;
			const input = await inputFromAbsolute(candidate);
			if (!input) return null;
			const previous = snapshots.get(id);
			if (previous && (previous.path !== input.path || previous.sha256 !== input.sha256)) {
				throw new Error(`FRONTEND_BUILD_EVIDENCE_INPUT_CHANGED_DURING_BUILD: ${input.path}`);
			}
			snapshots.set(id, input);
			return null;
		},
		generateBundle: {
			order: 'post',
			async handler(_outputOptions, bundle) {
			if (!enabled) return;
			const pluginContext = this;
			async function inputFor(id) {
				if (currentInputs.has(id)) return currentInputs.get(id);
				const input = await inputFromAbsolute(pathFromId(id) ?? '');
				const snapshot = snapshots.get(id);
				if (snapshot && (!input || snapshot.path !== input.path || snapshot.sha256 !== input.sha256)) {
					throw new Error(`FRONTEND_BUILD_EVIDENCE_INPUT_CHANGED_DURING_BUILD: ${snapshot.path}`);
				}
				const result = snapshot ?? input;
				currentInputs.set(id, result);
				return result;
			}
			async function moduleRecord(id, rendered) {
				const info = pluginContext.getModuleInfo(id);
				const input = await inputFor(id);
				const queryAt = id.indexOf('?');
				const stableId = input
					? `${input.path}${queryAt < 0 ? '' : id.slice(queryAt)}`
					: id;
				return {
					id: stableId,
					sourcePath: input?.path ?? null,
					sourceSha256: input?.sha256 ?? null,
					codeSha256: typeof info?.code === 'string' ? sha256(Buffer.from(info.code)) : null,
					renderedLength: Number.isSafeInteger(rendered?.renderedLength) ? rendered.renderedLength : null,
					raw: queryOf(id).has('raw'),
					style: styleModule(id),
					wasm: Boolean(input?.path.toLowerCase().endsWith('.wasm')),
					virtual: !input && id.startsWith('\0')
				};
			}
			async function originalAssetSource(originalFileName) {
				if (typeof originalFileName !== 'string' || originalFileName.length === 0) return null;
				let candidate = originalFileName;
				if (candidate.startsWith('file://')) {
					try {
						candidate = fileURLToPath(candidate);
					} catch {
						return null;
					}
				} else if (!path.isAbsolute(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate)) {
					candidate = path.resolve(appRoot, candidate);
				}
				return inputFromAbsolute(candidate);
			}

			const ids = [...pluginContext.getModuleIds()];
			const infos = new Map(ids.map(id => [id, pluginContext.getModuleInfo(id)]));
			const graphRecords = new Map();
			for (const id of ids) {
				if (infos.get(id)?.isExternal) continue;
				graphRecords.set(id, await moduleRecord(id, null));
			}
			const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
			const cssOwners = new Map();
			for (const chunk of chunks) {
				for (const fileName of iterableStrings(chunk.viteMetadata?.importedCss)) {
					const owners = cssOwners.get(fileName) ?? [];
					owners.push(chunk);
					cssOwners.set(fileName, owners);
				}
			}
			function reachesChunk(id, roots) {
				const pending = [id];
				const seen = new Set();
				while (pending.length > 0) {
					const current = pending.pop();
					if (roots.has(current)) return true;
					if (seen.has(current)) continue;
					seen.add(current);
					const info = infos.get(current);
					for (const importer of [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])]) pending.push(importer);
				}
				return false;
			}

			const outputs = [];
			for (const [fileName, output] of Object.entries(bundle)) {
				const kind = output.type === 'chunk'
					? 'chunk'
					: fileName.toLowerCase().endsWith('.css')
						? 'css'
						: 'asset';
				let modules = [];
				if (output.type === 'chunk') {
					modules = await Promise.all(Object.entries(output.modules).map(([id, rendered]) => moduleRecord(id, rendered)));
				} else if (kind === 'css') {
					const owners = cssOwners.get(fileName) ?? [];
					const roots = new Set(owners.flatMap(chunk => Object.keys(chunk.modules)));
					if (roots.size > 0) {
						for (const [id, info] of infos) {
							if (info && !info.isExternal && styleModule(id) && reachesChunk(id, roots)) {
								modules.push(graphRecords.get(id) ?? await moduleRecord(id, null));
							}
						}
					}
				}
				modules.sort((a, b) => a.id.localeCompare(b.id));
				const sourceFile = output.type === 'asset'
					? await originalAssetSource(output.originalFileName)
					: null;
				const bytes = output.type === 'chunk' ? Buffer.from(output.code) : Buffer.from(output.source);
				outputs.push({
					path: fileName,
					kind,
					sha256: sha256(bytes),
					modules,
					...(sourceFile ? { sourceFile: { path: sourceFile.path, sha256: sourceFile.sha256 } } : {})
				});
			}
			outputs.sort((a, b) => a.path.localeCompare(b.path));
			const rustWasmActive = outputs.some(output =>
				output.modules.some(module => generatedCoreWasm(module.sourcePath)) ||
				generatedCoreWasm(output.sourceFile?.path)
			);
			const compilers = await compilerIdentities(rustWasmActive);
			const evidence = { schemaVersion: 1, compilers, outputs };
			pluginContext.emitFile({
				type: 'asset',
				fileName: evidenceFileName,
				source: `${JSON.stringify(evidence, null, 2)}\n`
			});
			}
		}
	};
}
