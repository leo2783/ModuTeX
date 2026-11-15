import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { clickFileAction } from '../../../../tests/scripts/helpers/app-file-actions.mjs';

export const multicolumnFixture = String.raw`\documentclass{article}
\usepackage{multicol,listings}
\lstset{language=C++}
\begin{document}
\small
% Fill each column from top to bottom before starting the next one.
\begin{multicols*}{3}
\section{動態規劃}
\subsection{01 背包問題}
動態規劃的狀態是 \(dp[n][w]\)。

\begin{lstlisting}
int main() {
    return 0;
}
\end{lstlisting}

背包程式下方的段落。
\end{multicols*}
\end{document}`;

test('three-column source opens as editable headings, prose, formulas and a listing', { timeout: 60000 }, async () => {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
	let browser;
	try {
		await server.listen();
		browser = await chromium.launch({ headless: true, channel: process.env.MODUTEX_TEST_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : 'chromium') });
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
		await clickFileAction(page, /^(新增文件|New document)$/);
		await page.getByRole('button', { name: '原始碼', exact: true }).click();
		const source = page.locator('.source-view .source .cm-content');
		await source.click();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(multicolumnFixture);
		await page.getByRole('button', { name: '視覺化', exact: true }).click();
		const visual = page.locator('.visual .ProseMirror');
		await visual.getByRole('heading', { name: '動態規劃', exact: true }).waitFor({ timeout: 5000 });
		await visual.getByRole('heading', { name: '01 背包問題', exact: true }).waitFor();
		await visual.locator('.visual-math-inline').waitFor();
		await visual.getByText('背包程式下方的段落。', { exact: true }).waitFor();
		await visual.getByRole('button', { name: '編輯程式碼', exact: true }).click();
		const code = page.locator('.code-panel textarea');
		assert.match(await code.inputValue(), /return 0;/);
		await code.fill('int main() {\n    return 7;\n}');
		await page.locator('.code-panel').getByRole('button', { name: '套用', exact: true }).click();
		await page.getByRole('button', { name: '原始碼', exact: true }).click();
		const text = (await source.locator('.cm-line').allTextContents()).join('\n');
		assert.equal(text, multicolumnFixture.replace('return 0;', 'return 7;'));
		assert.deepEqual(errors, []);
	} finally {
		await browser?.close();
		await server.close();
	}
});
