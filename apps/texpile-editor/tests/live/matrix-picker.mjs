import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const viteCli = path.resolve(appRoot, '../../node_modules/vite/bin/vite.js');
const htmlPath = '/tests/live/matrix-picker.html';
const startupTimeoutMs = 30_000;
const browserActionTimeoutMs = 8_000;
const childShutdownTimeoutMs = 3_000;

async function unusedLoopbackPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Could not allocate a local Vite port');
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

function monitorChild(child) {
	let resolveExit;
	const exited = new Promise((resolve) => {
		resolveExit = resolve;
	});
	let resolveSpawn;
	const spawned = new Promise((resolve) => {
		resolveSpawn = resolve;
	});
	let resolveFailure;
	const failure = new Promise((resolve) => {
		resolveFailure = resolve;
	});
	const errors = [];
	let didSpawn = false;
	let spawnError;
	let exitInfo;
	let failureInfo;

	child.once('spawn', () => {
		didSpawn = true;
		resolveSpawn();
	});
	child.on('error', (error) => {
		errors.push(error);
		if (!didSpawn && spawnError === undefined) spawnError = error;
		if (failureInfo === undefined) {
			failureInfo = { kind: 'error', error };
			resolveFailure(failureInfo);
		}
	});
	child.once('exit', (code, signal) => {
		exitInfo = { code, signal };
		resolveExit(exitInfo);
		if (failureInfo === undefined) {
			failureInfo = { kind: 'exit', info: exitInfo };
			resolveFailure(failureInfo);
		}
	});

	return {
		child,
		errors,
		spawned,
		exited,
		failure,
		get didSpawn() {
			return didSpawn;
		},
		get spawnError() {
			return spawnError;
		},
		get exitInfo() {
			return exitInfo;
		},
		get failureInfo() {
			return failureInfo;
		}
	};
}

function formatError(error) {
	const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
	if (!(error instanceof AggregateError)) return details;
	return `${details}\n${[...error.errors].map(formatError).join('\n')}`;
}

function viteFailure(info, getLog) {
	if (info.kind === 'error') return new Error(`Vite child process error.\n${getLog()}`, { cause: info.error });
	const { code, signal } = info.info;
	return new Error(`Vite exited before the live checks completed (code ${code}, signal ${signal}).\n${getLog()}`);
}

async function waitForVite(monitor, url, getLog) {
	const deadline = Date.now() + startupTimeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		if (monitor.failureInfo) throw viteFailure(monitor.failureInfo, getLog);
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		try {
			const request = fetch(url, { signal: AbortSignal.timeout(Math.min(1000, remainingMs)) }).then(async (response) => ({
				kind: 'response',
				response,
				body: await response.text()
			}));
			const result = await Promise.race([request, monitor.failure]);
			if (result.kind !== 'response') throw viteFailure(result, getLog);
			if (result.response.ok && result.body.includes('matrix-picker-entry.svelte.ts')) {
				if (monitor.failureInfo) throw viteFailure(monitor.failureInfo, getLog);
				return;
			}
			lastError = new Error(`Vite returned HTTP ${result.response.status}`);
		} catch (error) {
			if (monitor.failureInfo) throw viteFailure(monitor.failureInfo, getLog);
			lastError = error;
		}
		const retryDelayMs = Math.min(100, Math.max(0, deadline - Date.now()));
		if (retryDelayMs > 0) {
			const result = await Promise.race([
				new Promise((resolve) => setTimeout(() => resolve({ kind: 'retry' }), retryDelayMs)),
				monitor.failure
			]);
			if (result.kind !== 'retry') throw viteFailure(result, getLog);
		}
	}
	throw new Error(`Timed out starting local Vite: ${String(lastError)}\n${getLog()}`);
}

async function waitForChildExit(monitor, timeoutMs) {
	if (monitor.exitInfo) return monitor.exitInfo;
	if (timeoutMs <= 0) return undefined;
	let timeoutId;
	const result = await Promise.race([
		monitor.exited.then((info) => ({ kind: 'exit', info })),
		new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
		})
	]);
	if (timeoutId !== undefined) clearTimeout(timeoutId);
	return result.kind === 'exit' ? result.info : undefined;
}

async function waitForSpawnState(monitor, timeoutMs) {
	let timeoutId;
	const result = await Promise.race([
		monitor.spawned.then(() => ({ kind: 'spawn' })),
		monitor.failure,
		new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
		})
	]);
	if (timeoutId !== undefined) clearTimeout(timeoutId);
	return result;
}

async function stopViteChild(monitor) {
	if (monitor.exitInfo || monitor.spawnError) return;
	if (!monitor.didSpawn) {
		const state = await waitForSpawnState(monitor, childShutdownTimeoutMs);
		if (state.kind === 'error' || state.kind === 'exit') return;
		if (state.kind !== 'spawn') throw new Error('Could not confirm whether the owned Vite child spawned before cleanup timeout');
	}
	if (await waitForChildExit(monitor, 0)) return;

	const cleanupErrors = [];
	try {
		const signaled = monitor.child.kill('SIGTERM');
		if (!signaled && !(await waitForChildExit(monitor, 100))) {
			cleanupErrors.push(new Error('Could not signal the owned Vite child with SIGTERM'));
		}
	} catch (error) {
		cleanupErrors.push(new Error('Failed to send SIGTERM to the owned Vite child', { cause: error }));
	}
	if (!(await waitForChildExit(monitor, childShutdownTimeoutMs))) {
		try {
			const signaled = monitor.child.kill('SIGKILL');
			if (!signaled && !(await waitForChildExit(monitor, 100))) {
				cleanupErrors.push(new Error('Could not signal the owned Vite child with SIGKILL'));
			}
		} catch (error) {
			cleanupErrors.push(new Error('Failed to send SIGKILL to the owned Vite child', { cause: error }));
		}
		if (!(await waitForChildExit(monitor, childShutdownTimeoutMs))) {
			cleanupErrors.push(new Error(`The owned Vite child did not emit exit within ${childShutdownTimeoutMs}ms after SIGKILL`));
		}
	}
	if (cleanupErrors.length === 1) throw cleanupErrors[0];
	if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Vite child shutdown failed');
}

async function closeOwnedResource(resource, label, cleanupErrors) {
	if (!resource) return;
	try {
		await resource.close();
	} catch (error) {
		cleanupErrors.push(new Error(`Failed to close owned ${label}`, { cause: error }));
	}
}

async function waitForPanel(page) {
	await page.locator('.card').waitFor({ state: 'visible', timeout: browserActionTimeoutMs });
}

async function clickInsert(page, rows, columns) {
	await page.getByLabel('Matrix rows').fill(String(rows));
	await page.getByLabel('Matrix columns').fill(String(columns));
	await page.getByRole('button', { name: `Insert ${rows} by ${columns} matrix` }).click({ timeout: browserActionTimeoutMs });
}

async function snapshot(page) {
	return page.evaluate(() => window.__matrixPicker.getSnapshot());
}

async function setupPanel(page) {
	await page.evaluate(() => window.__matrixPicker.reset());
	await page.locator('#intended-mathfield').click();
	try {
		await page.waitForFunction(() => window.__matrixPicker.getFocusDebug().liveFieldId === 'intended-mathfield', null, {
			timeout: browserActionTimeoutMs
		});
	} catch {
		throw new Error(
			`Actual opening-field focusin did not become ready: ${JSON.stringify(await page.evaluate(() => window.__matrixPicker.getFocusDebug()))}`
		);
	}
	const focusDebug = await page.evaluate(() => window.__matrixPicker.getFocusDebug());
	assert.equal(
		focusDebug.liveFieldId,
		'intended-mathfield',
		`a real browser click must establish the opening field before panel mount: ${JSON.stringify(focusDebug)}`
	);
	await page.evaluate(() => window.__matrixPicker.openPanel());
	await waitForPanel(page);
	const opening = await snapshot(page);
	assert.equal(opening.openingFieldId, 'intended-mathfield', 'the mounted panel captures the exact real focused opening field');
}

async function waitUntilPanelClosed(page) {
	try {
		await page.locator('.card').waitFor({ state: 'detached', timeout: browserActionTimeoutMs });
	} catch (error) {
		console.error(
			'Live picker remained open:',
			await page.evaluate(() => {
				const field = document.querySelector('#intended-mathfield');
				const activeChain = [];
				let active = document.activeElement;
				while (active) {
					activeChain.push({ tag: active.tagName, id: active.id, label: active.getAttribute('aria-label') });
					active = active.shadowRoot?.activeElement ?? null;
				}
				return {
					state: window.__matrixPicker.getSnapshot(),
					activeChain,
					fieldHasFocus: field?.hasFocus?.(),
					inputs: [...document.querySelectorAll('.card input')].map((input) => ({
						label: input.getAttribute('aria-label'),
						value: input.value,
						invalid: input.getAttribute('aria-invalid')
					})),
					insertButtons: [...document.querySelectorAll('.card button:not([data-matrix-cell])')].map((button) => ({
						label: button.getAttribute('aria-label'),
						disabled: button.disabled
					}))
				};
			})
		);
		throw error;
	}
}

async function runBrowserChecks(page, browserVersion, pageErrors) {
	const environments = ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix'];
	const dimensions = [
		[1, 1],
		[10, 10],
		[20, 20]
	];

	for (let environmentIndex = 0; environmentIndex < environments.length; environmentIndex += 1) {
		for (const [rows, columns] of dimensions) {
			await setupPanel(page);
			const bracketButtons = page.locator('.card [aria-pressed]');
			assert.equal(await bracketButtons.count(), 6, 'the live panel exposes all six matrix bracket modes');
			await bracketButtons.nth(environmentIndex).click();
			await clickInsert(page, rows, columns);
			await waitUntilPanelClosed(page);

			const state = await snapshot(page);
			const latex = state.intended.latex;
			assert.equal(state.closeCount, 1, `${environments[environmentIndex]} ${rows}x${columns} closes exactly once`);
			assert.match(
				latex,
				new RegExp(`\\\\begin\\{${environments[environmentIndex]}\\}`),
				'the production MathLive value contains the selected environment'
			);
			assert.equal(state.intended.connected, true, 'the intended field remains mounted');
			assert.equal(state.intended.hasFocus, true, 'the actual MathLive field keeps focus after insertion');
			assert.equal(state.intended.maxMatrixCols, 8, 'the exact original matrix-column limit is restored after success');
			assert.ok(state.maxColsAtBeforeInput.length > 0, 'the actual MathLive command dispatched beforeinput');
			assert.ok(
				state.maxColsAtBeforeInput.every((limit) => limit >= columns),
				'the actual command observed sufficient maxMatrixCols'
			);

			const placeholders = latex.match(/\\placeholder\{[^}]*\}/g) ?? [];
			assert.equal(
				placeholders.length,
				rows * columns,
				`${rows}x${columns} creates exactly ${rows * columns} actual MathLive placeholders`
			);
			const rowSeparators = latex.match(/\\\\/g) ?? [];
			assert.equal(rowSeparators.length, rows - 1, `${rows}x${columns} creates exactly ${rows - 1} actual MathLive row separators`);
			const columnSeparators = latex.match(/&/g) ?? [];
			assert.equal(columnSeparators.length, rows * (columns - 1), `${rows}x${columns} has the expected number of real column separators`);

			if (rows === 20 && columns === 20) {
				const initialSelection = state.intended.selection.ranges[0];
				assert.ok(initialSelection, 'MathLive exposes the selected first-cell model range');
				assert.equal(state.intended.selectedLatex, '\\placeholder{}', 'the first cell is selected in the live MathLive model');
				await page.keyboard.press('Tab');
				const afterTab = await snapshot(page);
				const nextSelection = afterTab.intended.selection.ranges[0];
				assert.ok(nextSelection, 'Tab keeps a live MathLive model selection');
				assert.notDeepEqual(nextSelection, initialSelection, 'real Tab traversal advances to a different matrix cell');
				assert.equal(afterTab.intended.hasFocus, true, 'MathLive handles Tab without losing field focus');
				assert.equal(afterTab.intended.selectedLatex, '\\placeholder{}', 'Tab selects the next actual cell placeholder');
				console.log(
					`PASS ${browserVersion}: ${environments[environmentIndex]} 20x20 = 400 placeholders/19 rows; first selection ${JSON.stringify(initialSelection)} -> Tab ${JSON.stringify(nextSelection)}`
				);
			}
		}
	}
	console.log(
		`PASS ${browserVersion}: six bracket modes × 1x1, 10x10, 20x20 through the production MathSymbolPanel → insertSymbol → MathLive path`
	);

	await setupPanel(page);
	await page.evaluate(() => window.__matrixPicker.setIntendedMaxMatrixCols(32));
	await clickInsert(page, 20, 20);
	await waitUntilPanelClosed(page);
	let state = await snapshot(page);
	assert.equal(state.intended.maxMatrixCols, 32, 'an originally larger maxMatrixCols is never lowered');
	assert.ok(
		state.maxColsAtBeforeInput.every((limit) => limit >= 32),
		'the large original setting is retained throughout insertion'
	);

	await setupPanel(page);
	await page.getByLabel('Matrix rows').fill('0');
	assert.equal(await page.getByLabel('Matrix rows').getAttribute('aria-invalid'), 'true');
	assert.equal(await page.locator('.card button[aria-label^="Insert "]:not([data-matrix-cell])').isDisabled(), true);
	for (const invalid of ['21', '1.5', '']) {
		await page.getByLabel('Matrix rows').fill(invalid);
		await page.getByLabel('Matrix columns').fill('2');
		assert.equal(
			await page.getByLabel('Matrix rows').getAttribute('aria-invalid'),
			'true',
			`row value ${JSON.stringify(invalid)} is invalid`
		);
		assert.equal(await page.locator('.card button[aria-label^="Insert "]:not([data-matrix-cell])').isDisabled(), true);
	}
	for (const invalid of ['21', '1.5', '']) {
		await page.getByLabel('Matrix rows').fill('2');
		await page.getByLabel('Matrix columns').fill(invalid);
		assert.equal(
			await page.getByLabel('Matrix columns').getAttribute('aria-invalid'),
			'true',
			`column value ${JSON.stringify(invalid)} is invalid`
		);
		assert.equal(await page.locator('.card button[aria-label^="Insert "]:not([data-matrix-cell])').isDisabled(), true);
	}
	state = await snapshot(page);
	assert.equal(state.intended.latex, 'x', 'invalid, fractional, empty and out-of-range sizes do not mutate the real field');
	assert.equal(state.closeCount, 0, 'invalid sizes do not close the live panel');
	await page.evaluate(() => window.__matrixPicker.unmountPanel());
	console.log(`PASS ${browserVersion}: invalid 0, 21, fractional and empty dimensions produce no mutation or close`);

	await setupPanel(page);
	await page.getByLabel('Matrix rows').click();
	await page.getByLabel('Matrix rows').fill('2');
	await page.getByLabel('Matrix columns').click();
	await page.getByLabel('Matrix columns').fill('3');
	await page.getByRole('button', { name: 'Insert 2 by 3 matrix' }).dblclick({ delay: 20, timeout: browserActionTimeoutMs });
	await page.locator('.card').waitFor({ state: 'detached', timeout: browserActionTimeoutMs });
	state = await snapshot(page);
	assert.equal((state.intended.latex.match(/\\begin\{pmatrix\}/g) ?? []).length, 1, 'a real double click creates only one matrix');
	assert.equal(state.closeCount, 1, 'a real double click closes only once');
	console.log(`PASS ${browserVersion}: repeat click creates exactly one insertion`);

	await setupPanel(page);
	await page.getByLabel('Matrix rows').click();
	await page.getByLabel('Matrix rows').fill('1');
	await page.getByLabel('Matrix columns').fill('2');
	await page.getByRole('button', { name: 'Insert 1 by 2 matrix' }).click();
	await waitUntilPanelClosed(page);
	state = await snapshot(page);
	assert.match(
		state.intended.latex,
		/\\begin\{pmatrix\}/,
		'pointerdown on matrix inputs does not retarget insertion away from the field that opened the panel'
	);
	assert.equal(state.other.latex, 'y', 'pointerdown on matrix inputs never inserts into the other live field');
	console.log(`PASS ${browserVersion}: matrix input pointerdown retains exact opening MathLive field identity`);

	await setupPanel(page);
	await page.evaluate(() => window.__matrixPicker.setIntendedDisabled(true));
	await page.getByLabel('Matrix rows').fill('1');
	await page.getByLabel('Matrix columns').fill('1');
	await page.getByRole('button', { name: 'Insert 1 by 1 matrix' }).click();
	await page.waitForTimeout(1200);
	state = await snapshot(page);
	assert.equal(state.intended.latex, 'x', 'missing focus readiness never inserts late');
	assert.equal(state.other.latex, 'y', 'missing focus readiness never inserts into another live field');
	assert.equal(state.closeCount, 0, 'missing focus readiness does not call onClose');
	assert.equal(state.panelOpen, true, 'the not-ready panel remains available for recovery');
	await page.evaluate(() => window.__matrixPicker.unmountPanel());
	console.log(`PASS ${browserVersion}: bounded no-readiness wait times out without insertion or close`);

	await setupPanel(page);
	await page.evaluate(() => window.__matrixPicker.setIntendedDisabled(true));
	await page.getByRole('button', { name: 'Insert 2 by 2 matrix' }).click();
	await page.locator('[data-matrix-picker-host] .card > div:first-child > button').focus();
	await page.keyboard.press('Shift+Tab');
	await page.waitForTimeout(50);
	state = await snapshot(page);
	assert.ok(
		state.focusEvents.some((event) => event.liveFieldId === 'other-mathfield'),
		'real Shift+Tab focusin reaches the other connected MathLive field'
	);
	assert.equal(state.intended.latex, 'x', 'a wrong-target focusin cancels the pending insertion');
	assert.equal(state.other.latex, 'y', 'wrong-target focusin never retargets insertion');
	assert.equal(state.closeCount, 0, 'wrong-target cancellation does not call onClose');
	await page.waitForTimeout(1100);
	state = await snapshot(page);
	assert.equal(state.intended.latex, 'x', 'wrong-target cancellation prevents timeout-delayed mutation');
	await page.evaluate(() => window.__matrixPicker.unmountPanel());
	console.log(`PASS ${browserVersion}: real focusin on the wrong MathLive field cancels without retargeting or late mutation`);

	await setupPanel(page);
	await page.evaluate(() => window.__matrixPicker.setIntendedDisabled(true));
	await page.getByRole('button', { name: 'Insert 2 by 2 matrix' }).click();
	await page.evaluate(() => window.__matrixPicker.removeIntended());
	await page.waitForTimeout(50);
	state = await snapshot(page);
	assert.equal(state.intended.connected, false);
	assert.equal(state.intended.latex, 'x', 'removing the opening field cancels pending work');
	assert.equal(state.closeCount, 0, 'removing the opening field does not close the panel as an insertion');
	await page.waitForTimeout(1100);
	state = await snapshot(page);
	assert.equal(state.intended.latex, 'x', 'removing the opening field prevents late mutation');
	await page.evaluate(() => {
		window.__matrixPicker.restoreIntended();
		window.__matrixPicker.unmountPanel();
	});
	console.log(`PASS ${browserVersion}: removing the intended MathLive field cancels pending focus and prevents late mutation`);

	await setupPanel(page);
	await page.evaluate(() => window.__matrixPicker.setIntendedDisabled(true));
	await page.getByRole('button', { name: 'Insert 2 by 2 matrix' }).click();
	await page.evaluate(() => window.__matrixPicker.unmountPanel());
	await page.waitForTimeout(1100);
	state = await snapshot(page);
	assert.equal(state.intended.latex, 'x', 'unmount cancels and cleans up a pending insertion');
	assert.equal(state.closeCount, 0, 'manual unmount is not reported as successful insertion');
	assert.equal(state.panelOpen, false);
	console.log(`PASS ${browserVersion}: panel unmount cancels pending focus with no late mutation`);

	await setupPanel(page);
	await page.evaluate(() => window.__matrixPicker.setIntendedDisabled(true));
	await page.getByRole('button', { name: 'Insert 2 by 2 matrix' }).click();
	await page.locator('[data-matrix-picker-host] .card > div:first-child > button').click();
	await page.waitForTimeout(1100);
	state = await snapshot(page);
	assert.equal(state.intended.latex, 'x', 'closing the picker cancels and prevents a late insertion');
	assert.equal(state.other.latex, 'y', 'closing never redirects the insertion');
	assert.equal(state.closeCount, 1, 'the explicit user cancel closes exactly once');
	console.log(`PASS ${browserVersion}: explicit close cancels pending focus and prevents late mutation`);

	await setupPanel(page);
	await page.evaluate(() => {
		window.__matrixPicker.installThrowingExecuteCommand();
	});
	await clickInsert(page, 20, 20);
	await waitUntilPanelClosed(page);
	state = await snapshot(page);
	const throwObservation = await page.evaluate(() => window.__matrixPicker.getThrowObservation());
	assert.equal(throwObservation.calls, 1, 'the actual production command boundary was reached in the throw-only case');
	assert.deepEqual(throwObservation.maxCols, [20], 'the matrix width was temporarily raised before the throwing command');
	assert.equal(state.intended.maxMatrixCols, 8, 'finally restores exact original maxMatrixCols after command throw');
	assert.equal(state.intended.latex, 'x', 'the intentional throw did not insert a matrix');
	assert.equal(state.closeCount, 1, 'known insertSymbol void/catch behavior still closes after a ready-command failure');
	await page.evaluate(() => window.__matrixPicker.restoreExecuteCommand());
	console.log(
		`KNOWN NEGATIVE ${browserVersion}: forced MathLive executeCommand throw restored maxMatrixCols=8; no insertion occurred; existing insertSymbol void/catch contract still invoked onClose once (not success evidence)`
	);

	assert.deepEqual(pageErrors, [], 'real browser page produced no uncaught errors');
}

let viteChild;
let childMonitor;
let browser;
let context;
let viteOutput = '';
let browserVersion;
let runFailure;
const cleanupFailures = [];
const appendOutput = (chunk) => {
	viteOutput = `${viteOutput}${chunk.toString()}`.slice(-20_000);
};

try {
	const port = await unusedLoopbackPort();
	const baseUrl = `http://127.0.0.1:${port}`;
	viteChild = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
		cwd: appRoot,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: false
	});
	childMonitor = monitorChild(viteChild);
	viteChild.stdout.on('data', appendOutput);
	viteChild.stderr.on('data', appendOutput);
	await waitForVite(childMonitor, `${baseUrl}${htmlPath}`, () => viteOutput);

	// The installed Chrome channel is explicitly selected. Missing Chrome is a hard failure; this
	// harness never downloads or installs a browser.
	browser = await chromium.launch({ headless: true, channel: 'chrome' });
	browserVersion = `Chrome ${browser.version()}`;
	console.log(`LIVE MATRIX PICKER browser evidence: ${browserVersion}; Vite ${baseUrl}${htmlPath}`);
	context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
	const page = await context.newPage();
	page.setDefaultTimeout(browserActionTimeoutMs);
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await page.goto(`${baseUrl}${htmlPath}`, { waitUntil: 'load', timeout: startupTimeoutMs });
	await page.waitForFunction(() => window.__matrixPickerReady === true, null, { timeout: startupTimeoutMs });
	await page.waitForFunction(
		() => {
			const field = document.querySelector('#intended-mathfield');
			return field instanceof window.MathfieldElement && !!field.shadowRoot;
		},
		null,
		{ timeout: startupTimeoutMs }
	);
	await runBrowserChecks(page, browserVersion, pageErrors);
	if (childMonitor.failureInfo) throw viteFailure(childMonitor.failureInfo, () => viteOutput);
} catch (error) {
	runFailure = error;
} finally {
	await closeOwnedResource(context, 'Playwright context', cleanupFailures);
	await closeOwnedResource(browser, 'Playwright browser', cleanupFailures);
	if (viteChild && childMonitor) {
		const reportedChildErrors = new Set();
		if (runFailure?.cause) reportedChildErrors.add(runFailure.cause);
		try {
			await stopViteChild(childMonitor);
		} catch (error) {
			cleanupFailures.push(error);
		}
		for (const error of childMonitor.errors) {
			if (!reportedChildErrors.has(error)) cleanupFailures.push(new Error('Vite child process emitted an error', { cause: error }));
		}
	}
}

const failures = [...(runFailure ? [runFailure] : []), ...cleanupFailures];
if (failures.length > 0) {
	const failure = failures.length === 1 ? failures[0] : new AggregateError(failures, 'Live matrix-picker run or cleanup failed');
	console.error(
		`FAIL live matrix-picker harness:\n${formatError(failure)}\nVite output (last 20000 chars):\n${viteOutput || '(no Vite output)'}`
	);
	process.exitCode = 1;
} else {
	console.log(`PASS ${browserVersion}: genuine local Chromium matrix-picker harness complete; owned browser and Vite child exited cleanly`);
}
