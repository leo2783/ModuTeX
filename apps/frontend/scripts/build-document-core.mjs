// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(frontendRoot, '..', '..');
const targetDirectory = path.join(repositoryRoot, 'apps', 'desktop-tauri', 'target');
const outputDirectory = path.join(frontendRoot, 'src', 'features', 'document-core', 'generated');
const wasmInput = path.join(
	targetDirectory,
	'wasm32-unknown-unknown',
	'release',
	'modutex_document_core.wasm'
);
const wasmBindgen = process.env.MODUTEX_WASM_BINDGEN?.trim() || 'wasm-bindgen';
const environment = { ...process.env, CARGO_TARGET_DIR: targetDirectory };

function run(command, args, capture = false) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		env: environment,
		encoding: 'utf8',
		windowsHide: true,
		stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		maxBuffer: capture ? 8 * 1024 * 1024 : undefined
	});
	if (result.error) throw result.error;
	if (result.signal) {
		process.exitCode = 1;
		const output = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
		throw new Error(`${command} terminated by ${result.signal}${output ? `\n${output}` : ''}`);
	}
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
		const output = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
		throw new Error(`${command} exited with status ${result.status}${output ? `\n${output}` : ''}`);
	}
	return capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
}

try {
	const version = run(wasmBindgen, ['--version'], true);
	if (version !== 'wasm-bindgen 0.2.126') {
		throw new Error(`Expected wasm-bindgen 0.2.126; found ${version || 'no version output'}`);
	}

	await mkdir(outputDirectory, { recursive: true });
	run('cargo', [
		'build',
		'--locked',
		'--release',
		'--manifest-path',
		path.join(repositoryRoot, 'crates', 'document-core', 'Cargo.toml'),
		'--target',
		'wasm32-unknown-unknown',
		'--features',
		'wasm'
	]);
	run(process.execPath, [path.join(repositoryRoot, 'scripts', 'licensing', 'rust-notices.mjs')], true);
	run(wasmBindgen, [
		'--target',
		'web',
		'--typescript',
		'--out-dir',
		outputDirectory,
		wasmInput
	]);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode ??= 1;
}
