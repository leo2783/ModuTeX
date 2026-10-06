import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

assert.equal(process.versions.node, '24.19.0');
const appRoot = fileURLToPath(new URL('../..', import.meta.url));
process.chdir(appRoot);

let server;
let browser;
let context;
let page;
let failure;
const cleanupFailures = [];
const pageErrors = [];
const blockedExternal = [];
const startupMs = 180_000;
const navigationMs = 30_000;
const actionMs = 8_000;
const cleanupMs = 8_000;

async function withDeadline(promise, timeoutMs, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function closeOwned(fn, label) {
	try {
		await withDeadline(fn(), cleanupMs, `${label} cleanup`);
	} catch (error) {
		cleanupFailures.push(error);
	}
}

try {
	server = await createServer({ root: appRoot, server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
	await withDeadline(server.listen(), startupMs, 'Vite startup/transform');
	const address = server.httpServer.address();
	assert.ok(address && typeof address !== 'string');
	const origin = `http://127.0.0.1:${address.port}`;
	browser = await chromium.launch({ headless: true, channel: 'chrome' });
	context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
	await context.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
		blockedExternal.push(`${url.protocol}//${url.host}`);
		await route.abort();
	});
	page = await context.newPage();
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.setDefaultTimeout(actionMs);
	await page.goto(`${origin}/tests/live/virtual-keyboard-matrix.html`, { waitUntil: 'load', timeout: navigationMs });
	await page.waitForFunction(() => !!window.__virtualKeyboardMatrix, null, { timeout: startupMs });
	await page.waitForFunction(() => !!window.__virtualKeyboardMatrix.snapshot().field?.connected, null, { timeout: actionMs });

	const initial = await page.evaluate(() => window.__virtualKeyboardMatrix.snapshot());
	assert.equal(initial.nodes.length, 1);
	assert.equal(initial.nodes[0].latex, 'x');
	assert.equal(await page.locator('[data-matrix-insert]').count(), 0, 'MathSymbolPanel remains closed/unmounted');

	const unrequested = await page.evaluate(() => window.__virtualKeyboardMatrix.requestWithoutRequester());
	assert.equal(unrequested.unchanged, true, 'the no-requester consumer must not silently insert a matrix');
	assert.equal(unrequested.state.nodes[0].latex, 'x');

	const gatedEditor = await page.evaluate(() => window.__virtualKeyboardMatrix.mountGatedEditor());
	assert.equal(gatedEditor.field?.connected, true);
	assert.equal(await page.locator('[data-matrix-insert]').count(), 0, 'the app matrix palette remains closed/unmounted');
	const readonly = await page.evaluate(() => window.__virtualKeyboardMatrix.requestReadonlyMatrix());
	assert.equal(readonly.commandAccepted, true, 'MathLive dispatchEvent runs even when content editing is readonly');
	assert.equal(readonly.unchanged, true, 'readonly matrix dispatch must not prompt, patch source, save, or edit PM');
	assert.equal(readonly.state.prompt, null);
	assert.equal(readonly.state.source, initial.source);
	assert.equal(readonly.state.scheduledSaves.length, 0);
	assert.equal(readonly.state.nodes[0].latex, 'x');
	assert.equal(readonly.state.field?.readOnly, false, 'the field is returned to editable mode for the next scenario');

	const waiting = await page.evaluate(() => window.__virtualKeyboardMatrix.startGatedRequest());
	assert.equal(waiting.activePresetCommand, true, 'MathLive executed its installed dispatchEvent command');
	assert.equal(waiting.docMetaIsNull, true, 'test is using an unparsed source-first DocumentBuffer');
	assert.equal(waiting.prompt?.packageName, 'amsmath');
	assert.equal(waiting.prompt?.canAdd, true);
	assert.equal(waiting.source, initial.source, 'the source is not patched before the explicit choice');
	await page.evaluate(() => window.__virtualKeyboardMatrix.setReadonly(true));
	await page.evaluate(() => window.__virtualKeyboardMatrix.resolveAddChoice());
	const invalidated = await page.evaluate(() => window.__virtualKeyboardMatrix.settleGate());
	assert.equal(invalidated.source, initial.source, 'a pending package choice is discarded if the target becomes readonly');
	assert.equal(invalidated.scheduledSaves.length, 0, 'the stale readonly choice does not schedule a save');
	assert.equal(invalidated.nodes[0].latex, 'x', 'the stale readonly choice does not insert into PM');
	assert.equal(invalidated.prompt, null);
	assert.equal(invalidated.field?.readOnly, true);

	await page.evaluate(() => window.__virtualKeyboardMatrix.setReadonly(false));
	const retry = await page.evaluate(() => window.__virtualKeyboardMatrix.startGatedRequest());
	assert.equal(retry.prompt?.packageName, 'amsmath', 'a new editable request can retry after readonly invalidation');
	assert.equal(retry.source, initial.source);
	await page.evaluate(() => window.__virtualKeyboardMatrix.resolveAddChoice());
	await page.evaluate(() => window.__virtualKeyboardMatrix.settleGate());
	await page.waitForFunction(
		() => {
			const state = window.__virtualKeyboardMatrix.snapshot();
			return state.nodes[0]?.latex.includes('\\begin{pmatrix}') && state.nodes[0]?.ownedPromptIds.length === 4;
		},
		null,
		{ timeout: actionMs }
	);

	const inserted = await page.evaluate(() => window.__virtualKeyboardMatrix.snapshot());
	assert.equal(inserted.nodes[0].type, 'inline_math');
	assert.equal(inserted.nodes[0].ownedPromptIds.length, 4, 'the actual MathLive placeholders retain app-owned provenance');
	assert.equal(inserted.field?.latex, inserted.nodes[0].latex, 'MathLive and ProseMirror contain the same inserted matrix');
	assert.equal(inserted.field?.maxMatrixCols, 10, 'temporary matrix width configuration is restored');
	assert.equal(inserted.docMetaIsNull, true, 'source-first insertion did not parse or reserialize the document');
	assert.ok(inserted.source.includes('% keep this source-first preamble\r\n\\usepackage{amsmath}\r\n\\begin{document}\r\n'));
	assert.ok(inserted.source.includes('Body bytes stay untouched.\r\n\\end{document}\r\n'));
	assert.equal(inserted.scheduledSaves.length, 1, 'the one authoritative package splice is scheduled once');
	assert.equal(inserted.field?.focused, true, 'the exact original MathLive field remains editable');
	assert.deepEqual(pageErrors, [], 'no uncaught browser exceptions');
	assert.deepEqual(blockedExternal, [], 'the proof uses no external resources');
	console.log(
		`PASS Chrome ${browser.version()}: installed MathLive dispatchEvent → always-live exact-field listener, closed palette, real source-first package gate and PM insertion`
	);
	await page.evaluate(() => window.__virtualKeyboardMatrix.dispose());
} catch (error) {
	failure = error;
	if (page && !page.isClosed()) {
		try {
			console.error('Actual virtual-keyboard matrix failure state', await page.evaluate(() => window.__virtualKeyboardMatrix?.snapshot()));
		} catch (diagnosticError) {
			console.error('Diagnostic unavailable', diagnosticError.message);
		}
	}
} finally {
	if (context) await closeOwned(() => context.close(), 'context');
	if (browser) await closeOwned(() => browser.close(), 'browser');
	if (server) await closeOwned(() => server.close(), 'Vite');
}

const errors = [...(failure ? [failure] : []), ...cleanupFailures];
if (errors.length) {
	console.error(errors.length === 1 ? errors[0] : new AggregateError(errors, 'Virtual-keyboard browser proof/cleanup failed'));
	console.error({ pageErrors, blockedExternal });
	process.exitCode = 1;
} else {
	console.log('PASS scoped actual MathLive virtual-keyboard proof; owned context/browser/Vite closed');
}
