import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { clickFileAction } from '../../../../tests/scripts/helpers/app-file-actions.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));

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

test('async replacement confirmation semantics test suite', { timeout: 300_000 }, async (t) => {
	let viteServer;
	let browser;
	let context;
	let page;
	const pageErrors = [];
	const consoleErrors = [];

	try {
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
		const serverPort = typeof serverAddress === 'object' && serverAddress ? serverAddress.port : 5173;
		const appUrl = `http://127.0.0.1:${serverPort}/#/workbench`;

		browser = await chromium.launch({
			headless: true,
			...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
			args: ['--disable-gpu']
		});
		context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		page = await context.newPage();

		page.on('pageerror', (err) => pageErrors.push(err));
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text());
		});

		await page.addInitScript(() => {
			window.__nativeConfirm = window.confirm.bind(window);
			let currentWorkspace = null;
			let revCounter = 1;
			const initialMain = '\\documentclass{article}\n\\begin{document}\nMain body content.\n\\end{document}\n';
			const initialHelper = '\\documentclass{article}\n\\begin{document}\nHelper secondary content.\n\\end{document}\n';

			window.__fileStore = {
				'main.tex': {
					revision: 'rev-main-1',
					bytes: new TextEncoder().encode(initialMain)
				},
				'helper.tex': {
					revision: 'rev-helper-1',
					bytes: new TextEncoder().encode(initialHelper)
				}
			};

			window.__resetMockFiles = () => {
				window.__fileStore['main.tex'] = {
					revision: 'rev-main-1',
					bytes: new TextEncoder().encode(initialMain)
				};
				window.__fileStore['helper.tex'] = {
					revision: 'rev-helper-1',
					bytes: new TextEncoder().encode(initialHelper)
				};
			};

			window.modutexFiles = {
				openWorkspace: async (kind) => {
					currentWorkspace = { id: 'ws-1', label: 'test-ws', entryPath: 'main.tex' };
					return currentWorkspace;
				},
				listRecent: async () => [],
				openRecent: async () => null,
				removeRecent: async () => undefined,
				listFiles: async () => [
					{ path: 'main.tex', kind: 'file' },
					{ path: 'helper.tex', kind: 'file' }
				],
				readFile: async ({ workspaceId, path: filePath }) => {
					const entry = window.__fileStore[filePath];
					if (!entry) throw new Error('FILE_NOT_FOUND');
					return {
						workspaceId,
						path: filePath,
						revision: entry.revision,
						documentId: entry.documentId ?? null,
						documentVersion: entry.documentVersion ?? null,
						bytes: new Uint8Array(entry.bytes)
					};
				},
				writeFile: async (req) => ({
					workspaceId: req.workspaceId,
					path: req.path,
					revision: 'rev-' + (++revCounter),
					documentId: req.documentId,
					documentVersion: req.documentVersion
				}),
				saveAs: async () => null,
				startCompile: async () => { throw new Error('NOT_IMPLEMENTED'); },
				compileResult: async () => { throw new Error('NOT_IMPLEMENTED'); },
				cancelCompile: async () => {},
				closeWorkspace: async () => { currentWorkspace = null; },
				startWatch: async () => {},
				stopWatch: async () => {},
				onWatchEvent: () => () => {},
				onWatchError: () => () => {}
			};
		});

		const cmContent = page.locator('.cm-content');

		async function ensureSourceMode() {
			await page.locator('.cm-content:visible, button[aria-label="原始碼"]:visible, button[aria-label="Source"]:visible').first().waitFor({ state: 'visible' });
			if (!(await cmContent.isVisible())) {
				const sourceBtn = page.getByRole('button', { name: /^(原始碼|Source)$/ });
				await sourceBtn.waitFor({ state: 'visible' });
				await sourceBtn.click();
			}
			await cmContent.waitFor({ state: 'visible' });
		}

		async function setupIsolatedWorkbench() {
			await page.goto(appUrl);
			await page.evaluate(() => {
				if (window.__resetMockFiles) window.__resetMockFiles();
				window.confirm = window.__nativeConfirm;
			});
			await clickFileAction(page, /^(開啟資料夾|Open folder)$/);
			const mainFileRow = page.locator('aside.files button.file-row', { hasText: 'main.tex' });
			await mainFileRow.waitFor({ state: 'visible' });
			await mainFileRow.click();
			await ensureSourceMode();
			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes('Main body content');
			});
		}

		// 1. deferred false/true: 非同步確認 promise 之取消與接受語意
		await t.test('deferred confirmation false and true', async () => {
			await setupIsolatedWorkbench();

			await cmContent.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText('\n% Deferred test draft');

			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return text.includes('未儲存') || text.includes('Unsaved');
			});

			// 設置 deferred confirmation
			await page.evaluate(() => {
				window.__confirmCalls = [];
				window.__confirmDeferred = null;
				window.confirm = (msg) => {
					window.__confirmCalls.push(msg);
					let resolve;
					const promise = new Promise((r) => { resolve = r; });
					window.__confirmDeferred = { resolve };
					return promise;
				};
			});

			// 點擊 helper.tex 切換，觸發非同步確認
			const helperFileRow = page.locator('aside.files button.file-row', { hasText: 'helper.tex' });
			await helperFileRow.click();
			await waitForCondition(async () => {
				const count = await page.evaluate(() => window.__confirmCalls.length);
				return count === 1;
			});

			// 尚未解析時，原草稿必須完整保留
			let currentText = await cmContent.textContent();
			assert.ok(currentText.includes('% Deferred test draft'));

			// 解析為 false（取消）
			await page.evaluate(() => window.__confirmDeferred.resolve(false));
			await new Promise((r) => setTimeout(r, 100));
			currentText = await cmContent.textContent();
			assert.ok(currentText.includes('% Deferred test draft'), 'Deferred false must preserve edits');

			// 再次點擊 helper.tex 並解析為 true（接受）
			await helperFileRow.click();
			await waitForCondition(async () => {
				const count = await page.evaluate(() => window.__confirmCalls.length);
				return count === 2;
			});
			await page.evaluate(() => window.__confirmDeferred.resolve(true));

			await ensureSourceMode();
			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes('Helper secondary content');
			});
		});

		// 2. rejected permission: 模擬 Tauri ACL 拒絕 (dialog|message not allowed by ACL)
		await t.test('rejected permission fails closed preserving edits and gives clear feedback', async () => {
			await setupIsolatedWorkbench();

			const sensitiveMarker = '% Critical unsaved research notes 12345';
			await cmContent.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText('\n' + sensitiveMarker);

			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return text.includes('未儲存') || text.includes('Unsaved');
			});

			// 模擬 Tauri ACL 拒絕
			await page.evaluate(() => {
				window.confirm = async () => {
					throw new Error('dialog|message not allowed by ACL');
				};
			});

			await clickFileAction(page, /^(新增文件|New document)$/);

			// 驗證出現明確使用者回饋橫幅
			const errorStrip = page.locator('.error-strip[role="alert"]');
			await errorStrip.waitFor({ state: 'visible' });
			const errorText = await errorStrip.textContent();
			assert.ok(
				errorText.includes('無法確認是否捨棄變更') || errorText.includes('Unable to confirm discarding changes'),
				'Must show clear failure notice'
			);

			// 驗證 fail-closed：草稿未被清除
			const currentText = await cmContent.textContent();
			assert.ok(currentText.includes(sensitiveMarker), 'Rejected permission must fail closed and preserve draft');

			// 關閉錯誤橫幅
			const closeErrorBtn = errorStrip.locator('button');
			await closeErrorBtn.click();
		});

		// 3. stale workspace/revision: 在等待確認期間狀態被變更，確認接受後不得損毀新狀態
		await t.test('stale workspace and revision protection while waiting', async () => {
			await setupIsolatedWorkbench();

			await cmContent.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText('\n% Original draft before confirm');

			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return text.includes('未儲存') || text.includes('Unsaved');
			});

			await page.evaluate(() => {
				window.__confirmCalls = [];
				window.confirm = () => {
					window.__confirmCalls.push(1);
					return new Promise((r) => { window.__resolveStaleConfirm = r; });
				};
			});

			await clickFileAction(page, /^(新增文件|New document)$/);

			await waitForCondition(async () => {
				const count = await page.evaluate(() => window.__confirmCalls.length);
				return count === 1;
			});

			// 在確認懸掛期間，使用者在編輯器中進一步輸入，使版本前進 (version / content stale)
			await cmContent.click();
			await page.keyboard.insertText(' [advanced edit]');

			// 現在解析確認為 true
			await page.evaluate(() => window.__resolveStaleConfirm(true));
			await new Promise((r) => setTimeout(r, 200));

			// 因為狀態已 stale，newDocument 必須放棄替換，原編輯內容不得丟失
			const currentText = await cmContent.textContent();
			assert.ok(currentText.includes('[advanced edit]'), 'Stale confirmation must not overwrite modified source');
			assert.ok(currentText.includes('% Original draft before confirm'), 'Original draft must remain intact');
		});

		// 4. rapid actions: 等待確認期間連點防護，禁止重複對話框或競爭替換
		await t.test('rapid actions double-action protection', async () => {
			await setupIsolatedWorkbench();

			await cmContent.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText('\n% Rapid action draft');

			await waitForCondition(async () => {
				const text = await page.locator('footer.status-bar').textContent();
				return text.includes('未儲存') || text.includes('Unsaved');
			});

			await page.evaluate(() => {
				window.__rapidCalls = 0;
				window.confirm = () => {
					window.__rapidCalls++;
					return new Promise((r) => { window.__resolveRapid = r; });
				};
			});

			await page.locator('details.file-menu > summary').click();
			const newDocButton = page.locator('details.file-menu').getByRole('button', { name: /^(新增文件|New document)$/ });
			// 連續快速點擊 3 次
			await newDocButton.evaluate(button => { button.click(); button.click(); button.click(); });

			const callCount = await page.evaluate(() => window.__rapidCalls);
			assert.equal(callCount, 1, 'Only one confirmation prompt must be issued during pending confirm');

			// 取消並確認草稿未受影響
			await page.evaluate(() => window.__resolveRapid(false));
			await new Promise((r) => setTimeout(r, 100));
			const currentText = await cmContent.textContent();
			assert.ok(currentText.includes('% Rapid action draft'), 'Edits must be preserved after cancelled rapid actions');
		});

		// 5. 瀏覽器 confirm 與模擬 desktop adapter；原生 Tauri E2E 另行驗收。
		await t.test('browser cancellation preserves Unicode draft on New document', async () => {
			await setupIsolatedWorkbench();

			// 恢復標準 browser confirm 行為
			await page.evaluate(() => {
				window.confirm = window.__nativeConfirm;
			});

			const unicodeDraft = '% ModuTeX E2E 中文測試 \ud840\udc00';
			await cmContent.click();
			await page.keyboard.press('Control+End');
			await page.keyboard.insertText('\n' + unicodeDraft + '\n');

			await waitForCondition(async () => {
				const text = await cmContent.textContent();
				return text.includes(unicodeDraft);
			});

			let confirmMessage = null;
			page.once('dialog', async (dialog) => {
				if (dialog.type() === 'confirm') confirmMessage = dialog.message();
				await dialog.dismiss();
			});

			await clickFileAction(page, /^(新增文件|New document)$/);

			await waitForCondition(() => confirmMessage !== null);
			assert.ok(
				confirmMessage.includes('尚未儲存') || confirmMessage.includes('not saved'),
				'Confirm dialog must show localized warning'
			);

			// 驗證取消後 Unicode 草稿完整存在
			await new Promise((r) => setTimeout(r, 150));
			const preservedContent = await cmContent.textContent();
			assert.ok(
				preservedContent.includes(unicodeDraft),
				'Cancelled replacement must preserve the entire edited Unicode draft'
			);
		});
	} catch (error) {
		const evidence = path.resolve(frontendRoot, '../../.verification-artifacts/tauri');
		await mkdir(evidence, { recursive: true });
		if (page) {
			await page.screenshot({ path: path.join(evidence, 'async-confirmation-browser-failure.png') }).catch(() => {});
			await writeFile(path.join(evidence, 'async-confirmation-browser-failure.json'), JSON.stringify({
				error: String(error), pageErrors: pageErrors.map(value => String(value)), consoleErrors,
				body: await page.locator('body').innerText().catch(() => '')
			}, null, 2));
		}
		throw error;
	} finally {
		if (page) await page.close().catch(() => {});
		if (context) await context.close().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		if (viteServer) await viteServer.close().catch(() => {});
	}
});
