// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import EditorTopbar from '../../../../../src/lib/editor/comp/EditorTopbar.svelte';
import LatexCompileSettings from '../../../../../src/lib/editor/comp/LatexCompileSettings.svelte';
import PaneSplitter from '../../../../../src/lib/editor/comp/PaneSplitter.svelte';
import { m } from '../../../../../src/lib/paraglide/messages';

let host: HTMLDivElement;
let mounted: object | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	const app = mounted;
	mounted = null;
	if (app) void unmount(app);
	host.remove();
});

function mountTopbar(narrow: boolean, onSelectPane = vi.fn(), overrides: Partial<ComponentProps<typeof EditorTopbar>> = {}) {
	const props: ComponentProps<typeof EditorTopbar> = {
		loadedPath: null,
		kind: 'tex',
		viewMode: 'source',
		terminalAvailable: false,
		compiling: false,
		typstPreviewWanted: false,
		pdfPaneOpen: false,
		narrow,
		activePane: 'document',
		draftPaused: false,
		saving: false,
		modLabel: 'Ctrl',
		onSetViewMode: vi.fn(),
		onStopCompile: vi.fn(),
		onPauseDraft: vi.fn(),
		onResumeDraft: vi.fn(),
		onCompile: vi.fn(),
		onConfigureCompile: vi.fn(),
		onShowProblems: vi.fn(),
		onSelectPane,
		onTogglePdf: vi.fn(),
		onSave: vi.fn(),
		...overrides
	};
	mounted = mount(EditorTopbar, { target: host, props });
	flushSync();
	return { props, onSelectPane };
}

describe('document workbench pane controls', () => {
	it('mounts localized document/PDF tabs only in narrow mode and moves focus with the tab keys', async () => {
		const { onSelectPane } = mountTopbar(true);
		const list = host.querySelector('[role="tablist"]');
		const documentTab = host.querySelector<HTMLButtonElement>('#workbench-document-tab');
		const previewTab = host.querySelector<HTMLButtonElement>('#workbench-preview-tab');
		expect(list).toBeTruthy();
		expect(documentTab?.getAttribute('aria-selected')).toBe('true');
		expect(documentTab?.tabIndex).toBe(0);
		expect(previewTab?.tabIndex).toBe(-1);

		const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
		list!.dispatchEvent(event);
		await Promise.resolve();
		expect(event.defaultPrevented).toBe(true);
		expect(onSelectPane).toHaveBeenCalledWith('preview');
		expect(document.activeElement).toBe(previewTab);
	});

	it('does not expose pane tabs in wide mode', () => {
		mountTopbar(false);
		expect(host.querySelector('[role="tablist"]')).toBeNull();
	});

	it('exposes splitter bounds and forwards keyboard resizing while focusable', () => {
		const onResizeByKey = vi.fn();
		mounted = mount(PaneSplitter, {
			target: host,
			props: {
				resizable: true,
				resizeLabel: 'Resize PDF preview',
				value: 480,
				minValue: 280,
				maxValue: 640,
				onStartResize: vi.fn(),
				onResizeByKey
			}
		});
		flushSync();

		const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
		expect(separator.getAttribute('aria-valuenow')).toBe('480');
		expect(separator.getAttribute('aria-valuemin')).toBe('280');
		expect(separator.getAttribute('aria-valuemax')).toBe('640');
		separator.focus();
		separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		expect(document.activeElement).toBe(separator);
		expect(onResizeByKey).toHaveBeenCalledOnce();
	});
});

describe('workbench compile state controls', () => {
	it('keeps Stop text and its icon while using a scoped neutral stop tone', () => {
		mountTopbar(false, vi.fn(), { terminalAvailable: true, compiling: true });
		const stop = host.querySelector<HTMLButtonElement>('.workbench-compile-status');
		const menu = host.querySelector<HTMLButtonElement>('.workbench-compile-menu');

		expect(stop?.textContent?.trim()).toBe(m.wsview_stop_label());
		expect(stop?.querySelector('svg')).toBeTruthy();
		expect(stop?.classList.contains('workbench-compile-stop')).toBe(true);
		expect(stop?.classList.contains('preset-tonal-error')).toBe(false);
		expect(menu?.classList.contains('workbench-compile-stop')).toBe(true);
	});

	it('keeps the idle compile action labeled and neutral-toned', () => {
		mountTopbar(false, vi.fn(), { terminalAvailable: true });
		const button = host.querySelector<HTMLButtonElement>('.workbench-compile-status')!;
		expect(button.textContent?.trim()).toBe(m.wsview_compile_label());
		expect(button.classList.contains('workbench-compile-idle')).toBe(true);
	});

	it('keeps a running live preview labeled and marked with its status dot', () => {
		mountTopbar(false, vi.fn(), { terminalAvailable: true, typstPreviewWanted: true, pdfPaneOpen: true });
		const button = host.querySelector<HTMLButtonElement>('.workbench-compile-status')!;
		expect(button.textContent?.trim()).toBe(m.wsview_live_label());
		expect(button.classList.contains('workbench-compile-success')).toBe(true);
		expect(button.querySelector('span.rounded-full')).toBeTruthy();
	});

	it('keeps a blocked command labeled and disabled with its warning tone', () => {
		mountTopbar(false, vi.fn(), { terminalAvailable: true, commandPending: true });
		const button = host.querySelector<HTMLButtonElement>('.workbench-compile-status')!;
		expect(button.textContent?.trim()).toBe(m.wsview_compile_label());
		expect(button.classList.contains('workbench-compile-warning')).toBe(true);
		expect(button.disabled).toBe(true);
	});

	it('mounts engine, latexmk, and switch controls inside the compile-settings color scope', () => {
		mounted = mount(LatexCompileSettings, {
			target: host,
			props: {
				command: 'latexmk -lualatex -interaction=nonstopmode -output-directory=output {main}',
				superseded: false,
				segment: 'setting-segment',
				seg: (active) => (active ? 'active' : 'inactive')
			}
		});
		flushSync();

		const scope = host.querySelector('.workbench-compile-settings');
		expect(scope?.querySelectorAll('.workbench-setting-choice')).toHaveLength(3);
		expect(scope?.querySelector('.workbench-setting-choice[aria-pressed="true"]')?.textContent?.trim()).toBe('lualatex');
		expect(scope?.querySelector('.workbench-setting-checkbox')).toBeTruthy();
		expect(scope?.querySelector('[data-scope="switch"][data-part="control"]')).toBeTruthy();
	});
});
