// Bundles main.js, preload.js and the dedicated diagram-cpu-worker.js artifact. Preload and
// worker stay separate: Electron/worker_threads load them by path. tsc checks types.
//
// Used by BOTH `electron:build` (dev, --dev) and `electron:build:prod`. That matters: dev used to
// run plain `tsc -p electron`, which emits per-file CJS and leaves every dependency as a runtime
// require(). An ESM-only package therefore packaged fine and killed the app on launch in dev only
// (ERR_REQUIRE_ESM) - a whole class of failure that existed purely because the two paths disagreed
// about module resolution. Same bundler for both, same behaviour.
//
// --dev keeps the output readable and mapped, so a main-process stack trace points at real source.
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

const dev = process.argv.includes('--dev');
const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'electron', 'dist');

// stale output (including per-file tsc emits from an older checkout) must not linger next to the bundle
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

buildSync({
	entryPoints: [
		join(ROOT, 'electron', 'src', 'main.ts'),
		join(ROOT, 'electron', 'src', 'preload.ts'),
		join(ROOT, 'electron', 'src', 'diagram-cpu-worker.ts')
	],
	outdir: DIST,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	// the Node major inside the Electron we ship, not a year-based guess:
	// nothing here ever runs anywhere else, so every syntax lowering esbuild would do for an older
	// runtime is dead weight
	target: 'node24',
	minify: !dev,
	// keep third-party @license/@preserve comments; ordinary comments are stripped
	legalComments: 'inline',
	// inline rather than a .map file: electron-builder's `files` excludes **/*.map, and a dev build
	// is never packaged anyway, so there is nothing to keep them out of
	sourcemap: dev ? 'inline' : false,
	// node-pty is native, dlopen'd from asar.unpacked at runtime; simple-git is pure JS and bundles in
	external: ['electron', 'node-pty']
});
buildSync({
	stdin: {
		contents: 'import {startDrawioRelay} from "./electron/src/drawio-message-relay.ts"; startDrawioRelay("__MODUTEX_HOST_ORIGINS__");',
		resolveDir: ROOT,
		loader: 'ts'
	},
	outfile: join(DIST, 'drawio-relay.js'),
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'chrome130',
	minify: false
});
console.log(
	`build-electron: bundled ${dev ? 'main, preload and diagram worker (dev: unminified, inline sourcemaps)' : '+ minified main, preload and diagram worker'}`
);
