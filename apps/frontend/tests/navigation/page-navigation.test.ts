import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { helpTopics, helpTopic, type HelpTopic } from '../../src/features/help/topics.ts';
import { templateOptions, createDraft } from '../../src/features/files/templates.ts';
import { releaseNotes } from '../../src/features/release-notes/content.ts';
import type { Language } from '../../src/i18n/text.ts';

type DOMWindow = Window & typeof globalThis & { close(): void };

const require = createRequire(import.meta.url);
const { JSDOM }: {
	JSDOM: new (
		html?: string,
		options?: { url?: string; storageQuota?: number }
	) => {
		window: DOMWindow;
	};
} = require('jsdom');

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const helpPath = fileURLToPath(new URL('../../src/pages/Help.svelte', import.meta.url)).replaceAll('\\', '/');
const releasePath = fileURLToPath(new URL('../../src/pages/ReleaseNotes.svelte', import.meta.url)).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;

type DomGlobalKey = Extract<keyof DOMWindow, keyof typeof globalThis>;

const explicitDomKeys: readonly DomGlobalKey[] = [
	'window',
	'document',
	'navigator',
	'location',
	'Node',
	'Element',
	'HTMLElement',
	'Document',
	'DocumentFragment',
	'Text',
	'Comment',
	'CharacterData',
	'Attr',
	'HTMLInputElement',
	'HTMLSelectElement',
	'HTMLOptionElement',
	'HTMLButtonElement',
	'HTMLAnchorElement',
	'HTMLDivElement',
	'HTMLParagraphElement',
	'HTMLHeadingElement',
	'HTMLFormElement',
	'HTMLTextAreaElement',
	'HTMLSpanElement',
	'HTMLPreElement',
	'HTMLDetailsElement',
	'HTMLUListElement',
	'HTMLLIElement',
	'HTMLCanvasElement',
	'HTMLTemplateElement',
	'HTMLStyleElement',
	'HTMLLinkElement',
	'Event',
	'EventTarget',
	'CustomEvent',
	'KeyboardEvent',
	'MouseEvent',
	'StorageEvent',
	'BeforeUnloadEvent',
	'HashChangeEvent',
	'UIEvent',
	'MutationObserver',
	'Storage'
];

const previousDescriptors = new Map<DomGlobalKey, PropertyDescriptor | undefined>();

function restoreGlobals() {
	for (const [key, desc] of previousDescriptors) {
		try {
			if (desc === undefined) {
				Reflect.deleteProperty(globalThis, key);
			} else {
				Object.defineProperty(globalThis, key, desc);
			}
		} catch {
			// Ignore non-configurable globals
		}
	}
	previousDescriptors.clear();
}

test.after(() => {
	if (dom) {
		try {
			dom.window.close();
		} catch {
			// Ignore close errors
		}
		dom = null;
	}
	restoreGlobals();
	if (tempDir) {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore temp directory removal errors
		}
		tempDir = null;
	}
});

// 1. Build client entry exporting public Svelte APIs and genuine Svelte runes Harnesses
tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-page-nav-'));

const helpHarnessPath = path.join(tempDir, 'HelpHarness.svelte').replaceAll('\\', '/');
fs.writeFileSync(
	helpHarnessPath,
	`<script lang="ts">
	import Help from '${helpPath}';
	import type { HelpTopic } from '${frontendRoot}/src/features/help/topics.ts';
	import type { Language } from '${frontendRoot}/src/i18n/text.ts';

	let {
		initialTopic = 'getting-started',
		initialLocale = 'zh-Hant',
		bindHarness
	}: {
		initialTopic?: HelpTopic;
		initialLocale?: Language;
		bindHarness?: (api: {
			setTopic: (next: HelpTopic) => void;
			setLocale: (next: Language) => void;
			getTopic: () => HelpTopic;
			getLocale: () => Language;
		}) => void;
	} = $props();

	let topic = $state<HelpTopic>(initialTopic);
	let locale = $state<Language>(initialLocale);

	function setTopic(next: HelpTopic) {
		topic = next;
	}

	function setLocale(next: Language) {
		locale = next;
	}

	function getTopic(): HelpTopic {
		return topic;
	}

	function getLocale(): Language {
		return locale;
	}

	bindHarness?.({
		setTopic,
		setLocale,
		getTopic,
		getLocale
	});

	export { setTopic, setLocale, getTopic, getLocale };
</script>

<Help {topic} {locale} />
`
);

const releaseHarnessPath = path.join(tempDir, 'ReleaseHarness.svelte').replaceAll('\\', '/');
fs.writeFileSync(
	releaseHarnessPath,
	`<script lang="ts">
	import ReleaseNotes from '${releasePath}';
	import type { Language } from '${frontendRoot}/src/i18n/text.ts';

	let {
		initialLimitations = false,
		initialLocale = 'zh-Hant',
		bindHarness
	}: {
		initialLimitations?: boolean;
		initialLocale?: Language;
		bindHarness?: (api: {
			setLimitations: (next: boolean) => void;
			setLocale: (next: Language) => void;
			getLimitations: () => boolean;
			getLocale: () => Language;
		}) => void;
	} = $props();

	let showLimitations = $state<boolean>(initialLimitations);
	let locale = $state<Language>(initialLocale);

	function setLimitations(next: boolean) {
		showLimitations = next;
	}

	function setLocale(next: Language) {
		locale = next;
	}

	function getLimitations(): boolean {
		return showLimitations;
	}

	function getLocale(): Language {
		return locale;
	}

	bindHarness?.({
		setLimitations,
		setLocale,
		getLimitations,
		getLocale
	});

	export { setLimitations, setLocale, getLimitations, getLocale };
</script>

<ReleaseNotes {showLimitations} {locale} />
`
);

const entryFile = path.join(tempDir, 'entry.js');
fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import Help from '${helpPath}';
import ReleaseNotes from '${releasePath}';
import HelpHarness from '${helpHarnessPath}';
import ReleaseHarness from '${releaseHarnessPath}';

export { mount, unmount, flushSync, tick, Help, ReleaseNotes, HelpHarness, ReleaseHarness };
`
);

await build({
	configFile: false,
	root: frontendRoot,
	plugins: [svelte()],
	resolve: {
		conditions: ['browser', 'default']
	},
	build: {
		write: true,
		outDir: tempDir,
		emptyOutDir: false,
		lib: {
			entry: entryFile,
			formats: ['es'],
			fileName: () => 'page-client.mjs',
			cssFileName: 'page-client.css'
		},
		sourcemap: false,
		minify: false
	},
	logLevel: 'silent'
});

// 2. Set real JSDOM globals
dom = new JSDOM(
	'<!DOCTYPE html><html lang="zh-Hant"><body><div id="app"></div></body></html>',
	{ url: 'https://modutex.test/#/help/getting-started' }
);

for (const key of explicitDomKeys) {
	previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	if (key in dom.window) {
		const val = Reflect.get(dom.window, key);
		Object.defineProperty(globalThis, key, {
			value: val,
			writable: true,
			configurable: true
		});
	}
}

// Track and provide explicit JSDOM method stand-ins without claiming native geometry
if (!Reflect.has(dom.window.HTMLElement.prototype, 'scrollIntoView')) {
	Reflect.set(dom.window.HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {});
}
if (!Reflect.has(dom.window, 'requestAnimationFrame')) {
	Reflect.set(dom.window, 'requestAnimationFrame', (cb: (time: number) => void) =>
		dom!.window.setTimeout(() => cb(Date.now()), 0)
	);
	Reflect.set(dom.window, 'cancelAnimationFrame', (id: number) =>
		dom!.window.clearTimeout(id)
	);
}

// 3. Dynamically import the compiled client module
const bundleUrl = pathToFileURL(path.join(tempDir, 'page-client.mjs')).href;
const { mount, unmount, flushSync, HelpHarness, ReleaseHarness } = (await import(bundleUrl)) as {
	mount: <T, P extends Record<string, unknown>>(component: unknown, options: { target: HTMLElement; props?: P }) => T;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	HelpHarness: unknown;
	ReleaseHarness: unknown;
};

// -----------------------------------------------------------------------------
// Real Client Component Mount & Focus Behavior Tests (Vite Browser Build)
// -----------------------------------------------------------------------------

test('compiled Svelte CLIENT Help page: focus targets on click navigation and no focus stealing on mount or locale update', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app')!;
	container.innerHTML = '';

	let harnessApi!: {
		setTopic: (next: HelpTopic) => void;
		setLocale: (next: Language) => void;
		getTopic: () => HelpTopic;
		getLocale: () => Language;
	};

	const instance = mount(HelpHarness, {
		target: container,
		props: {
			initialTopic: 'getting-started',
			initialLocale: 'zh-Hant',
			bindHarness: (api: typeof harnessApi) => {
				harnessApi = api;
			}
		}
	});
	flushSync();

	try {
		assert.ok(harnessApi, 'Harness API must be bound from compiled HelpHarness');
		const heading = dom.window.document.querySelector('#help-heading') as HTMLHeadingElement;
		assert.ok(heading, 'Heading #help-heading must exist');
		assert.equal(heading.textContent, '開始使用');

		// 1. Initial mount must NOT steal focus to heading
		assert.notEqual(dom.window.document.activeElement, heading, 'Initial mount must not steal focus to heading');

		// 2. User focuses on an external input (representing editor or active control)
		const editorInput = dom.window.document.createElement('input');
		dom.window.document.body.appendChild(editorInput);
		editorInput.focus();
		assert.equal(dom.window.document.activeElement, editorInput, 'Active element must be the focused input');

		// 3. Locale update preserves focus and does NOT steal focus to heading
		harnessApi.setLocale('en');
		flushSync();
		assert.equal(heading.textContent, 'Getting started');
		assert.equal(dom.window.document.activeElement, editorInput, 'Locale update must preserve active focus without stealing to heading');

		// 4. Intentional user click on category navigation activates callback and focuses target heading
		const shortcutsLink = container.querySelector('nav a[href="#/help/shortcuts"]') as HTMLAnchorElement;
		assert.ok(shortcutsLink, 'Shortcuts navigation link must exist');
		shortcutsLink.click();
		harnessApi.setTopic('shortcuts');
		flushSync();
		assert.equal(dom.window.document.activeElement, heading, 'Clicking category navigation must move activeElement to target heading');
		assert.equal(heading.textContent, 'Shortcuts');

		// 5. Intentional route-prop update (e.g. hashchange navigation) moves focus to heading
		editorInput.focus();
		assert.equal(dom.window.document.activeElement, editorInput);
		harnessApi.setTopic('installation');
		flushSync();
		assert.equal(dom.window.document.activeElement, heading, 'Intentional route-prop update moves activeElement to target heading');
		assert.equal(heading.textContent, '0.1.0 installation guide');

		// 6. Switching locale back to zh-Hant preserves focus and updates heading text to Chinese
		editorInput.focus();
		assert.equal(dom.window.document.activeElement, editorInput);
		harnessApi.setLocale('zh-Hant');
		flushSync();
		assert.equal(dom.window.document.activeElement, editorInput, 'Locale switch back must preserve focus without stealing');
		assert.equal(heading.textContent, '0.1.0 安裝指南');

		editorInput.remove();
	} finally {
		await unmount(instance);
	}
});

test('compiled Svelte CLIENT ReleaseNotes page: focuses actual version section heading on selection and preserves focus on locale update', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app')!;
	container.innerHTML = '';

	let harnessApi!: {
		setLimitations: (next: boolean) => void;
		setLocale: (next: Language) => void;
		getLimitations: () => boolean;
		getLocale: () => Language;
	};

	const instance = mount(ReleaseHarness, {
		target: container,
		props: {
			initialLimitations: false,
			initialLocale: 'zh-Hant',
			bindHarness: (api: typeof harnessApi) => {
				harnessApi = api;
			}
		}
	});
	flushSync();

	try {
		assert.ok(harnessApi, 'Harness API must be bound from compiled ReleaseHarness');
		const mainHeading = dom.window.document.querySelector('#release-heading') as HTMLHeadingElement;
		const versionHeading = dom.window.document.querySelector('#version-heading') as HTMLHeadingElement;
		assert.ok(mainHeading, 'Main heading #release-heading must exist');
		assert.ok(versionHeading, 'Version section heading #version-heading must exist');

		// 1. Initial mount must NOT steal focus
		assert.notEqual(dom.window.document.activeElement, mainHeading, 'Initial mount must not steal focus to release heading');
		assert.notEqual(dom.window.document.activeElement, versionHeading, 'Initial mount must not steal focus to version heading');

		// 2. Focus external element
		const externalButton = dom.window.document.createElement('button');
		dom.window.document.body.appendChild(externalButton);
		externalButton.focus();
		assert.equal(dom.window.document.activeElement, externalButton);

		// 3. Locale update preserves focus without stealing
		harnessApi.setLocale('en');
		flushSync();
		assert.equal(mainHeading.textContent, 'Release notes');
		assert.equal(dom.window.document.activeElement, externalButton, 'Locale update must preserve active focus without stealing');

		// 4. Intentional version link click focuses actual version section heading
		const versionLinks = Array.from(container.querySelectorAll('aside .version-nav-link')) as HTMLAnchorElement[];
		assert.ok(versionLinks.length >= 2, 'Should have versions in aside index');
		versionLinks[0]?.click();
		flushSync();
		assert.equal(dom.window.document.activeElement, versionHeading, 'Selecting version must focus actual version section heading #version-heading');
		assert.equal(versionHeading.textContent?.trim(), '0.2.0');

		// 5. Selecting known limitations focuses main heading (via link click and route prop update)
		const limitationsLink = container.querySelector('aside a[href="#/release-notes/limitations"]') as HTMLAnchorElement;
		assert.ok(limitationsLink, 'Known limitations link must exist');
		externalButton.focus();
		assert.equal(dom.window.document.activeElement, externalButton);
		limitationsLink.click();
		flushSync();
		assert.equal(dom.window.document.activeElement, mainHeading, 'Selecting limitations link must focus #release-heading');

		// Intentional route-prop update to limitations focuses main heading
		externalButton.focus();
		assert.equal(dom.window.document.activeElement, externalButton);
		harnessApi.setLimitations(true);
		flushSync();
		assert.equal(dom.window.document.activeElement, mainHeading, 'Route update to limitations must focus #release-heading');
		assert.equal(mainHeading.textContent, '0.1.0 known limitations');

		// 6. Intentional route-prop update back to version notes focuses actual version section heading
		externalButton.focus();
		assert.equal(dom.window.document.activeElement, externalButton);
		harnessApi.setLimitations(false);
		flushSync();
		const updatedVersionHeading = dom.window.document.querySelector('#version-heading') as HTMLHeadingElement;
		assert.ok(updatedVersionHeading, 'Version heading must be present in notes view');
		assert.equal(dom.window.document.activeElement, updatedVersionHeading, 'Route update back to version notes must focus version section heading');
		assert.equal(updatedVersionHeading.textContent?.trim(), '0.2.0');

		externalButton.remove();
	} finally {
		await unmount(instance);
	}
});

// -----------------------------------------------------------------------------
// SSR Static Structure and Attributes Coverage (Not native viewport/keyboard proof)
// -----------------------------------------------------------------------------

test('compiled Svelte Home page SSR renders rendered structure, actions, and constrained documents (SSR attributes coverage)', { timeout: 20000 }, async () => {
	const server = await createServer({
		root: frontendRoot,
		server: { middlewareMode: true, hmr: false, ws: false },
		logLevel: 'error'
	});
	try {
		const homeModule = await server.ssrLoadModule('/src/pages/Home.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');

		// 1. Desktop mode with recent documents, active current document, and templates
		const desktopHtml = render(homeModule.default, {
			props: {
				desktop: true,
				busy: false,
				locale: 'zh-Hant',
				currentName: 'Thesis/main.tex',
				dirty: true,
				recent: [
					{ id: 'rec-1', label: 'Thesis', entryPath: 'chapters/intro-and-background.tex' },
					{ id: 'rec-2', label: 'Paper', entryPath: 'sections/methodology-extended.tex' }
				],
				onOpen: () => {},
				onCreate: () => {},
				onRecent: () => {},
				onRemoveRecent: () => {}
			}
		}).body;
		const domDesktop = new JSDOM(desktopHtml);
		try {
			const doc = domDesktop.window.document;
			assert.equal(doc.querySelector('main.home')?.getAttribute('aria-labelledby'), 'home-title');
			assert.equal(doc.querySelector('#home-title')?.textContent, '文件');

			const actionButtons = [...doc.querySelectorAll('.open-actions button')];
			assert.equal(actionButtons.length, 3);
			assert.ok(actionButtons.some((b) => b.textContent?.includes('開啟資料夾')));
			assert.ok(actionButtons.some((b) => b.textContent?.includes('開啟文件')));
			assert.ok(actionButtons.some((b) => b.textContent?.includes('新文件')));

			const currentLink = doc.querySelector('.current-document a');
			assert.ok(currentLink);
			assert.equal(currentLink.getAttribute('href'), '#/workbench');
			assert.match(currentLink.textContent || '', /Thesis\/main\.tex/);
			assert.match(currentLink.textContent || '', /未儲存/);

			const recentRows = [...doc.querySelectorAll('.recent-row')];
			assert.equal(recentRows.length, 2);
			const firstOpen = recentRows[0]?.querySelector('.recent-open');
			const firstRemove = recentRows[0]?.querySelector('.recent-remove');
			assert.ok(firstOpen?.getAttribute('aria-label')?.includes('Thesis / chapters/intro-and-background.tex'));
			assert.ok(firstRemove?.getAttribute('aria-label')?.includes('Thesis'));
			assert.equal(firstOpen?.querySelector('.recent-path')?.textContent, 'Thesis / chapters/intro-and-background.tex');

			const templateButtons = [...doc.querySelectorAll('.templates .template-button')];
			assert.equal(templateButtons.length, 3);
			assert.ok(templateButtons[0]?.textContent?.includes('空白文件'));
			assert.ok(templateButtons[1]?.textContent?.includes('文章'));
			assert.ok(templateButtons[2]?.textContent?.includes('報告'));

			const helpLinks = [...doc.querySelectorAll('.help-links a')];
			assert.equal(helpLinks.length, 2);
			assert.equal(helpLinks[0]?.getAttribute('href'), '#/help/getting-started');
			assert.equal(helpLinks[1]?.getAttribute('href'), '#/help/licenses');

			assert.equal(doc.querySelector('.browser-note'), null);
		} finally {
			domDesktop.window.close();
		}

		// 2. Browser mode (desktop: false) with busy state and clean state
		const browserHtml = render(homeModule.default, {
			props: {
				desktop: false,
				busy: true,
				locale: 'en',
				currentName: 'saved-article.tex',
				dirty: false,
				onOpen: () => {},
				onCreate: () => {}
			}
		}).body;
		const domBrowser = new JSDOM(browserHtml);
		try {
			const doc = domBrowser.window.document;
			assert.equal(doc.querySelector('#home-title')?.textContent, 'Documents');

			const actionButtons = [...doc.querySelectorAll('.open-actions button')];
			assert.equal(actionButtons.length, 2);
			assert.ok(!actionButtons.some((b) => b.textContent?.includes('folder')));

			for (const button of actionButtons) {
				assert.ok(button.hasAttribute('disabled'));
			}

			const currentLink = doc.querySelector('.current-document a');
			assert.match(currentLink?.textContent || '', /Back to workbench/);

			const browserNote = doc.querySelector('.browser-note');
			assert.ok(browserNote);
			assert.match(browserNote.textContent || '', /browser/i);
		} finally {
			domBrowser.window.close();
		}
	} finally {
		await server.close();
	}
});

test('compiled Svelte Help page SSR renders category navigation active semantics and code containers (SSR attributes coverage)', { timeout: 20000 }, async () => {
	const server = await createServer({
		root: frontendRoot,
		server: { middlewareMode: true, hmr: false, ws: false },
		logLevel: 'error'
	});
	try {
		const helpModule = await server.ssrLoadModule('/src/pages/Help.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');

		for (const topic of helpTopics) {
			const html = render(helpModule.default, { props: { topic: topic.id, locale: 'zh-Hant' } }).body;
			const domInstance = new JSDOM(html);
			try {
				const doc = domInstance.window.document;
				const activeLink = doc.querySelector('nav [aria-current="page"]');
				assert.ok(activeLink, `Topic ${topic.id} should have an active aria-current="page" navigation item`);
				assert.equal(activeLink.getAttribute('href'), `#/help/${topic.id}`);

				const heading = doc.querySelector('#help-heading');
				assert.ok(heading, 'Heading #help-heading must exist as focus target');
				assert.equal(heading.getAttribute('tabindex'), '-1', 'Heading must have tabindex="-1"');
				assert.ok(heading.textContent?.trim().length, 'Heading must have title text');

				const backLink = doc.querySelector('header a[href="#/workbench"]');
				assert.ok(backLink);
			} finally {
				domInstance.window.close();
			}
		}

		const enHtml = render(helpModule.default, { props: { topic: 'shortcuts', locale: 'en' } }).body;
		const domEn = new JSDOM(enHtml);
		try {
			const doc = domEn.window.document;
			assert.equal(doc.querySelector('#help-heading')?.textContent, 'Shortcuts');
			assert.equal(doc.querySelector('header a[href="#/workbench"]')?.textContent, 'Back to workbench');
		} finally {
			domEn.window.close();
		}

		const installHtml = render(helpModule.default, { props: { topic: 'installation', locale: 'zh-Hant' } }).body;
		const domInstall = new JSDOM(installHtml);
		try {
			const codeBlock = domInstall.window.document.querySelector('.code-container .code-block');
			assert.ok(codeBlock, 'Installation code must render inside .code-container .code-block');
		} finally {
			domInstall.window.close();
		}
	} finally {
		await server.close();
	}
});

test('compiled Svelte ReleaseNotes page SSR renders version index active semantics (SSR attributes coverage)', { timeout: 20000 }, async () => {
	const server = await createServer({
		root: frontendRoot,
		server: { middlewareMode: true, hmr: false, ws: false },
		logLevel: 'error'
	});
	try {
		const releaseModule = await server.ssrLoadModule('/src/pages/ReleaseNotes.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');

		const notesHtml = render(releaseModule.default, { props: { showLimitations: false, locale: 'zh-Hant' } }).body;
		const domNotes = new JSDOM(notesHtml);
		try {
			const doc = domNotes.window.document;
			const heading = doc.querySelector('#release-heading');
			assert.ok(heading);
			assert.equal(heading.getAttribute('tabindex'), '-1');
			assert.equal(heading.textContent, '版本紀錄');

			const activeItem = doc.querySelector('aside [aria-current="page"]');
			assert.ok(activeItem);
			assert.equal(activeItem.textContent?.trim(), '0.2.0');

			const limitationsLink = doc.querySelector('aside a[href="#/release-notes/limitations"]');
			assert.ok(limitationsLink);
			assert.equal(limitationsLink.getAttribute('aria-current'), null);

			assert.ok(doc.querySelector('header a[href="#/workbench"]'));
		} finally {
			domNotes.window.close();
		}

		const limitsHtml = render(releaseModule.default, { props: { showLimitations: true, locale: 'zh-Hant' } }).body;
		const domLimits = new JSDOM(limitsHtml);
		try {
			const doc = domLimits.window.document;
			const heading = doc.querySelector('#release-heading');
			assert.ok(heading);
			assert.equal(heading.getAttribute('tabindex'), '-1');
			assert.equal(heading.textContent, '0.1.0 已知限制');

			const activeItem = doc.querySelector('aside [aria-current="page"]');
			assert.ok(activeItem);
			assert.equal(activeItem.getAttribute('href'), '#/release-notes/limitations');
		} finally {
			domLimits.window.close();
		}

		const enLimitsHtml = render(releaseModule.default, { props: { showLimitations: true, locale: 'en' } }).body;
		const domEnLimits = new JSDOM(enLimitsHtml);
		try {
			const heading = domEnLimits.window.document.querySelector('#release-heading');
			assert.equal(heading?.textContent, '0.1.0 known limitations');
		} finally {
			domEnLimits.window.close();
		}
	} finally {
		await server.close();
	}
});

test('public service functions and real document operations satisfy navigation contract', async () => {
	for (const topic of helpTopics) {
		assert.equal(helpTopic(`#/help/${topic.id}`), topic.id);
	}
	assert.equal(helpTopic('#/help/invalid-topic'), 'getting-started');
	assert.equal(helpTopic('#/'), 'getting-started');

	assert.equal(templateOptions.length, 3);
	for (const option of templateOptions) {
		const draft = createDraft(option.id);
		assert.ok(draft.toBytes().length > 0);
		assert.match(new TextDecoder().decode(draft.toBytes()), /\\documentclass/);
	}
	assert.throws(() => createDraft('unknown-template'), /BAD_TEMPLATE/);

	const rawChangelog = await fs.promises.readFile(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');
	const notes = releaseNotes(rawChangelog);
	assert.ok(notes.length >= 2);
	assert.equal(notes[0]?.version, '0.2.0');
	assert.equal(notes[1]?.version, '0.1.0');
});
