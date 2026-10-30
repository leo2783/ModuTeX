// SPDX-License-Identifier: Apache-2.0
// Run against an owned, enabled native App with a disposable workspace open.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const requiredTools = [
	'get_editor_state',
	'get_unsaved',
	'get_diagnostics',
	'open_file',
	'show_diff',
	'set_view_mode',
	'synctex_to_line',
	'set_main_file',
	'compile',
	'get_compile_config',
	'set_output_paths',
	'set_compile_command'
].sort();
const appRoot = process.env.MODUTEX_MCP_TEST_ROOT;
const endpoint = new URL(process.env.MODUTEX_MCP_TEST_URL ?? 'http://127.0.0.1:7317/mcp');
assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(endpoint.protocol, 'http:');
assert(['7317', '7318'].includes(endpoint.port));
assert.equal(endpoint.pathname, '/mcp');
assert(appRoot, 'MODUTEX_MCP_TEST_ROOT must name the disposable native test workspace');
const stdioExe = resolve(process.env.MODUTEX_MCP_STDIO_EXE ?? 'apps/desktop-tauri/target/release/modutex-mcp-stdio.exe');

function textPayload(result) {
	const texts = result.content.filter((item) => item.type === 'text').map((item) => item.text);
	assert.equal(texts.length, 1, 'host must return one bounded JSON result');
	return JSON.parse(texts[0]);
}
function samePath(left, right) {
	return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
async function exercise(transport, diagnostic) {
	const client = new Client({ name: 'ModuTeX native integration test', version: '0.2.1' }, { capabilities: {} });
	try {
		await client.connect(transport, { timeout: 10000 });
		assert(client.getServerVersion()?.name, 'standard initialization must negotiate a server identity');
		const listed = await client.listTools(undefined, { timeout: 10000 });
		assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), requiredTools);
		for (const tool of listed.tools) {
			assert.equal(tool.inputSchema.type, 'object');
			for (const privateKey of ['owner', 'generation', 'ownerGeneration']) {
				assert.equal(
					Object.hasOwn(tool.inputSchema.properties ?? {}, privateKey),
					false,
					'standard clients cannot be required to supply host-private identity'
				);
			}
		}
		const snapshotResult = await client.callTool({ name: 'get_editor_state', arguments: {} }, undefined, { timeout: 10000 });
		assert.notEqual(snapshotResult.isError, true, JSON.stringify(snapshotResult));
		const snapshot = textPayload(snapshotResult);
		assert(Array.isArray(snapshot.workspaces));
		assert(
			snapshot.workspaces.some((workspace) => samePath(workspace.root, appRoot)),
			'native App must expose the owned test workspace'
		);
		const args = { root: appRoot };
		const opened = await client.callTool({ name: 'open_file', arguments: { ...args, path: 'main.tex' } }, undefined, { timeout: 10000 });
		assert.notEqual(opened.isError, true, JSON.stringify(opened));
		const openedState = await client.callTool({ name: 'get_editor_state', arguments: {} }, undefined, { timeout: 10000 });
		assert.notEqual(openedState.isError, true, JSON.stringify(openedState));
		assert.match(JSON.stringify(textPayload(openedState)), /main\.tex/, 'Opening a file must change the real editor state');
		for (const name of ['get_unsaved', 'get_diagnostics', 'get_compile_config']) {
			const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			const payload = textPayload(result);
			if (name === 'get_compile_config') assert.equal(payload.canSetCommand, false, 'MCP custom commands remain disabled by default');
		}
		const denied = await client.callTool(
			{
				name: 'set_compile_command',
				arguments: { root: appRoot, command: 'modutex-denied-test-command {main}' }
			},
			undefined,
			{ timeout: 10000 }
		);
		assert.equal(denied.isError, true, 'standard client cannot grant its own execution permission');
		assert.equal(textPayload(denied).code, 'PERMISSION_DENIED');
		const invalid = await client.callTool({ name: 'open_file', arguments: { root: appRoot, path: '../outside.tex' } }, undefined, {
			timeout: 10000
		});
		assert.equal(invalid.isError, true, 'path traversal must fail across the real transport');
		assert.equal(textPayload(invalid).code, 'INVALID_INPUT');
		diagnostic(
			JSON.stringify({ server: client.getServerVersion(), toolCount: listed.tools.length, permissionDenied: true, traversalDenied: true })
		);
		return transport instanceof StdioClientTransport ? transport.pid : null;
	} finally {
		if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
			await transport.terminateSession().finally(() => client.close());
		} else {
			await client.close();
		}
	}
}

test('official SDK initializes, lists and calls the actual native App over Streamable HTTP', { timeout: 45000 }, async (t) => {
	await exercise(new StreamableHTTPClientTransport(endpoint), (value) => t.diagnostic(value));
});

test('official SDK stdio reconnects to the same native App after its child exits', { timeout: 90000 }, async (t) => {
	await access(stdioExe);
	for (let attempt = 0; attempt < 2; attempt++) {
		const transport = new StdioClientTransport({ command: stdioExe, args: [endpoint.port], stderr: 'pipe' });
		let stderr = '';
		transport.stderr?.on('data', (chunk) => {
			stderr = (stderr + chunk).slice(-8192);
		});
		const pid = await exercise(transport, (value) => t.diagnostic(value)).catch((error) => {
			error.message += `\nstdio diagnostics: ${stderr}`;
			throw error;
		});
		assert(Number.isInteger(pid), 'capture the actual SDK-owned child process');
		assert.throws(
			() => process.kill(pid, 0),
			(error) => error.code === 'ESRCH',
			'the owned stdio child must exit after SDK close'
		);
	}
});
