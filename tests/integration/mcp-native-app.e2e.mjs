// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = resolve(import.meta.dirname, '../..');
const exe = resolve(root, process.env.MODUTEX_MCP_TEST_EXE ?? 'apps/desktop-tauri/target/release/modutex-mcp-rust-review.exe');
const stdioExe = resolve(root, process.env.MODUTEX_MCP_STDIO_EXE ?? 'apps/desktop-tauri/target/release/modutex-mcp-rust-review-stdio.exe');
assert.equal(dirname(exe), join(root, 'apps/desktop-tauri/target/release'));
assert.equal(basename(exe), 'modutex-mcp-rust-review.exe', 'Use the independent native test product');
const pwsh = process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe';
assert(process.env.MODUTEX_LLAMA_SERVER_EXE, 'Full native interoperability requires MODUTEX_LLAMA_SERVER_EXE');
assert(process.env.MODUTEX_INSPECTOR_CLI, 'Full native interoperability requires MODUTEX_INSPECTOR_CLI');

function run(command, args, options = {}) {
	return new Promise((done, reject) => {
		const env = { ...process.env, ...options.env };
		delete env.NODE_TEST_CONTEXT;
		const child = spawn(command, args, { cwd: root, windowsHide: true, ...options, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', (chunk) => {
			output = (output + chunk).slice(-32_768);
		});
		child.stderr.on('data', (chunk) => {
			output = (output + chunk).slice(-32_768);
		});
		child.once('error', reject);
		child.once('close', (code) => (code === 0 ? done(output) : reject(new Error(`${command} exited ${code}: ${output}`))));
	});
}
async function availablePort(candidates = [0]) {
	for (const candidate of candidates) {
		const socket = createServer();
		try {
			await new Promise((done, reject) => socket.once('error', reject).listen(candidate, '127.0.0.1', done));
			const port = socket.address().port;
			await new Promise((done) => socket.close(done));
			return port;
		} catch (error) {
			if (error.code !== 'EADDRINUSE') throw error;
		}
	}
	throw new Error('No test MCP port is available');
}

async function exerciseLlama(temporary, mcpPort, workspace, t) {
	const llama = process.env.MODUTEX_LLAMA_SERVER_EXE;
	const port = await availablePort();
	const models = join(temporary, 'empty-models');
	await mkdir(models);
	const config = join(temporary, 'mcp-servers.json');
	await writeFile(config, JSON.stringify({ mcpServers: { modutex: { command: stdioExe, args: [String(mcpPort)] } } }));
	const child = spawn(
		llama,
		['--host', '127.0.0.1', '--port', String(port), '--models-dir', models, '--no-models-autoload', '--mcp-servers-config', config],
		{ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
	);
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-8192);
	});
	try {
		let listed;
		for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
			assert.equal(child.exitCode, null, stderr);
			try {
				const response = await fetch(`http://127.0.0.1:${port}/tools`, { signal: AbortSignal.timeout(1000) });
				if (response.ok) {
					listed = await response.json();
					break;
				}
			} catch {}
			await delay(200);
		}
		assert(listed, 'llama.cpp must expose its actual MCP tool registry: ' + stderr);
		assert.match(JSON.stringify(listed), /get_editor_state/);
		const tools = Array.isArray(listed) ? listed : listed.tools;
		assert(Array.isArray(tools), 'llama.cpp tool list must contain tool descriptors');
		t.diagnostic('llama.cpp tools: ' + tools.map((item) => item.tool).join(', '));
		assert.equal(tools.filter((item) => item.type === 'mcp').length, 12);
		const tool = tools.find((item) => item.tool === 'modutex_get_editor_state');
		assert(tool, 'llama.cpp must discover the standard editor-state tool');
		const result = await fetch(`http://127.0.0.1:${port}/tools`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tool: tool.tool, params: {} }),
			signal: AbortSignal.timeout(10_000)
		});
		const body = await result.text();
		assert.equal(result.status, 200, body);
		assert(body.toLowerCase().includes(basename(workspace).toLowerCase()), 'llama.cpp must receive the real admitted workspace');
		t.diagnostic('llama.cpp official MCP client discovered tools and read the native workspace');
	} finally {
		if (child.exitCode === null && child.pid)
			await new Promise((done) =>
				execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, done)
			);
	}
}

async function exerciseInspector(temporary, mcpPort, workspace, t) {
	const cli = process.env.MODUTEX_INSPECTOR_CLI;
	const config = join(temporary, 'inspector-mcp.json');
	await writeFile(config, JSON.stringify({ mcpServers: { modutex: { command: stdioExe, args: [String(mcpPort)] } } }));
	const args = [cli, '--cli', '--config', config, '--server', 'modutex', '--client-config', join(temporary, 'inspector-client.json')];
	const listed = JSON.parse(await run(process.execPath, [...args, '--method', 'tools/list', '--strict']));
	assert.equal(listed.tools.length, 12);
	const output = await run(process.execPath, [
		...args,
		'--method',
		'tools/call',
		'--tool-name',
		'get_editor_state',
		'--tool-args-json',
		'{}'
	]);
	const result = JSON.parse(output);
	assert.notEqual(result.isError, true, output);
	assert(JSON.stringify(result).toLowerCase().includes(basename(workspace).toLowerCase()));
	t.diagnostic('Official MCP Inspector listed 12 tools with strict schema checks and read the native workspace');
}

async function exerciseCancellation(page, mcpPort, workspace, t) {
	const client = new Client({ name: 'ModuTeX cancellation integration test', version: '0.2.1' });
	const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
	const debuggerSession = await page.context().newCDPSession(page);
	let timer;
	try {
		await client.connect(transport, { timeout: 10_000 });
		await debuggerSession.send('Debugger.enable');
		const paused = new Promise((done) => debuggerSession.once('Debugger.paused', done));
		await debuggerSession.send('Debugger.pause');
		const pausedEvaluation = debuggerSession.send('Runtime.evaluate', { expression: 'void 0' });
		void pausedEvaluation.catch(() => {});
		await Promise.race([
			paused,
			delay(3000).then(() => {
				throw new Error('The test renderer did not pause');
			})
		]);
		const controller = new AbortController();
		const reason = new Error('MCP integration cancellation');
		const request = client.callTool({ name: 'get_editor_state', arguments: {} }, undefined, { signal: controller.signal, timeout: 10_000 });
		timer = setTimeout(() => controller.abort(reason), 100);
		await assert.rejects(request, (error) => error === reason || /abort|cancel/i.test(error.message));
		assert(controller.signal.aborted);
		await debuggerSession.send('Debugger.resume');
		await pausedEvaluation;
		await debuggerSession.send('Debugger.disable');
		const response = await client.callTool({ name: 'get_editor_state', arguments: {} }, undefined, { timeout: 10_000 });
		assert.notEqual(response.isError, true, JSON.stringify(response));
		assert(JSON.stringify(response).toLowerCase().includes(basename(workspace).toLowerCase()));
		t.diagnostic('Official SDK cancellation while the renderer is paused preserves subsequent native requests');
	} finally {
		clearTimeout(timer);
		await debuggerSession.send('Debugger.resume').catch(() => {});
		await debuggerSession.detach().catch(() => {});
		if (transport.sessionId) await transport.terminateSession().finally(() => client.close());
		else await client.close();
	}
}

test('real native App admits the owned workspace and serves official HTTP and stdio clients', { timeout: 180_000 }, async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), 'modutex-mcp-e2e-'));
	const workspace = join(temporary, 'MCP-' + randomUUID());
	await mkdir(workspace);
	await writeFile(join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nNative MCP 中文\n\\end{document}\n');
	const debugPort = await availablePort();
	const mcpPort = await availablePort([7317, 7318]);
	const errors = [];
	const app = spawn(exe, [], {
		cwd: root,
		windowsHide: true,
		stdio: ['ignore', 'ignore', 'pipe'],
		env: {
			...process.env,
			WEBVIEW2_USER_DATA_FOLDER: join(temporary, 'webview'),
			WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`
		}
	});
	let browser,
		page,
		stage = 'startup',
		enabled = false,
		opened = false,
		stderr = '';
	app.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-8192);
	});
	const receipt = {
		exe,
		sha256: createHash('sha256')
			.update(await readFile(exe))
			.digest('hex'),
		mcpPort
	};
	try {
		let ready = false;
		for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
			assert.equal(app.exitCode, null, stderr);
			try {
				ready = (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) })).ok;
			} catch {}
			if (ready) break;
			await delay(200);
		}
		assert(ready, 'The owned native WebView must start');
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
		page = browser.contexts()[0].pages()[0];
		page.on('pageerror', (error) => errors.push(error.message));
		stage = 'native folder selection';
		const selection = run(pwsh, [
			'-NoProfile',
			'-File',
			join(root, 'tests/scripts/helpers/select-owned-folder.ps1'),
			'-OwnedProcessId',
			String(app.pid),
			'-ExpectedExecutablePath',
			exe,
			'-FolderPath',
			workspace
		]);
		void selection.catch(() => {});
		await page.getByRole('button', { name: /^(開啟資料夾|Open folder)$/ }).click();
		await selection;
		opened = true;
		stage = 'enable MCP through settings';
		await page.getByRole('link', { name: /^(設定|Settings)$/ }).click();
		const settings = page.locator('.mcp-settings');
		assert.equal(
			await settings.getByRole('button', { name: /^(停用 MCP 服務|Disable MCP service)$/ }).count(),
			0,
			'The test product starts with MCP off'
		);
		await settings.locator('select').selectOption(String(mcpPort));
		await settings.getByRole('button', { name: /^(啟用 MCP 服務|Enable MCP service)$/ }).click();
		await settings.getByRole('button', { name: /^(停用 MCP 服務|Disable MCP service)$/ }).waitFor();
		enabled = true;
		assert.equal(await settings.getByRole('checkbox').isChecked(), false, 'Enabling MCP does not grant custom commands');
		await page.getByRole('link', { name: /^(工作台|Workbench)$/ }).click();
		stage = 'official SDK transports';
		const sdkOutput = await run(process.execPath, ['--test', 'tests/integration/mcp-standard-client.integration.mjs'], {
			env: {
				...process.env,
				MODUTEX_MCP_TEST_ROOT: workspace,
				MODUTEX_MCP_STDIO_EXE: stdioExe,
				MODUTEX_MCP_TEST_URL: `http://127.0.0.1:${mcpPort}/mcp`
			}
		});
		t.diagnostic(sdkOutput);
		assert.doesNotMatch(sdkOutput, /run\(\) is being called recursively|skipping running files/);
		assert.match(sdkOutput, /\btests 2\b/, 'Both official SDK transport tests must actually execute');
		stage = 'llama.cpp MCP interoperability';
		await exerciseLlama(temporary, mcpPort, workspace, t);
		stage = 'MCP Inspector interoperability';
		await exerciseInspector(temporary, mcpPort, workspace, t);
		stage = 'standard MCP cancellation';
		await exerciseCancellation(page, mcpPort, workspace, t);
		assert.deepEqual(errors, [], 'The native renderer has no uncaught errors');
		t.diagnostic(JSON.stringify({ ...receipt, officialSdk: 'passed', workspaceSelection: 'real native dialog' }));
	} catch (error) {
		if (page)
			t.diagnostic(
				await page
					.locator('body')
					.innerText({ timeout: 3000 })
					.catch(() => 'No renderer snapshot available')
			);
		error.message = `${stage}: ${error.message}; native stderr: ${stderr}`;
		throw error;
	} finally {
		if (page && enabled) {
			await page
				.getByRole('link', { name: /^(設定|Settings)$/ })
				.click()
				.catch(() => {});
			await page
				.locator('.mcp-settings')
				.getByRole('button', { name: /^(停用 MCP 服務|Disable MCP service)$/ })
				.click()
				.catch(() => {});
		}
		if (page && opened) {
			await page
				.getByRole('link', { name: /^(首頁|Home)$/ })
				.click()
				.catch(() => {});
			const ownRecent = page.locator('.recent-row').filter({ hasText: basename(workspace) });
			if ((await ownRecent.count()) === 1)
				await ownRecent
					.locator('.recent-remove')
					.click()
					.catch(() => {});
		}
		if (app.exitCode === null && app.pid)
			await new Promise((done) =>
				execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, done)
			);
		await browser?.close().catch(() => {});
		assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
		assert(basename(temporary).startsWith('modutex-mcp-e2e-'));
		await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
