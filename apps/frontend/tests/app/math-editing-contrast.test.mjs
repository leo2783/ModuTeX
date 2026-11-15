import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('inline fraction caret and selection remain legible in pinned light and dark themes', { timeout: 60000 }, async () => {
	const server = await createServer({
		root: fileURLToPath(new URL('../../', import.meta.url)),
		cacheDir: fileURLToPath(new URL('../../../../.verification-artifacts/vite-math-contrast', import.meta.url)),
		server: { host: '127.0.0.1', port: 0 },
		plugins: [{ name: 'math-contrast-fixture', configureServer(instance) {
			instance.middlewares.use('/__math_contrast', (_request, response) => {
				response.setHeader('Content-Type', 'text/html; charset=utf-8');
				response.end('<!doctype html><html lang="zh-Hant"><style>.sample{margin:120px 48px;width:440px;font-size:16px}.sample p{margin:0}</style><div class="sample"><p>平均值 <span id="draft" class="inline-equation-draft is-inline"></span> 是每一項的平均。</p></div><script type="module">import "/src/styles/base.css";import {editInlineEquation} from "/src/features/math/inline.ts";editInlineEquation(document.getElementById("draft"),{latex:"\\\\frac{\\\\sum}{2}",inline:true},(zh)=>zh,()=>{},()=>{});</script>');
			});
		} }]
	});
	let browser;
	try {
		await server.listen();
		browser = await chromium.launch({ channel: process.env.MODUTEX_TEST_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--disable-gpu'] });
		const address = server.httpServer.address();
		assert.ok(address && typeof address === 'object');
		for (const theme of ['light', 'dark']) {
			// The app's explicit theme must win over an opposite OS preference.
			const page = await browser.newPage({ viewport: { width: 900, height: 360 }, colorScheme: theme === 'light' ? 'dark' : 'light' });
			try {
				await page.goto(`http://127.0.0.1:${address.port}/__math_contrast`);
				await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
				const field = page.locator('math-field');
				await field.locator('[part="keyboard-sink"]').waitFor({ state: 'attached' });
				await field.click();
				for (const glyph of ['∑', '2']) {
					const point = await field.evaluate((element, text) => {
						const span = [...element.shadowRoot.querySelectorAll('span')].find(node => node.childElementCount === 0 && node.textContent === text && node.getBoundingClientRect().width > 0);
						if (!span) throw new Error(`Missing visible fraction glyph: ${text}`);
						const rect = span.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
					}, glyph);
					await page.mouse.click(point.x, point.y);
					await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
					await page.screenshot({ path: fileURLToPath(new URL(`../../../../.verification-artifacts/code-pagination-031/math-focus-${theme}-${glyph === '2' ? 'denominator' : 'numerator'}.png`, import.meta.url)) });
					const state = await field.evaluate(element => {
						const root = element.shadowRoot;
						const caret = root.querySelector('.ML__caret');
						return { focused: document.activeElement === element, caret: !!caret && caret.getBoundingClientRect().height > 0,
							highlights: [...root.querySelectorAll('.ML__contains-highlight')].map(node => getComputedStyle(node).backgroundColor) };
					});
					assert.equal(state.focused, true);
					assert.equal(state.caret, true);
					assert.ok(state.highlights.every(color => color === 'rgba(0, 0, 0, 0)'), 'caret context must not gray out the fraction');
				}
				await page.keyboard.press('Control+A');
				await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
				await page.screenshot({ path: fileURLToPath(new URL(`../../../../.verification-artifacts/code-pagination-031/math-selection-${theme}.png`, import.meta.url)) });
				const selection = await field.evaluate(element => ({
					ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
					colors: [...element.shadowRoot.querySelectorAll('.ML__selected')].map(node => getComputedStyle(node).color),
					selected: !element.selectionIsCollapsed
				}));
				assert.equal(selection.selected, true);
				assert.ok(selection.colors.length > 0);
				const expected = theme === 'light' ? 'rgb(36, 41, 46)' : 'rgb(232, 235, 237)';
				assert.ok(selection.colors.every(color => color === expected), 'selected fraction text must follow the explicit app theme');
			} finally { await page.close(); }
		}
	} finally { await browser?.close(); await server.close(); }
});
