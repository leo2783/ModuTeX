import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
	DRAWIO_INDEX,
	DRAWIO_RELAY,
	allowDrawioNavigation,
	allowDrawioNetwork,
	canonicalDrawioFile,
	createDrawioHandler,
	drawioRelativePath,
	drawioVendorRoot,
	hasDrawioAncestor,
	installDrawioNetworkGuard,
	matchesDiagramHostURL
} from '../src/drawio-protocol';
import { FRONTEND_BUILT_URL, FRONTEND_DEVELOPMENT_URL, matchesFrontendHostURL } from '../src/frontend-development';
const DRAWIO_ORIGIN = 'drawio://editor';

const ownedRoots: string[] = [];
describe('exact canonical diagram host authority', () => {
	it('canonicalizes the missing root slash and accepts only the existing routes', () => {
		for (const base of ['http://127.0.0.1:5739', 'app://bundle/index.html']) {
			const canonical = new URL(base).href;
			for (const hash of ['', '#/', '#/workspace', '#/workspace/', '#/workspace///'])
				expect(matchesDiagramHostURL(canonical + hash, base)).toBe(true);
		}
	});
	it('does not accept authority, path, query, unknown hash or userinfo changes', () => {
		for (const actual of [
			'http://127.0.0.1:5740/',
			'https://127.0.0.1:5739/',
			'http://localhost:5739/',
			'http://127.0.0.1:5739/other',
			'http://127.0.0.1:5739/?x=1',
			'http://x@127.0.0.1:5739/',
			'http://127.0.0.1:5739/#',
			'http://127.0.0.1:5739/#//',
			'http://127.0.0.1:5739/#/other',
			'http://127.0.0.1:5739/#/workspace?x=1',
			'http://127.0.0.1:5739/#%2Fworkspace'
		])
			expect(matchesDiagramHostURL(actual, 'http://127.0.0.1:5739')).toBe(false);
	});
});
describe('native owner bootstrap resolution', () => {
	function guard(mainURL = context.mainURL) {
		let listener: any;
		const session: any = {
			webRequest: {
				onBeforeRequest(_filter: unknown, installed: unknown) {
					listener = installed;
				}
			}
		};
		const mainFrame = frame('');
		const contents: any = { id: 7, session, mainFrame, isDestroyed: () => false, getURL: () => '' };
		let resolved: any = contents;
		installDrawioNetworkGuard(
			session,
			(id) => (id === 7 ? { ...context, mainURL } : undefined),
			() => resolved
		);
		return {
			contents,
			mainFrame,
			resolve(value: any) {
				resolved = value;
			},
			run(patch: any = {}) {
				let result: unknown;
				listener({ webContentsId: 7, url: new URL(mainURL).href, resourceType: 'mainFrame', frame: null, ...patch }, (value: unknown) => {
					result = value;
				});
				return result;
			}
		};
	}
	it('allows exact first main request with optional webContents/frame absent through the native owner', () => {
		const g = guard();
		expect(guard('http://127.0.0.1:5739').run()).toEqual({ cancel: false });
		expect(g.run()).toEqual({ cancel: false });
		expect(g.run({ frame: g.mainFrame })).toEqual({ cancel: false });
		expect(g.run({ webContents: g.contents, frame: g.mainFrame })).toEqual({ cancel: false });
	});
	it('does not use missing frame as authority for other URLs, ports, types or child frames', () => {
		const g = guard();
		for (const patch of [
			{ url: 'http://127.0.0.1:5174/' },
			{ url: context.mainURL + 'other' },
			{ resourceType: 'subFrame' },
			{ resourceType: 'script' },
			{ resourceType: 'webSocket' },
			{ webContentsId: 8 },
			{ frame: frame('', g.mainFrame) },
			{ frame: frame('', frame(DRAWIO_INDEX)) },
			{ webContents: {} }
		])
			expect(g.run(patch)).toEqual({ cancel: true });
		g.contents.getURL = () => context.mainURL;
		expect(g.run()).toEqual({ cancel: true });
		g.mainFrame.url = context.mainURL + '#/workspace';
		expect(g.run({ frame: g.mainFrame, resourceType: 'script', url: context.mainURL + 'client.js' })).toEqual({ cancel: false });
		for (const url of [context.mainURL + 'other', context.mainURL + '?x=1', context.mainURL + '#/other']) {
			g.mainFrame.url = url;
			expect(g.run({ frame: g.mainFrame, resourceType: 'script', url: context.mainURL + 'client.js' })).toEqual({ cancel: true });
		}
		expect(g.run({ frame: frame(context.mainURL), resourceType: 'script', url: context.mainURL + 'client.js' })).toEqual({ cancel: true });
	});
	it('fails closed for unknown, destroyed, mismatched-session and throwing native owners', () => {
		for (const mutation of [
			(g: ReturnType<typeof guard>) => g.resolve(undefined),
			(g: ReturnType<typeof guard>) => {
				g.contents.id = 8;
			},
			(g: ReturnType<typeof guard>) => {
				g.contents.session = {};
			},
			(g: ReturnType<typeof guard>) => {
				g.contents.isDestroyed = () => true;
			},
			(g: ReturnType<typeof guard>) => {
				g.contents.getURL = () => {
					throw new Error('destroyed');
				};
			}
		]) {
			const g = guard();
			mutation(g);
			expect(g.run()).toEqual({ cancel: true });
		}
	});
});
afterEach(async () => {
	for (const root of ownedRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-drawio-path-')));
	ownedRoots.push(root);
	await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><p>owned fixture</p>');
	return root;
}
const context = { mainURL: 'http://127.0.0.1:5173/', previewURL: 'http://127.0.0.1:9123/9', dataPlaneOrigin: 'http://127.0.0.1:9124' };
function frame(url: string, parent: any = null): any {
	return { url, parent };
}
function request(url: string, frame: any, resourceType: any = 'xhr'): any {
	return { url, frame, resourceType };
}

describe('strict pinned vendor protocol', () => {
	it('serves only fixed outer resources and never exposes vendor bytes under bundle authority', async () => {
		const root = await fixture();
		const relay = path.join(root, 'relay.js');
		await fs.writeFile(relay, 'const origins = "__MODUTEX_HOST_ORIGINS__";');
		const handler = createDrawioHandler(root, relay, () => ['app://bundle']);
		const page = await handler(new Request(DRAWIO_RELAY));
		expect(page.status).toBe(200);
		expect(page.headers.get('Content-Security-Policy')).toContain('frame-src drawio://editor');
		expect(await (await handler(new Request('drawio://bundle/relay.js'))).text()).toContain('["app://bundle"]');
		for (const route of [
			'drawio://bundle/index.html',
			'drawio://bundle/js/app.js',
			'drawio://bundle/relay.html?origin=evil',
			'drawio://editor/relay.html'
		])
			expect((await handler(new Request(route))).status).toBe(403);
	});
	it('uses only the actual dev and packaged vendor layouts', () => {
		expect(drawioVendorRoot(false, '/resources', '/repo/electron/dist')).toBe(path.resolve('/repo/vendor/drawio/src/main/webapp'));
		expect(drawioVendorRoot(true, '/resources', '/ignored')).toBe(path.join('/resources', 'vendor/drawio/src/main/webapp'));
	});
	it('rejects raw and encoded escapes before URL dot normalization', () => {
		for (const url of [
			'https://bundle/index.html',
			'drawio://else/index.html',
			'drawio://u@editor/index.html',
			'drawio://editor:80/index.html',
			'drawio://editor/../index.html',
			'drawio://editor/%2e%2e/index.html',
			'drawio://editor/a%2fb.js',
			'drawio://editor/a%5cb.js',
			'drawio://editor/%252e%252e/index.html',
			'drawio://editor/a\\b.js',
			'drawio://editor/index.html:secret',
			'drawio://editor/con.js',
			'drawio://editor/a./index.html',
			'drawio://editor/a//x.js',
			'drawio://editor/%00.js',
			'drawio://editor/login.html',
			'drawio://editor/private.exe',
			'drawio://bundle/index.html'
		])
			expect(drawioRelativePath(url)).toBeNull();
		expect(drawioRelativePath(DRAWIO_INDEX)).toBe('index.html');
		expect(drawioRelativePath(`${DRAWIO_ORIGIN}/js/app.min.js?v=31.1.8`)).toBe('js/app.min.js');
	});
	it('serves real bytes with CSP and MIME, denies nonfiles and unsupported methods', async () => {
		const root = await fixture(),
			handler = createDrawioHandler(root);
		const response = await handler(new Request(DRAWIO_INDEX));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<!doctype html><p>owned fixture</p>');
		expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self' blob: data:");
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Content-Type')).toBe('text/html');
		expect((await handler(new Request(DRAWIO_INDEX, { method: 'POST' }))).status).toBe(405);
		await fs.mkdir(path.join(root, 'dir.js'));
		expect((await handler(new Request(`${DRAWIO_ORIGIN}/dir.js`))).status).toBe(404);
	});
	it('rejects actual linked file and junction directory escapes', async () => {
		const root = await fixture(),
			outside = await fixture();
		await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		await expect(canonicalDrawioFile(root, 'linked/index.html')).rejects.toThrow();
		if (process.platform !== 'win32') {
			await fs.symlink(path.join(outside, 'index.html'), path.join(root, 'link.js'));
			await expect(canonicalDrawioFile(root, 'link.js')).rejects.toThrow();
		}
	});
});

describe('installed-API frame confinement decisions', () => {
	it('denies every remote and loopback request from Draw.io and opaque descendants before host allowances', () => {
		const host = frame(context.mainURL),
			drawio = frame(DRAWIO_INDEX, host);
		for (const source of [
			drawio,
			frame('about:blank', drawio),
			frame('data:text/html,owned', drawio),
			frame('blob:drawio://bundle/owned', drawio)
		]) {
			for (const url of ['https://example.invalid/', context.mainURL, context.previewURL, 'ws://127.0.0.1:9124/']) {
				expect(allowDrawioNetwork(request(url!, source), context)).toBe(false);
			}
		}
	});
	it('allows verified host Vite and exact main-prepared Typst endpoints only', () => {
		const host = frame(context.mainURL),
			preview = frame(context.previewURL, host);
		expect(allowDrawioNetwork(request('http://127.0.0.1:5173/@vite/client', host), context)).toBe(true);
		expect(allowDrawioNetwork(request('ws://127.0.0.1:5173/', host, 'webSocket'), context)).toBe(true);
		expect(allowDrawioNetwork(request(context.previewURL, host, 'subFrame'), context)).toBe(true);
		expect(allowDrawioNetwork(request('ws://127.0.0.1:9124/data', preview), context)).toBe(true);
		expect(allowDrawioNetwork(request('http://127.0.0.1:9125/', preview), context)).toBe(false);
		expect(allowDrawioNetwork(request('https://example.invalid/', host), context)).toBe(false);
	});
	it('fails closed for null, missing, throwing, cyclic and foreign frames without referrer authorization', () => {
		for (const source of [null, undefined, frame('about:blank'), frame('https://example.invalid/')]) {
			expect(allowDrawioNetwork(request(context.mainURL, source), context)).toBe(false);
		}
		const broken = {
			get url() {
				throw new Error('destroyed');
			},
			parent: null
		};
		const cycle = frame(context.mainURL);
		cycle.parent = cycle;
		for (const source of [broken, cycle]) {
			expect(hasDrawioAncestor(source)).toBe(true);
			expect(allowDrawioNetwork(request(context.mainURL, source), context)).toBe(false);
		}
		expect(allowDrawioNetwork(request(context.mainURL, null, 'mainFrame'), context, true)).toBe(true);
		expect(allowDrawioNetwork(request(context.mainURL, frame(''), 'mainFrame'), context, true)).toBe(true);
		expect(allowDrawioNetwork(request(context.mainURL, frame('', frame(DRAWIO_INDEX)), 'mainFrame'), context, true)).toBe(false);
		expect(allowDrawioNetwork(request(context.mainURL, null, 'script'), context, true)).toBe(false);
	});
	it('allows only host-initiated fixed editor/preview navigation and blocks Draw.io escapes', () => {
		const host = frame(context.mainURL),
			child = frame('about:blank', host),
			drawio = frame(DRAWIO_INDEX, host);
		const navigation = (url: string, target: any, initiator: any, isMainFrame = false) => ({ url, frame: target, initiator, isMainFrame });
		expect(allowDrawioNavigation(navigation(DRAWIO_RELAY, child, host), context)).toBe(true);
		expect(allowDrawioNavigation(navigation(DRAWIO_INDEX, child, host), context)).toBe(false);
		const wrapper = frame(DRAWIO_RELAY, host),
			blankInner = frame('about:blank', wrapper);
		expect(allowDrawioNavigation(navigation(DRAWIO_INDEX, blankInner, wrapper), context)).toBe(true);
		expect(allowDrawioNavigation(navigation(DRAWIO_INDEX, frame(DRAWIO_INDEX, wrapper), wrapper), context)).toBe(false);
		for (const url of ['https://example.invalid/', context.mainURL, context.previewURL!]) {
			expect(allowDrawioNavigation(navigation(url, drawio, drawio), context)).toBe(false);
			expect(allowDrawioNavigation(navigation(url, host, drawio, true), context)).toBe(false);
		}
		expect(allowDrawioNavigation(navigation(DRAWIO_INDEX, child, null), context)).toBe(false);
	});

	it.each([FRONTEND_DEVELOPMENT_URL, FRONTEND_BUILT_URL])('preserves frontend authority after opening the workbench at %s', (mainURL) => {
		const frontendContext = { mainURL, matchesHostURL: matchesFrontendHostURL };
		const workbench = mainURL + '#/workbench';
		const host = frame(workbench);
		const asset = new URL('./assets/editor.js', mainURL).href;
		expect(allowDrawioNetwork(request(asset, host, 'script'), frontendContext)).toBe(true);
		expect(allowDrawioNetwork(request(asset, host, 'script'), { mainURL })).toBe(false);
		expect(allowDrawioNetwork(request('https://example.invalid/script.js', host, 'script'), frontendContext)).toBe(false);
		for (const child of [frame(DRAWIO_INDEX, host), frame('about:blank', host)]) {
			expect(allowDrawioNetwork(request(asset, child, 'script'), frontendContext)).toBe(false);
		}
		expect(allowDrawioNetwork(request(mainURL, null, 'mainFrame'), frontendContext, true)).toBe(true);
		expect(allowDrawioNetwork(request(asset, null, 'script'), frontendContext, true)).toBe(false);
		expect(allowDrawioNavigation({ url: mainURL + '#/settings', frame: host, initiator: host, isMainFrame: true }, frontendContext)).toBe(true);
		expect(allowDrawioNavigation({ url: 'https://example.invalid/', frame: host, initiator: host, isMainFrame: true }, frontendContext)).toBe(false);
		expect(allowDrawioNavigation({ url: mainURL + '#/settings', frame: host, initiator: frame(DRAWIO_INDEX, host), isMainFrame: true }, frontendContext)).toBe(false);
	});
});
