import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../apps/texpile-editor');
const route = '/__document-workbench.html';
const entryId = '\0document-workbench-live-entry';

const entrySource = `
import { mount, unmount } from 'svelte';
import '/src/app.css';
import '$lib/theme';
import WorkspaceMain from '$lib/editor/comp/WorkspaceMain.svelte';
import { PaneLayout } from '$lib/workspace/paneLayout.svelte';
import { loadSettings } from '$lib/settings';

await loadSettings();
const layout = new PaneLayout();
layout.restore({ sidebarOpen: false, pdfPaneOpen: false });
const noop = () => {};
const actions = new Proxy({}, { get: () => noop });
const comments = [];
const panes = {
  openTabs: ['/workbench/main.txt'],
  commandPending: false,
  sourceGotoLine: undefined,
  allReferences: [],
  sourceDiagnostics: [],
  applyingStarter: false,
  fileUrl: (file) => file,
  commentRanges: [],
  comments,
  commentFile: '/workbench/main.txt',
  commentSelected: null,
  cwd: '/workbench',
  commentsOrphaned: new Set(),
  commentsNotVisible: new Set(),
  commentFilesPresent: new Set(),
  commentPending: null
};
const props = {
  doc: {
    path: '/workbench/main.txt',
    loadError: null,
    texSource: '',
    rawContent: 'UNSAVED WORKBENCH BUFFER',
    visualDoc: null,
    docMeta: null
  },
  modes: { mode: 'source', sourceScrollAnchor: null },
  layout,
  diff: { original: '', modified: '', layout: 'unified', loading: false, error: null, hasHead: false, toggleLayout: noop },
  parser: { progress: null },
  termDock: { available: false, mounted: false, visible: false, height: 240, shrink: false },
  compiler: { compiling: false, pdfFilename: '', stopCompile: noop, runCompile: noop },
  saver: { saving: false },
  kind: 'text',
  folderEmpty: false,
  modLabel: 'Ctrl',
  dockShrunk: false,
  draft: { root: '/workbench', mainRel: 'main.txt', trigger: 0, paused: false },
  typstPreviewHost: null,
  typstPreviewWanted: false,
  panes,
  actions,
  dockView: 'terminal',
  pdfPaneRef: null,
  draftRef: null
};
const app = mount(WorkspaceMain, { target: document.querySelector('#app'), props });
window.__documentWorkbench = { layout, unmount: () => unmount(app) };
`;

function harnessPlugin() {
	return {
		name: 'document-workbench-live-harness',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.url?.split('?')[0] !== route) return next();
				try {
					const html = await server.transformIndexHtml(
						route,
						'<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>Workbench live check</title></head><body><div id="app" class="document-workbench-shell"></div><script type="module" src="/__document-workbench-entry.js"></script></body></html>'
					);
					res.statusCode = 200;
					res.setHeader('Content-Type', 'text/html; charset=utf-8');
					res.end(html);
				} catch (error) {
					next(error);
				}
			});
		},
		resolveId(id) {
			return id.endsWith('/__document-workbench-entry.js') ? entryId : null;
		},
		load(id) {
			return id === entryId ? entrySource : null;
		}
	};
}

let server;
let browser;
let coldContext;
let context;
let failure;
const previousCwd = process.cwd();
const navigationTimeoutMs = 10_000;
const coldReadinessTimeoutMs = 180_000;
const cleanupTimeoutMs = 10_000;

function isNavigationTimeout(error) {
	return error instanceof Error && error.name === 'TimeoutError' && error.message.startsWith('page.goto: Timeout');
}

async function closeBounded(resource, label) {
	let timer;
	try {
		await Promise.race([
			resource.close(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not close within ${cleanupTimeoutMs} ms`)), cleanupTimeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

try {
	const coldStartedAt = performance.now();
	process.chdir(appRoot);
	server = await createServer({
		configFile: path.join(appRoot, 'vite.config.ts'),
		root: appRoot,
		plugins: [harnessPlugin()],
		server: { host: '127.0.0.1', port: 0, strictPort: false }
	});
	await server.listen();
	const address = server.httpServer.address();
	assert.ok(address && typeof address !== 'string', 'Vite should bind an ephemeral loopback port');
	const baseUrl = `http://127.0.0.1:${address.port}`;
	browser = await chromium.launch({ headless: true, channel: 'chrome' });
	coldContext = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
	const coldPage = await coldContext.newPage();
	coldPage.setDefaultTimeout(navigationTimeoutMs);
	coldPage.setDefaultNavigationTimeout(navigationTimeoutMs);
	const coldPageErrors = [];
	coldPage.on('pageerror', (error) => coldPageErrors.push(error.message));
	coldPage.on('console', (message) => {
		if (message.type() === 'error') coldPageErrors.push(message.text());
	});
	let coldNavigationResult = 'completed within 10 seconds';
	try {
		await coldPage.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: navigationTimeoutMs });
	} catch (error) {
		if (!isNavigationTimeout(error)) throw error;
		coldNavigationResult = 'timed out at the original 10-second navigation limit';
		console.log(`COLD NAVIGATION: ${coldNavigationResult}; waiting for the same cold module graph to mount (no retry or stub).`);
	}
	// Keep the original navigation and interaction limits. This separate startup budget measures
	// actual cold module transformation and production component mount; compiler failures propagate.
	await coldPage.locator('.cm-content').waitFor({ state: 'visible', timeout: coldReadinessTimeoutMs });
	assert.deepEqual(coldPageErrors, [], 'the cold production workbench mounted without uncaught browser errors');
	const coldReadinessMs = Math.round(performance.now() - coldStartedAt);
	console.log(
		`COLD READINESS: CodeMirror mounted after ${(coldReadinessMs / 1000).toFixed(1)} s; original 10-second navigation ${coldNavigationResult}.`
	);
	await closeBounded(coldContext, 'cold browser context');
	coldContext = undefined;
	// A fresh context tests the warmed module graph under the unchanged navigation/interaction
	// deadlines. It does not turn the cold 10-second navigation result into a pass.
	context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
	const page = await context.newPage();
	page.setDefaultTimeout(navigationTimeoutMs);
	page.setDefaultNavigationTimeout(navigationTimeoutMs);
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') pageErrors.push(message.text());
	});
	await page.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: navigationTimeoutMs });
	await page.locator('.document-workbench[data-layout="wide"]').waitFor();
	await page.locator('.cm-content').waitFor();

	const source = page.locator('.cm-content');
	await source.click();
	await page.keyboard.press('End');
	await page.keyboard.type(' + unsaved');
	const editedText = await source.innerText();
	assert.match(editedText, /UNSAVED WORKBENCH BUFFER \+ unsaved/, 'the mounted production CodeMirror editor accepts input');
	await page.evaluate(() => (window.__documentWorkbench.editorBefore = document.querySelector('.cm-editor')));

	await page.setViewportSize({ width: 680, height: 900 });
	await page.locator('.document-workbench[data-layout="narrow"]').waitFor();
	const previewTab = page.locator('#workbench-preview-tab');
	await previewTab.click();
	assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
	const documentPanel = page.locator('.workbench-document-panel');
	const previewPanel = page.locator('.workbench-preview-panel');
	await previewPanel.waitFor();
	assert.equal(await previewPanel.getAttribute('aria-hidden'), 'false');
	assert.equal(await documentPanel.getAttribute('aria-hidden'), 'true');
	assert.equal(await documentPanel.getAttribute('inert'), '');
	assert.equal(await page.evaluate(() => document.activeElement?.id), 'workbench-preview-tab');
	assert.equal(await page.evaluate(() => document.querySelector('.cm-editor') === window.__documentWorkbench.editorBefore), true);
	assert.match(await source.innerText(), /UNSAVED WORKBENCH BUFFER \+ unsaved/, 'switching panes retains edited source state');
	const narrowRects = await page.evaluate(() => {
		const mainRect = document.querySelector('.document-workbench').getBoundingClientRect();
		const previewRect = document.querySelector('.workbench-preview-panel').getBoundingClientRect();
		return { mainWidth: mainRect.width, previewWidth: previewRect.width, previewLeft: previewRect.left, mainLeft: mainRect.left };
	});
	assert.ok(narrowRects.previewWidth >= narrowRects.mainWidth - 2, 'the selected PDF pane uses the narrow work area width');
	assert.equal(narrowRects.previewLeft, narrowRects.mainLeft);
	assert.equal(await documentPanel.evaluate((panel) => panel.inert), true, 'an inactive editor is removed from keyboard focus');
	const narrowSeparator = page.locator('.workbench-preview-splitter [role="separator"]');
	assert.equal(
		Number(await narrowSeparator.getAttribute('aria-valuemax')),
		await page.evaluate(() => window.__documentWorkbench.layout.clampPdf(Number.POSITIVE_INFINITY)),
		'the PDF splitter exposes PaneLayout’s current clamped maximum'
	);

	// Simulate an external shortcut closing the PDF while its narrow tab is active. The editor must
	// become available again without replacing its mounted CodeMirror instance or unsaved buffer.
	await page.evaluate(() => window.__documentWorkbench.layout.setPdfPaneOpen(false));
	await page.locator('#workbench-document-tab[aria-selected="true"]').waitFor();
	assert.equal(await page.locator('.workbench-preview-panel').count(), 0);
	assert.equal(await documentPanel.getAttribute('aria-hidden'), 'false');
	assert.equal(await documentPanel.evaluate((panel) => panel.inert), false);
	assert.equal(await page.evaluate(() => document.querySelector('.cm-editor') === window.__documentWorkbench.editorBefore), true);
	assert.match(
		await source.innerText(),
		/UNSAVED WORKBENCH BUFFER \+ unsaved/,
		'external PDF close returns to the document with unsaved source intact'
	);

	await previewTab.click();
	await previewPanel.waitFor();
	assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
	assert.equal(await previewPanel.getAttribute('aria-hidden'), 'false');
	await page.evaluate(
		() => (window.__documentWorkbench.previewBefore = document.querySelector('.workbench-preview-panel > div:last-child'))
	);

	await page.keyboard.press('ArrowLeft');
	assert.equal(await page.evaluate(() => document.activeElement?.id), 'workbench-document-tab');
	assert.equal(await documentPanel.getAttribute('aria-hidden'), 'false');
	assert.equal(await previewPanel.getAttribute('aria-hidden'), 'true');
	assert.equal(
		await page.evaluate(
			() => document.querySelector('.workbench-preview-panel > div:last-child') === window.__documentWorkbench.previewBefore
		),
		true
	);
	assert.equal(await page.evaluate(() => document.querySelector('.cm-editor') === window.__documentWorkbench.editorBefore), true);
	assert.match(await source.innerText(), /UNSAVED WORKBENCH BUFFER \+ unsaved/, 'keyboard switching also preserves source state');

	await page.setViewportSize({ width: 1200, height: 900 });
	await page.locator('.document-workbench[data-layout="wide"]').waitFor();
	assert.equal(await page.locator('.workbench-pane-tabs').count(), 0, 'wide layout returns to the side-by-side canvas');
	assert.equal(await documentPanel.evaluate((panel) => getComputedStyle(panel).display !== 'none'), true);
	assert.equal(await previewPanel.evaluate((panel) => getComputedStyle(panel).display !== 'none'), true);
	const wideRects = await page.evaluate(() => {
		const documentRect = document.querySelector('.workbench-document-panel').getBoundingClientRect();
		const previewRect = document.querySelector('.workbench-preview-panel').getBoundingClientRect();
		return {
			documentLeft: documentRect.left,
			documentRight: documentRect.right,
			previewLeft: previewRect.left,
			previewRight: previewRect.right
		};
	});
	assert.ok(wideRects.documentRight <= wideRects.previewLeft, 'wide layout keeps document and PDF side by side');
	assert.ok(wideRects.documentLeft < wideRects.previewLeft && wideRects.previewRight > wideRects.previewLeft);
	const separator = page.locator('.workbench-preview-splitter [role="separator"]');
	assert.equal(await separator.getAttribute('aria-valuemin'), '280');
	assert.ok(Number(await separator.getAttribute('aria-valuenow')) >= 280);
	const toolbarPrimary = page.locator('.document-workbench-shell .workbench-action-filled').first();
	assert.ok((await toolbarPrimary.count()) > 0, 'owned primary toolbar actions use the scoped workbench class');
	const originalMode = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
	const sampleWorkbenchAction = async (label) => {
		const sample = await toolbarPrimary.evaluate((element) => {
			const shell = document.querySelector('.document-workbench-shell');
			const actionStyle = getComputedStyle(element);
			const shellStyle = shell ? getComputedStyle(shell) : null;
			return {
				mode: document.documentElement.getAttribute('data-mode'),
				rootClasses: document.documentElement.className,
				shellFound: Boolean(shell),
				shellActionToken: shellStyle?.getPropertyValue('--workbench-action-bg').trim() ?? null,
				shellForegroundToken: shellStyle?.getPropertyValue('--workbench-action-text').trim() ?? null,
				buttonClasses: element.className,
				disabled: element.matches(':disabled'),
				backgroundColor: actionStyle.backgroundColor,
				color: actionStyle.color,
				borderColor: actionStyle.borderColor,
				transitionProperty: actionStyle.transitionProperty,
				transitionDuration: actionStyle.transitionDuration,
				transitionDelay: actionStyle.transitionDelay,
				activeTransitions: element.getAnimations().map((animation) => ({
					playState: animation.playState,
					currentTime: animation.currentTime,
					transitionProperty: animation.transitionProperty,
					computedTiming: animation.effect?.getComputedTiming()
				}))
			};
		});
		console.log(`THEME DIAGNOSTIC ${label}: ${JSON.stringify(sample)}`);
		return sample;
	};
	const waitForWorkbenchActionTransitions = () =>
		page.waitForFunction(
			() => {
				const action = document.querySelector('.document-workbench-shell .workbench-action-filled');
				return Boolean(action && action.getAnimations().length === 0);
			},
			undefined,
			{ timeout: navigationTimeoutMs }
		);
	await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
	await waitForWorkbenchActionTransitions();
	const lightSample = await sampleWorkbenchAction('light');
	await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));
	await waitForWorkbenchActionTransitions();
	const darkSample = await sampleWorkbenchAction('dark');
	assert.notEqual(darkSample.backgroundColor, lightSample.backgroundColor, 'scoped workbench action colors adapt to light and dark modes');
	assert.equal(darkSample.color, 'rgb(23, 35, 29)');
	await page.evaluate((mode) => {
		if (mode === null) document.documentElement.removeAttribute('data-mode');
		else document.documentElement.setAttribute('data-mode', mode);
	}, originalMode);
	assert.equal(await page.evaluate(() => document.querySelector('.cm-editor') === window.__documentWorkbench.editorBefore), true);
	assert.deepEqual(pageErrors, [], 'the production workbench mounted without uncaught browser errors');
	console.log(
		`PASS Chrome ${browser.version()}: warmed-module layout check preserves an edited CodeMirror document across responsive panel transitions and scoped light/dark toolbar styling; Save, Compile, and real PDF output are not exercised`
	);
} catch (error) {
	failure = error;
} finally {
	const cleanupErrors = [];
	for (const [resource, label] of [
		[context, 'interaction browser context'],
		[coldContext, 'cold browser context'],
		[browser, 'browser'],
		[server, 'Vite server']
	]) {
		if (!resource) continue;
		try {
			await closeBounded(resource, label);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		process.chdir(previousCwd);
	} catch (error) {
		cleanupErrors.push(error);
	}
	if (cleanupErrors.length) {
		failure = failure
			? new AggregateError([failure, ...cleanupErrors], 'Workbench live check and cleanup both failed')
			: new AggregateError(cleanupErrors, 'Workbench live check cleanup failed');
	}
}

if (failure) {
	console.error(`FAIL document-workbench live check:\n${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`);
	process.exitCode = 1;
}
