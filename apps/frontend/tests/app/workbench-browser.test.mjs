import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const runtimeArtifacts = path.join(
	repository,
	'.verification-artifacts',
	'frontend-runtime-2026-10-07'
);
const OWNER_ID = 1;
const browserChannel = process.env.MODUTEX_TEST_BROWSER_CHANNEL;
if (browserChannel && !['chrome', 'msedge'].includes(browserChannel)) throw new Error('Unsupported browser channel');

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitForCondition(check, timeoutMs = 25_000, pollIntervalMs = 50) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await check();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

test('real-browser App workbench regression harness', { timeout: 480_000 }, async (t) => {
	let viteServer;
	let browser;
	let context;
	let page;
	let fixtureDir;
	let hostFiles;
	let hostEngine;
	let hostCompiler;
	const activeWatches = new Map();
	const pageErrors = [];
	const consoleErrors = [];
	const watcherDeliveryPromises = [];
	const watcherDeliveryErrors = [];

	let startCompileCalls = 0;
	let cancelCompileCalls = 0;
	let lastWriteReceipt = null;
	let lastCompileResult = null;
	let hostClosedWorkspaceId = null;
	let cancelTestBarrier = null;
	let activeIdentity = null;
	let activeResult = null;
	const hostFailures = [];

	try {
		// 1. 單一持久 Vite Server（注入測試專用 unmount hook，支援 SSR 載入）
		viteServer = await createServer({
			root: frontendRoot,
			configFile: false,
			plugins: [
				svelte(),
				{
					name: 'test-harness-unmount-hook',
					transform(code, id) {
						if (id.replaceAll('\\', '/').split('?')[0] === path.join(frontendRoot, 'src', 'main.ts').replaceAll('\\', '/')) {
							return `import { mount, unmount } from 'svelte';
import App from './App.svelte';
import './styles/base.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing application mount');
const appInstance = mount(App, { target });
window.__unmountApp = () => unmount(appInstance);
`;
						}
					}
				}
			],
			server: { port: 0, host: '127.0.0.1' },
			logLevel: 'error'
		});
		await viteServer.listen();
		const serverAddress = viteServer.httpServer.address();
		const serverPort =
			typeof serverAddress === 'object' && serverAddress ? serverAddress.port : 5173;
		const appUrl = `http://127.0.0.1:${serverPort}/#/workbench`;

		// 2. 透過同一個 Vite 實例 ssrLoadModule 載入 Host 模組，避免契約動態匯入失效
		const managedModule = await viteServer.ssrLoadModule(
			fileURLToPath(new URL('../../../../electron/src/managed-compile.ts', import.meta.url))
		);
		const fileModule = await viteServer.ssrLoadModule(
			fileURLToPath(new URL('../../../../electron/src/frontend-files.ts', import.meta.url))
		);
		const compilerModule = await viteServer.ssrLoadModule(
			fileURLToPath(new URL('../../../../electron/src/frontend-compile.ts', import.meta.url))
		);
		const watchModule = await viteServer.ssrLoadModule(
			fileURLToPath(new URL('../../../../electron/src/frontend-watch.ts', import.meta.url))
		);

		// 3. 驗證並準備 warm runtime cache
		await managedModule.checkedCompilePath(repository, true);
		for (const targetPath of [path.dirname(runtimeArtifacts), runtimeArtifacts]) {
			try {
				await fs.promises.mkdir(targetPath);
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
			}
			await managedModule.checkedCompilePath(targetPath, true);
		}

		// 4. 建立單一定向測試工作區
		fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'modutex-wb-browser-'));
		const mainTexPath = path.join(fixtureDir, 'main.tex');
		const helperTexPath = path.join(fixtureDir, 'helper.tex');

		// 具備 BOM 與 CRLF 混合換行之標準初始內容（結尾為 LF）
		const initialMainBytes = Buffer.from(
			'\uFEFF% Initial document with BOM\r\n\\documentclass{article}\r\n\\begin{document}\r\nInitial body.\r\n\\end{document}\n',
			'utf8'
		);
		const initialHelperBytes = Buffer.from(
			'\\documentclass{article}\n\\begin{document}\nHelper secondary content.\n\\end{document}\n',
			'utf8'
		);

		await fs.promises.writeFile(mainTexPath, initialMainBytes);
		await fs.promises.writeFile(helperTexPath, initialHelperBytes);

		// 5. 實例化真實主機服務
		hostFiles = new fileModule.FrontendFiles();
		hostEngine = managedModule.createManagedCompileService({
			runtime: {
				isPackaged: false,
				appPath: repository,
				resourcesPath: repository,
				userData: runtimeArtifacts
			},
			authorize: () => hostFiles.compileOwner()
		});
		hostCompiler = new compilerModule.FrontendCompiler(hostEngine, () => hostFiles);

		// 6. 啟動 Chromium（僅使用 --disable-gpu，viewport 1440x1000 確保雙窗格可見）
		browser = await chromium.launch({
			channel: browserChannel,
			headless: true,
			args: ['--disable-gpu']
		});
		context = await browser.newContext({
			viewport: { width: 1440, height: 1000 }
		});
		page = await context.newPage();

		page.on('pageerror', (err) => pageErrors.push(err));
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text() + ' ' + msg.location().url);
		});
		page.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`HTTP ${response.status()} ${response.url()}`); });

		const hostState = {
			selectedWorkspacePath: fixtureDir,
			selectedSaveAsPath: path.join(fixtureDir, 'saved.tex')
		};

		// 7. 將 modutexFiles 繫結至真實主機運作，嚴格遵循 main.ts 之順序與 assertCurrent
		await page.exposeFunction('__host_openWorkspace', async (kind) => {
			for (const [, sub] of activeWatches) {
				sub.watcher.stop();
			}
			activeWatches.clear();
			hostCompiler.cancelOwner(OWNER_ID);
			return await hostFiles.open(hostState.selectedWorkspacePath, kind);
		});
		await page.exposeFunction('__host_listRecent', async () => []);
		await page.exposeFunction('__host_openRecent', async () => null);
		await page.exposeFunction('__host_removeRecent', async () => undefined);
		await page.exposeFunction('__host_listFiles', async (id) => {
			return await hostFiles.list(id);
		});
		await page.exposeFunction('__host_readFile', async (file) => {
			const receipt = await hostFiles.read(file);
			return {
				workspaceId: receipt.workspaceId,
				path: receipt.path,
				revision: receipt.revision,
				bytes: Array.from(receipt.bytes)
			};
		});
		await page.exposeFunction('__host_writeFile', async (request) => {
			hostCompiler.cancelOwner(OWNER_ID);
			const receipt = await hostFiles.write({
				...request,
				bytes: new Uint8Array(request.bytes)
			});
			lastWriteReceipt = receipt;
			return receipt;
		});
		await page.exposeFunction('__host_saveAs', async (request) => {
			hostCompiler.cancelOwner(OWNER_ID);
			for (const [, sub] of activeWatches) {
				sub.watcher.stop();
			}
			activeWatches.clear();

			const assertOwner = hostFiles.saveAsOwner(request.workspaceId);
			return await hostFiles.saveAs(
				hostState.selectedSaveAsPath,
				{ ...request, bytes: new Uint8Array(request.bytes) },
				assertOwner
			);
		});
		await page.exposeFunction('__host_startCompile', async (request) => {
			startCompileCalls++;
			const identity = await hostCompiler.start({}, OWNER_ID, request);
			activeIdentity = identity;
			activeResult = null;
			const barrier = cancelTestBarrier;
			if (barrier) {
				barrier.identityAllocated.resolve(identity);
				await barrier.holdStart.promise;
			}
			return identity;
		});
		await page.exposeFunction('__host_compileResult', async (id) => {
			const pending = hostCompiler.result(OWNER_ID, id);
			activeResult = pending;
			const result = await pending;
			t.diagnostic(`Real host compile result: ${result.status}`);
			lastCompileResult = result;
			return result.status === 'success' ? { ...result, pdf: Array.from(result.pdf) } : result;
		});
		await page.exposeFunction('__host_cancelCompile', async (id) => {
			cancelCompileCalls++;
			return await hostCompiler.cancel(OWNER_ID, id);
		});
		await page.exposeFunction('__host_closeWorkspace', async (id) => {
			hostCompiler.cancelOwner(OWNER_ID);
			for (const [, sub] of activeWatches) {
				sub.watcher.stop();
			}
			activeWatches.clear();
			hostFiles.close(id);
			hostClosedWorkspaceId = id;
		});
		await page.exposeFunction('__host_startWatch', async (workspaceId, subscriptionId) => {
			if (activeWatches.size > 0) throw new Error('BUSY');

			const assertWorkspace = hostFiles.saveAsOwner(workspaceId);
			const owner = hostFiles.compileOwner();
			let watcherInstance;

			const assertWatchOwner = () => {
				if (activeWatches.get(subscriptionId)?.watcher !== watcherInstance) {
					throw new Error('STALE_WORKSPACE');
				}
				assertWorkspace();
				owner.assertCurrent();
			};

			watcherInstance = new watchModule.FrontendWatch({
				root: owner.root,
				workspaceId,
				assertCurrent: assertWatchOwner,
				emit(event) {
					assertWatchOwner();
					const p = page
						.evaluate(
							({ subscriptionId, event }) => {
								window.__emitWatchEvent({ subscriptionId, event });
							},
							{ subscriptionId, event }
						)
						.catch((err) => {
							watcherDeliveryErrors.push(err);
						});
					watcherDeliveryPromises.push(p);
				},
				onError(failure) {
					activeWatches.delete(subscriptionId);
					const p = page
						.evaluate(
							({ subscriptionId, failure }) => {
								window.__emitWatchError({ subscriptionId, error: failure });
							},
							{ subscriptionId, failure }
						)
						.catch((err) => {
							watcherDeliveryErrors.push(err);
						});
					watcherDeliveryPromises.push(p);
				}
			});

			activeWatches.set(subscriptionId, { workspaceId, watcher: watcherInstance });
			try {
				await watcherInstance.start();
				assertWatchOwner();
			} catch (err) {
				activeWatches.delete(subscriptionId);
				watcherInstance.stop();
				throw err;
			}
		});
		await page.exposeFunction('__host_stopWatch', async (subscriptionId) => {
			const sub = activeWatches.get(subscriptionId);
			if (sub) {
				activeWatches.delete(subscriptionId);
				sub.watcher.stop();
			}
		});

		// 初始化瀏覽器注入腳本（維護唯讀監聽器計數）
		await page.addInitScript(() => {
			const eventListeners = new Set();
			const errorListeners = new Set();
			window.__emitWatchEvent = (payload) => {
				for (const listener of eventListeners) listener(payload);
			};
			window.__emitWatchError = (payload) => {
				for (const listener of errorListeners) listener(payload);
			};
			window.__test_getWatchListenerCounts = () => ({
				events: eventListeners.size,
				errors: errorListeners.size
			});
			window.modutexFiles = {
				openWorkspace: (kind) => window.__host_openWorkspace(kind),
				listRecent: () => window.__host_listRecent(),
				openRecent: (id) => window.__host_openRecent(id),
				removeRecent: (id) => window.__host_removeRecent(id),
				listFiles: (id) => window.__host_listFiles(id),
				readFile: async (file) => {
					const result = await window.__host_readFile(file);
					return {
						workspaceId: result.workspaceId,
						path: result.path,
						revision: result.revision,
						bytes: new Uint8Array(result.bytes)
					};
				},
				writeFile: async (request) => {
					return await window.__host_writeFile({
						...request,
						bytes: Array.from(request.bytes)
					});
				},
				saveAs: async (request) => {
					return await window.__host_saveAs({
						...request,
						bytes: Array.from(request.bytes)
					});
				},
				startCompile: (request) => window.__host_startCompile(request),
				compileResult: async (id) => {
					const result = await window.__host_compileResult(id);
					return result.status === 'success' ? { ...result, pdf: new Uint8Array(result.pdf) } : result;
				},
				cancelCompile: (id) => window.__host_cancelCompile(id),
				closeWorkspace: (id) => window.__host_closeWorkspace(id),
				startWatch: (workspaceId, subscriptionId) =>
					window.__host_startWatch(workspaceId, subscriptionId),
				stopWatch: (subscriptionId) => window.__host_stopWatch(subscriptionId),
				onWatchEvent: (listener) => {
					eventListeners.add(listener);
					return () => {
						eventListeners.delete(listener);
					};
				},
				onWatchError: (listener) => {
					errorListeners.add(listener);
					return () => {
						errorListeners.delete(listener);
					};
				}
			};
		});

		// 8. 載入工作台頁面並開啟資料夾
		await page.goto(appUrl);

		const openFolderButton = page.locator('header .global-actions button', {
			hasText: /開啟資料夾|Open folder/
		});
		await openFolderButton.click();

		const mainFileRow = page.locator('aside.files button.file-row', { hasText: 'main.tex' });
		const helperFileRow = page.locator('aside.files button.file-row', { hasText: 'helper.tex' });
		await mainFileRow.waitFor({ state: 'visible' });
		await mainFileRow.click();

		const cmContent = page.locator('.cm-content');
		await cmContent.waitFor({ state: 'visible' });

		// 9. 驗證非循環獨立期望之 BOM/換行保存，以及真實檔案切換再開啟
		let currentWorkspaceId;
		await t.test('substantial open/edit/save/reopen byte and revision preservation', async () => {
			const appendEdit = '% Appended ASCII 中文';
			const expectedSavedBytes = Buffer.concat([
				initialMainBytes,
				Buffer.from(appendEdit, 'utf8')
			]);

			await cmContent.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText(appendEdit);

			const statusBar = page.locator('footer.status-bar');
			await waitForCondition(async () => {
				const text = await statusBar.textContent();
				return text.includes('未儲存') || text.includes('Unsaved');
			});

			const saveButton = page.locator('header .global-actions button', {
				hasText: /^儲存$|^Save$/
			});
			await saveButton.click();

			await waitForCondition(async () => {
				const text = await statusBar.textContent();
				return !text.includes('未儲存') && !text.includes('Unsaved') && !text.includes('儲存中');
			});

			assert.ok(lastWriteReceipt, 'Expected write receipt');
			currentWorkspaceId = lastWriteReceipt.workspaceId;

			// 獨立比對：磁碟必須等於獨立計算之 expectedSavedBytes
			const diskBytes = await fs.promises.readFile(mainTexPath);
			assert.deepEqual(diskBytes, expectedSavedBytes);

			const hostReceipt = await hostFiles.read({
				workspaceId: currentWorkspaceId,
				path: 'main.tex'
			});
			assert.equal(hostReceipt.revision, lastWriteReceipt.revision);
			assert.deepEqual(Buffer.from(hostReceipt.bytes), expectedSavedBytes);

			// 真實切換至 helper.tex，再切換回 main.tex 驗證再開啟
			await helperFileRow.click();
			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes('Helper secondary content');
			});

			await mainFileRow.click();
			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes(appendEdit);
			});
		});

		// 10. 驗證真實成功編譯：位元組匹配、aria-busy=false、非純白筆跡 Canvas 渲染
		let initialCanvasDataUrl;
		let initialSuccessfulPdfBytes;
		await t.test('actual successful compile shows genuine PDF and verifies render', async () => {
			const compileButton = page.locator('header .global-actions button', {
				hasText: /編譯 PDF|Compile PDF/
			});
			await compileButton.click();

			const statusBar = page.locator('footer.status-bar');
			await waitForCondition(async () => {
				const text = await statusBar.textContent();
				return text.includes('編譯完成') || text.includes('Compilation completed');
			}, 180_000);

			assert.ok(lastCompileResult && lastCompileResult.status === 'success');
			assert.equal(lastCompileResult.identity.entryPath, 'main.tex');

			const outputPdf = await fs.promises.readFile(path.join(fixtureDir, 'output', 'main.pdf'));
			assert.deepEqual(Buffer.from(lastCompileResult.pdf), outputPdf);
			assert.equal(outputPdf.subarray(0, 5).toString('ascii'), '%PDF-');
			initialSuccessfulPdfBytes = Buffer.from(lastCompileResult.pdf);

			// 等待 PdfView 完成渲染（aria-busy=false）
			await page.locator('.pdf-scroll[aria-busy="false"]').waitFor({ state: 'attached' });
			const previewCanvas = page.locator('.preview-pane canvas').first();
			await previewCanvas.waitFor({ state: 'visible' });

			// 等待 Canvas 出現非純白筆跡
			await waitForCondition(async () => {
				return await previewCanvas.evaluate((canvas) => {
					if (!canvas.width || !canvas.height) return false;
					const ctx = canvas.getContext('2d');
					const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
					for (let i = 0; i < data.length; i += 4) {
						if (data[i + 3] > 0 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)) {
							return true;
						}
					}
					return false;
				});
			});

			initialCanvasDataUrl = await previewCanvas.evaluate((c) => c.toDataURL());
			assert.ok(initialCanvasDataUrl.length > 100);
			await page.screenshot({ path: path.join(repository, '.verification-artifacts', 'workbench-mainpath-browser-20261010.png') });
		});

		// 11. 衝突測試：髒草稿、外部寫入、等待橫幅、實際點擊編譯確認受阻且保留草稿與磁碟
		await t.test('conflict prevents compile and reloads from disk notice', async () => {
			const compileCountBefore = startCompileCalls;

			await cmContent.click();
			await page.keyboard.insertText('% Local draft conflict edit\n');

			const externalConflictBytes = Buffer.from(
				'\\documentclass{article}\n\\begin{document}\nExternal disk modification.\n\\end{document}\n',
				'utf8'
			);
			await fs.promises.writeFile(mainTexPath, externalConflictBytes);

			const noticeStrip = page.locator('.file-change-notice[data-kind="changed"]');
			await noticeStrip.waitFor({ state: 'visible' });

			// 實際點擊編譯按鈕
			const compileButton = page.locator('header .global-actions button', {
				hasText: /編譯 PDF|Compile PDF/
			});
			await compileButton.click();

			// 等待出現衝突錯誤橫幅
			const errorStrip = page.locator('.error-strip[role="alert"]', { hasText: /磁碟文件已變更|Disk file changed/ });
			await errorStrip.waitFor({ state: 'visible' });
			await compileButton.waitFor({ state: 'visible' });

			assert.equal(startCompileCalls, compileCountBefore, 'startCompile must not have been called');
			const diskBytes = await fs.promises.readFile(mainTexPath);
			assert.deepEqual(diskBytes, externalConflictBytes, 'External disk bytes must remain untouched');

			const currentEditorText = await cmContent.textContent();
			assert.ok(currentEditorText.includes('% Local draft conflict edit'));

			// 透過 App 動作從磁碟重新載入
			const reloadButton = noticeStrip.locator('button', {
				hasText: /從磁碟重新載入|Reload from disk/
			});
			page.once('dialog', (dialog) => dialog.accept());
			await reloadButton.click();

			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes('External disk modification');
			});
		});

		// 12. 編譯失敗保留先前成功 PDF 與全圖 Canvas 像素渲染
		await t.test('compiler failure keeps prior successful PDF and pixel render', async () => {
			await cmContent.click();
			await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\\undefinedfrontendcommand\\end{document}\n');

			const saveButton = page.locator('header .global-actions button', {
				hasText: /^儲存$|^Save$/
			});
			await saveButton.click();
			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return !text.includes('未儲存') && !text.includes('Unsaved');
			});

			const compileButton = page.locator('header .global-actions button', {
				hasText: /編譯 PDF|Compile PDF/
			});
			const priorRunId = lastCompileResult?.identity.runId;
			await compileButton.click();
			await waitForCondition(() => lastCompileResult?.identity.runId !== priorRunId, 180_000);
			assert.equal(lastCompileResult.status, 'failure', lastCompileResult.log);
			await waitForCondition(async () => (await page.locator('footer.status-bar').textContent()).match(/編譯失敗|Compilation failed/));

			// 失敗時斷言先前成功渲染之 Canvas 像素特徵完全保持
			const previewCanvas = page.locator('.preview-pane canvas').first();
			await previewCanvas.waitFor({ state: 'visible' });
			await waitForCondition(() => previewCanvas.evaluate((canvas, expected) =>
				canvas.closest('.pdf-scroll')?.getAttribute('aria-busy') === 'false' && canvas.toDataURL() === expected,
				initialCanvasDataUrl));
			const currentCanvasDataUrl = await previewCanvas.evaluate((c) => c.toDataURL());
			assert.ok(currentCanvasDataUrl === initialCanvasDataUrl, 'Failure must preserve the prior rendered PDF pixels');
		});

		// 13. 延遲 Start 屏障期間取消結算，比對像素保留並重試真實編譯前進序號
		await t.test('cancellation during delayed start response settles and retry works', async () => {
			await cmContent.click();
			await page.keyboard.press('Control+A');
			await page.keyboard.insertText(
				'\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n'
			);
			const saveButton = page.locator('header .global-actions button', {
				hasText: /^儲存$|^Save$/
			});
			await saveButton.click();
			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return !text.includes('未儲存') && !text.includes('Unsaved');
			});

			// 建立排程屏障：待 host 分配真實 start identity 後通知，再按下取消
			cancelTestBarrier = {
				identityAllocated: deferred(),
				holdStart: deferred()
			};

			const compileButton = page.locator('header .global-actions button', {
				hasText: /編譯 PDF|Compile PDF/
			});
			await compileButton.click();

			// 等待真實 identity 分配後再按取消
			await cancelTestBarrier.identityAllocated.promise;
			const cancelButton = page.locator('header .global-actions button', {
				hasText: /取消編譯|Cancel compilation/
			});
			await cancelButton.waitFor({ state: 'visible' });
			await cancelButton.click();

			// 釋放 holdStart 讓 startCompile 呼叫完成
			const barrier = cancelTestBarrier;
			cancelTestBarrier = null;
			barrier.holdStart.resolve();

			// 等待取消結算（包含 fast-success 導致結果未載入或編譯已取消）
			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return (
					text.includes('編譯已取消') ||
					text.includes('Compilation cancelled') ||
					text.includes('本次編譯結果未載入') ||
					text.includes('not loaded')
				);
			});

			assert.ok(cancelCompileCalls > 0, 'Expected cancelCompile to be invoked');
			assert.equal(lastCompileResult?.status, 'cancelled');
			assert.equal(lastCompileResult?.identity.runId, activeIdentity.runId);

			// 重試前確認舊 Canvas 像素依然保留
			const previewCanvas = page.locator('.preview-pane canvas').first();
			const canvasBeforeRetry = await previewCanvas.evaluate((c) => c.toDataURL());
			assert.ok(canvasBeforeRetry === initialCanvasDataUrl, 'Cancellation must preserve the prior rendered PDF pixels');
			assert.equal(initialSuccessfulPdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');
			await cmContent.click();
			await page.keyboard.press('Control+A');
			await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\nValid recovery text.\n\\end{document}\n');
			await saveButton.click();
			await waitForCondition(async () => !(await page.locator('footer.status-bar').textContent()).match(/未儲存|Unsaved/));

			// 點擊重試並驗證結果序列實質前進
			const previousRunId = lastCompileResult?.identity?.runId;
			await compileButton.click();

			await waitForCondition(async () => {
				return (
					lastCompileResult?.identity?.runId !== previousRunId &&
					lastCompileResult?.status === 'success'
				);
			}, 180_000);

			await page.locator('.pdf-scroll[aria-busy="false"]').waitFor({ state: 'attached' });
			assert.deepEqual(Buffer.from(lastCompileResult.pdf), await fs.promises.readFile(path.join(fixtureDir, 'output', 'main.pdf')));
		});

		// 14. 髒編輯確認切換與真實 App 卸載釋放
		await t.test('dirty source switch confirmation and real app teardown', async () => {
			await cmContent.click();
			await page.keyboard.insertText('% Unsaved switch draft\n');

			// 1. 取消對話框：保留草稿
			page.once('dialog', async (dialog) => {
				await dialog.dismiss();
			});
			await helperFileRow.click();

			const textPreserved = await cmContent.textContent();
			assert.ok(textPreserved.includes('Unsaved switch draft'));

			// 2. 接受對話框：切換至 helper.tex
			page.once('dialog', async (dialog) => {
				await dialog.accept();
			});
			await helperFileRow.click();

			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes('Helper secondary content');
			});

			// 等待所有異步 Watcher 傳遞完成
			await Promise.all(watcherDeliveryPromises);
			assert.deepEqual(watcherDeliveryErrors, []);

			// 調用注入之 __unmountApp 觸發真實 onDestroy 卸載
			await page.evaluate(() => window.__unmountApp());

			// 斷言瀏覽器端監聽器計數降為零，主機工作區關閉
			await waitForCondition(async () => {
				const counts = await page.evaluate(() => window.__test_getWatchListenerCounts());
				return (
					counts.events === 0 &&
					counts.errors === 0 &&
					activeWatches.size === 0 &&
					hostClosedWorkspaceId === currentWorkspaceId
				);
			});
		});
	} finally {
		// 15. 資源清理與故障排查（不吞掉任何錯誤）
		cancelTestBarrier?.holdStart.resolve();
		if (hostCompiler && activeIdentity && !activeResult) {
			try {
				await hostCompiler.cancel(OWNER_ID, activeIdentity.runId);
				await hostCompiler.result(OWNER_ID, activeIdentity.runId);
			} catch (error) { if (error.message !== 'STALE_WORKSPACE') hostFailures.push(error); }
		}
		if (hostCompiler) hostCompiler.cancelOwner(OWNER_ID);
		await activeResult;
		for (const [, sub] of activeWatches) sub.watcher.stop();
		activeWatches.clear();
		await Promise.all(watcherDeliveryPromises);
		if (page) await page.close();
		if (context) await context.close();
		if (browser) await browser.close();

		if (hostCompiler) hostCompiler.cancelOwner(OWNER_ID);
		if (hostEngine) hostEngine.close();
		if (hostFiles) hostFiles.close();

		if (viteServer) await viteServer.close();
		if (fixtureDir) {
			assert.equal(path.dirname(fixtureDir), os.tmpdir());
			assert.ok(path.basename(fixtureDir).startsWith('modutex-wb-browser-'));
			await fs.promises.rm(fixtureDir, { recursive: true, force: true });
		}

		assert.deepEqual(pageErrors, [], 'Page must have no uncaught exceptions');
		assert.deepEqual(consoleErrors, [], 'Console must have no uncaught runtime errors');
		assert.deepEqual(watcherDeliveryErrors, [], 'Watch delivery errors must remain visible');
		assert.deepEqual(hostFailures, [], 'Host cleanup must drain without unexpected errors');
	}
});
