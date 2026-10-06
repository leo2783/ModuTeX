import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(resolve(repo, path), 'utf8');
const readBytes = (path) => readFileSync(resolve(repo, path));
const withoutComments = (source) =>
	source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

test('Electron package metadata uses one ModuTeX identity', () => {
	const builder = read('electron-builder.yml');
	assert.match(builder, /^appId: io\.github\.leo2783\.modutex$/m);
	assert.match(builder, /^productName: ModuTeX$/m);
	assert.match(builder, /^copyright: Copyright © ModuTeX$/m);
	assert.match(builder, /^\s*artifactName: \$\{productName\}-Setup-\$\{version\}\.\$\{ext\}$/m);
	assert.doesNotMatch(builder, /^(?:appId|productName|copyright):.*texpile/im);
	assert.doesNotMatch(builder, /^\s*artifactName:.*texpile/im);
	assert.doesNotMatch(builder, /(?:updates|dl)\.texpile\.com/i);
});

test('runtime name, window title, and userData namespace use ModuTeX', () => {
	const main = read('electron/src/main.ts');
	assert.match(main, /const dataDirName = devChannel \? 'modutex-desktop-dev' : 'modutex-desktop';/);
	assert.match(main, /app\.setName\(devChannel \? 'ModuTeX Dev' : 'ModuTeX'\);/);
	assert.match(main, /title: 'ModuTeX'/);
});

test('packaging icons are the reviewed ModuTeX asset set', () => {
	const icons = {
		'build/icons/16x16.png': '93624b3fa55440964d9ba71f0ea785df74e55906bddc8a153d6cd8af47e8f645',
		'build/icons/32x32.png': '2f1dfc72b9217ba6e4c3984e6f2342e066759c93244e34dc3885a7bbbdce4ed0',
		'build/icons/48x48.png': '2f850fd648fb82ab1bc34cfd6b7c69e6bec539d1cc099dfdb00e66f4b308c83d',
		'build/icons/64x64.png': '8cb119a3207ca1df94a81ad940bdaec9a34116bb63050bd1beafd0a49745e7ef',
		'build/icons/128x128.png': '97ac0c8ed9ed67cabbf40815922a7c03c79c84d4a3e570b56a8134bcce85fd10',
		'build/icons/256x256.png': '86fdb0bbfecdaa2a511d936782e2423af2fcdc9c3f962a330d713c5525acb23d',
		'build/icons/512x512.png': '5f692d890d1d3d8bacaa21ec475a0810cdf991acba7ad13de020d86be6027aba',
		'electron/icon.png': 'd1aaee71df383f7a8befcc1aa55e0373ddb8809dd9969ee73dff72f07713b02d'
	};
	for (const [path, expected] of Object.entries(icons)) {
		assert.equal(createHash('sha256').update(readBytes(path)).digest('hex'), expected, path);
	}
});

test('MCP server and user-visible tool metadata identify ModuTeX', () => {
	const server = withoutComments(read('electron/src/mcp/server.ts'));
	assert.match(server, /new McpServer\(\{ name: 'modutex', version: '1' \}/);
	assert.match(server, /ModuTeX is a local, offline LaTeX editor/);
	assert.match(server, /Get ModuTeX editor state/);
	assert.match(server, /Open a file in ModuTeX/);
	assert.match(server, /Show a file diff in ModuTeX/);
	assert.match(server, /Set the ModuTeX view mode/);
	assert.doesNotMatch(server, /Texpile/);
});

test('renderer identity strings and MCP setup are ModuTeX', () => {
	const visibleSources = [
		'apps/texpile-editor/src/views/StartView.svelte',
		'apps/texpile-editor/src/views/WorkspaceView.svelte',
		'apps/texpile-editor/src/lib/editor/comp/PreferencesDialog.svelte',
		'apps/texpile-editor/src/lib/editor/comp/WorkspaceMenuBar.svelte',
		'apps/texpile-editor/src/lib/workspace/synctex.ts'
	];
	for (const path of visibleSources) {
		assert.doesNotMatch(withoutComments(read(path)), /Texpile/, path);
	}

	const setup = read('apps/texpile-editor/src/lib/editor/comp/McpSetupModal.svelte');
	assert.match(setup, /claude mcp add --transport http modutex/);
	assert.match(setup, /\[mcp_servers\.modutex\]/);
	assert.doesNotMatch(setup, /mcp (?:add|servers\.)[^\n]*texpile/i);
});

test('native menus, title chrome, runtime errors, and starters identify ModuTeX', () => {
	const nativeMenu = read('apps/texpile-editor/src/lib/workspace/nativeMenu.ts');
	const windowChrome = read('electron/src/window-chrome.ts');
	const titleBar = read('apps/texpile-editor/src/lib/editor/comp/chrome/TitleBar.svelte');
	const fileSystem = read('apps/texpile-editor/src/lib/workspace/fileSystem.ts');
	const git = read('apps/texpile-editor/src/lib/workspace/git.ts');
	assert.match(nativeMenu, /const APP = 'ModuTeX';/);
	assert.doesNotMatch(nativeMenu, /const APP = 'Texpile';/);
	assert.doesNotMatch(nativeMenu, /m\.menubar_(?:documentation|join_discord|contact_support)\(\)/);
	assert.doesNotMatch(windowChrome, /help:(?:docs|discord|support)/);
	assert.match(titleBar, /let title = \$state\('ModuTeX'\);/);
	assert.doesNotMatch(withoutComments(fileSystem), /requires the Texpile desktop app/);
	assert.doesNotMatch(withoutComments(git), /requires the Texpile desktop app/);

	for (const path of [
		'apps/texpile-editor/src/lib/workspace/starters/article/main.tex',
		'apps/texpile-editor/src/lib/workspace/starters/apa/main.tex',
		'apps/texpile-editor/src/lib/workspace/starters/mla/main.tex',
		'apps/texpile-editor/src/lib/workspace/starters/tutorial/main.tex',
		'apps/texpile-editor/src/lib/workspace/starters/tutorial/math-and-figures.tex'
	]) {
		assert.doesNotMatch(read(path), /Texpile/, path);
	}
});

test('issue-owned production URLs and emails follow the exact allowlist', () => {
	const allowlist = {
		'electron-builder.yml': [],
		'apps/texpile-editor/src/lib/editor/comp/PreferencesDialog.svelte': [
			'https://github.com/leo2783/latex/blob/main/docs/INSTALLATION.md',
			'https://github.com/leo2783/latex/issues/new?title='
		],
		'apps/texpile-editor/src/lib/editor/comp/WorkspaceMenuBar.svelte': [],
		'apps/texpile-editor/src/lib/workspace/starters/tutorial/main.tex': [
			'https://github.com/leo2783/latex',
			'https://miktex.org/',
			'https://tug.org/texlive/'
		]
	};
	const endpointPattern = /(?:https?|wss):\/\/[A-Za-z0-9.-]+[^\s'"`)}<>$]*/g;
	const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

	for (const [path, expectedEndpoints] of Object.entries(allowlist)) {
		const source = withoutComments(read(path));
		const endpoints = [...new Set(source.match(endpointPattern) ?? [])].sort();
		const emails = [...new Set(source.match(emailPattern) ?? [])].sort();
		assert.deepEqual(endpoints, expectedEndpoints.toSorted(), `${path} outbound endpoints`);
		assert.deepEqual(emails, [], `${path} outbound email addresses`);
	}
});
