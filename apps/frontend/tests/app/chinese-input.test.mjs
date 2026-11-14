import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('real MathLive keeps newly entered Chinese fraction labels as text without rewriting source LaTeX', { timeout: 60000 }, async () => {
	const server = await createServer({
		root: fileURLToPath(new URL('../../', import.meta.url)),
		cacheDir: fileURLToPath(new URL('../../../../.verification-artifacts/vite-math-chinese-input', import.meta.url)),
		server: { host: '127.0.0.1', port: 0 },
		plugins: [{ name: 'math-chinese-input-fixture', configureServer(instance) {
			instance.middlewares.use('/__math_chinese_input', (_request, response) => {
				response.setHeader('Content-Type', 'text/html');
				response.end('<!doctype html><html lang="zh-Hant"><div id="host"></div><script type="module">import {createMathField} from "/src/features/math/field.ts";const field=createMathField(document.getElementById("host"));field.smartMode=false;</script>');
			});
		} }]
	});
	let browser;
	try {
		await server.listen();
		browser = await chromium.launch({ channel: process.env.MODUTEX_TEST_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--disable-gpu'] });
		const page = await browser.newPage();
		page.setDefaultTimeout(10000);
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		const address = server.httpServer.address();
		assert.ok(address && typeof address === 'object');
		await page.goto(`http://127.0.0.1:${address.port}/__math_chinese_input`);
		await page.waitForFunction(() => document.querySelector('math-field')?.shadowRoot?.querySelector('[part="keyboard-sink"]'));
		const field = page.locator('math-field').first();
		async function prepareInput(target, value, position) {
			await target.locator('[part="keyboard-sink"]').waitFor({ state: 'attached' });
			await target.click();
			await target.evaluate((input, options) => {
				input.setValue(options.value, { mode: 'math' });
				input.selection = { ranges: [[options.position, options.position]] };
				input.focus();
			}, { value, position });
			await target.locator('[part="keyboard-sink"]').focus();
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			assert.deepEqual(await target.evaluate(input => ({
				value: input.value, selection: input.selection.ranges,
				focused: document.activeElement === input && input.shadowRoot.activeElement === input.shadowRoot.querySelector('[part="keyboard-sink"]')
			})), { value, selection: [[position, position]], focused: true }, 'fixture must own the intended focused insertion point before typing');
		}
		async function reset(value, position = 1) {
			await page.evaluate(async () => {
				const { createMathField, disposeMathField } = await import('/src/features/math/field.ts');
				disposeMathField(document.querySelector('math-field'));
				const input = createMathField(document.querySelector('#host'));
				input.smartMode = false;
			});
			await prepareInput(field, value, position);
		}
		const value = () => field.evaluate(element => (element).value);
		await reset('\\frac{}{2}');
		await page.keyboard.insertText('中文');
		assert.equal(await value(), '\\frac{\\text{中文}{}}{2}');
		await page.keyboard.type('+x');
		assert.equal(await value(), '\\frac{\\text{中文}{}+x}{2}');

		await reset('\\frac{1}{}', 3);
		await page.keyboard.insertText('總量A');
		assert.equal(await value(), '\\frac{1}{\\text{總量}A}');
		await field.evaluate(element => (element).executeCommand('undo'));
		assert.equal(await value(), '\\frac{1}{}');
		await field.evaluate(element => (element).executeCommand('redo'));
		assert.equal(await value(), '\\frac{1}{\\text{總量}A}');

		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const sink = element.shadowRoot.querySelector('[part="keyboard-sink"]');
			// Exercise MathLive's real composition handlers. This is a synthesized
			// event sequence, not evidence of physical Windows IME acceptance.
			for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
				sink.dispatchEvent(new CompositionEvent(type, { data: type === 'compositionstart' ? '' : '平均值B', bubbles: true, composed: true }));
			}
		});
		assert.equal(await value(), '\\frac{\\text{平均值}B}{2}');
		await field.evaluate(element => (element).executeCommand('undo'));
		assert.equal(await value(), '\\frac{}{2}');
		await field.evaluate(element => (element).executeCommand('redo'));
		assert.equal(await value(), '\\frac{\\text{平均值}B}{2}');

		await reset('\\frac{}{2}');
		await page.keyboard.insertText('中文，A😀');
		assert.equal(await value(), '\\frac{\\text{中文，}A😀}{2}');
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const boxes = await field.evaluate(element => [...element.shadowRoot.querySelectorAll('span')]
			.filter(span => span.childElementCount === 0 && /[中文]/u.test(span.textContent ?? ''))
			.map(span => ({ width: span.getBoundingClientRect().width, height: span.getBoundingClientRect().height })));
		assert.ok(boxes.length >= 1 && boxes.every(box => box.width > 0 && box.height > 0));
		await field.screenshot({ path: fileURLToPath(new URL('../../../../.verification-artifacts/code-pagination-031/math-chinese-input.png', import.meta.url)) });

		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const sink = element.shadowRoot.querySelector('[part="keyboard-sink"]');
			for (const data of ['中', '文', 'A']) sink.dispatchEvent(new InputEvent('beforeinput', {
				data, inputType: 'insertText', bubbles: true, composed: true, cancelable: true
			}));
		});
		assert.equal(await value(), '\\frac{\\text{中文}A}{2}');
		await reset('\\frac{12}{2}', 1);
		await field.evaluate(element => { (element).selection = { ranges: [[1, 3]] }; });
		await page.keyboard.insertText('中文');
		assert.equal(await value(), '\\frac{\\text{中文}{}}{2}');
		await field.evaluate(element => (element).executeCommand('undo'));
		assert.equal(await value(), '\\frac{12}{2}');

		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const sink = element.shadowRoot.querySelector('[part="keyboard-sink"]');
			sink.dispatchEvent(new InputEvent('beforeinput', { data: '中文', inputType: 'insertText', bubbles: true, composed: true, cancelable: true }));
			(element).selection = { ranges: [[0, 0]] };
		});
		assert.equal(await value(), '\\frac{}{2}', 'queued input cannot write through a changed selection');
		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '中文');
			element.shadowRoot.querySelector('[part="keyboard-sink"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true }));
		});
		assert.equal(await value(), '\\frac{\\text{中文}{}}{2}');
		await field.evaluate(element => (element).executeCommand('undo'));
		assert.equal(await value(), '\\frac{}{2}');
		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const input = element; input.readOnly = true;
			const sink = input.shadowRoot.querySelector('[part="keyboard-sink"]');
			sink.dispatchEvent(new InputEvent('beforeinput', { data: '中文', inputType: 'insertText', bubbles: true, composed: true, cancelable: true }));
			input.readOnly = false;
		});
		assert.equal(await value(), '\\frac{}{2}');
		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const sink = element.shadowRoot.querySelector('[part="keyboard-sink"]');
			sink.dispatchEvent(new InputEvent('beforeinput', { data: '中文', inputType: 'insertText', bubbles: true, composed: true, cancelable: true }));
			window.removedMathField = element;
			element.remove();
		});
		await page.evaluate(() => document.querySelector('#host').append(window.removedMathField));
		assert.equal(await value(), '\\frac{}{2}');

		// Compare excluded keystrokes and plain-text paste with an unmodified
		// registered MathLive element, so reserved characters retain native meaning.
		for (const literal of ['中文%', '中文{}', '中文&', '中文^', '中文_', '中文\\custom{字}']) {
			for (const paste of [false, true]) {
				await reset('\\frac{}{2}');
				const enter = async (target) => {
					if (!paste) await page.keyboard.insertText(literal);
					else await target.evaluate((element, text) => {
						const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
						element.shadowRoot.querySelector('[part="keyboard-sink"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true }));
					}, literal);
				};
				await enter(field);
				const actual = await value();
				await page.evaluate(() => {
					const input = document.createElement('math-field'); input.id = 'math-baseline'; document.body.append(input);
					input.smartMode = false;
				});
				const baseline = page.locator('#math-baseline');
				await prepareInput(baseline, '\\frac{}{2}', 1);
				await enter(baseline);
				assert.equal(actual, await baseline.evaluate(element => (element).value), `${paste ? 'paste' : 'type'} ${literal}`);
				await baseline.evaluate(element => element.remove());
			}
		}
		await reset('\\frac{}{2}');
		await field.evaluate(element => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', '中文');
			clipboardData.setData('application/x-latex', '\\frac{中文}{總量}');
			element.shadowRoot.querySelector('[part="keyboard-sink"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, composed: true, cancelable: true }));
		});
		assert.equal(await value(), '\\frac{\\frac{中文}{總量}}{2}', 'explicit LaTeX clipboard data remains authoritative and literal');

		await reset('\\frac{\\text{中文}}{2}', 3);
		await field.evaluate(element => (element).executeCommand(['switchMode', 'text']));
		await page.keyboard.insertText('字');
		assert.equal(await value(), '\\frac{\\text{中文字}}{2}');
		for (const literal of ['\\frac{中文}{總量}', '\\operatorname{中文}(x)', '\\custom{中文}', '\\frac{\\text{中文}}{\\text{總量}}']) {
			await field.evaluate((element, latex) => {
				const input = element;
				input.executeCommand(['switchMode', 'math']);
				input.setValue(latex, { silenceNotifications: true, mode: 'math' });
			}, literal);
			assert.equal(await value(), literal);
		}
		assert.deepEqual(errors, []);
	} finally {
		await browser?.close();
		await server.close();
	}
});
