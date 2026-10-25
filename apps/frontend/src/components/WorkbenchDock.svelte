<script lang="ts">
	import type { Diagnostic } from '@modutex/frontend-contracts';
	import type { Language } from '../i18n/text.ts';
	import DragSeparator from './splitter/DragSeparator.svelte';
	import { clampSplitterValue, splitterBounds } from './splitter/resize-logic.ts';
	import CompileFeedback from './CompileFeedback.svelte';
	import TerminalPanel from '../features/terminal/TerminalPanel.svelte';
	import { createTerminalSession, createTerminalView } from '../features/terminal/terminal-runtime.mjs';

	type WorkbenchDockTab = 'problems' | 'output' | 'terminal' | null;

	let {
		locale,
		activeTab = $bindable<WorkbenchDockTab>(null),
		workspaceId = null,
		diagnostics = [],
		compileLog = '',
		terminalSessionFactory = createTerminalSession,
		terminalViewFactory = createTerminalView,
		canNavigateDiagnostic = () => false,
		navigateToDiagnostic = () => {}
	}: {
		locale: Language;
		activeTab: WorkbenchDockTab;
		workspaceId?: string | null;
		diagnostics?: readonly Diagnostic[];
		compileLog?: string;
		terminalSessionFactory?: typeof createTerminalSession;
		terminalViewFactory?: typeof createTerminalView;
		canNavigateDiagnostic?: (diagnostic: Diagnostic) => boolean;
		navigateToDiagnostic?: (diagnostic: Diagnostic) => void;
	} = $props();

	const t = (zh: string, en: string) => locale === 'zh-Hant' ? zh : en;
	let dockElement = $state<HTMLElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let dockHeight = $state(320);

	function bounds() {
		const height = dockElement?.parentElement?.getBoundingClientRect().height ?? 0;
		if (height <= 0) return { min: 180, max: 600 };
		return splitterBounds(height, Math.max(180, height - 528), 140, 8);
	}

	function dockTop() {
		const height = dockElement?.parentElement?.getBoundingClientRect().height ?? 0;
		return Math.max(0, height - dockHeight);
	}

	function resizeDock(top: number) {
		const height = dockElement?.parentElement?.getBoundingClientRect().height ?? 0;
		if (height <= 0) return;
		dockHeight = height - clampSplitterValue(top, bounds());
	}

	function closeDock() {
		activeTab = null;
		closeButton?.focus();
	}

	function onTabKeyDown(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		const current = event.currentTarget as HTMLButtonElement;
		const tabs = [...(current.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])];
		const index = tabs.indexOf(current);
		if (index < 0 || tabs.length === 0) return;
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
		event.preventDefault();
		tabs[next]?.focus();
		tabs[next]?.click();
	}

	$effect(() => {
		const parent = dockElement?.parentElement;
		if (!parent) return;
		const resize = () => {
			const height = parent.getBoundingClientRect().height;
			if (height <= 0) return;
			dockHeight = height - clampSplitterValue(height - dockHeight, splitterBounds(height, Math.max(180, height - 528), 140, 8));
		};
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
		observer?.observe(parent);
		window.addEventListener('resize', resize);
		resize();
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', resize);
		};
	});
</script>

<section
	class="workbench-dock"
	class:expanded={activeTab !== null}
	bind:this={dockElement}
	style:height={`${activeTab === null ? 40 : dockHeight}px`}
	aria-label={t('工作台底部面板', 'Workbench bottom panel')}
>
	{#if activeTab !== null}
		<DragSeparator
			class="workbench-dock-separator"
			value={dockTop()}
			min={bounds().min}
			max={bounds().max}
			axis="horizontal"
			controls="workbench-dock-body"
			label={t('調整底部面板高度', 'Resize bottom panel height')}
			container={dockElement?.parentElement ?? null}
			onChange={resizeDock}
		/>
	{/if}
	<div class="workbench-dock-tabs" role="tablist" aria-label={t('底部面板', 'Bottom panel')}>
		<button id="workbench-dock-tab-problems" type="button" role="tab" tabindex={activeTab === 'problems' || activeTab === null ? 0 : -1} aria-selected={activeTab === 'problems'} aria-controls="workbench-dock-panel-problems" onclick={() => activeTab = 'problems'} onkeydown={onTabKeyDown}>
			{t('問題', 'Problems')}{diagnostics.length ? ` (${diagnostics.length})` : ''}
		</button>
		<button id="workbench-dock-tab-output" type="button" role="tab" tabindex={activeTab === 'output' ? 0 : -1} aria-selected={activeTab === 'output'} aria-controls="workbench-dock-panel-output" onclick={() => activeTab = 'output'} onkeydown={onTabKeyDown}>
			{t('輸出', 'Output')}
		</button>
		{#if workspaceId}
			<button id="workbench-dock-tab-terminal" type="button" role="tab" tabindex={activeTab === 'terminal' ? 0 : -1} aria-selected={activeTab === 'terminal'} aria-controls="workbench-dock-panel-terminal" onclick={() => activeTab = 'terminal'} onkeydown={onTabKeyDown}>
				{t('終端機', 'Terminal')}
			</button>
		{/if}
		<button bind:this={closeButton} class="workbench-dock-close" type="button" title={t('關閉面板', 'Close panel')} aria-label={t('關閉面板', 'Close panel')} onclick={closeDock}>
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg>
		</button>
	</div>
	<div id="workbench-dock-body" class="workbench-dock-body" hidden={activeTab === null} inert={activeTab === null}>
		<div id="workbench-dock-panel-problems" class="workbench-dock-panel" role="tabpanel" tabindex="0" aria-labelledby="workbench-dock-tab-problems" hidden={activeTab !== 'problems'} inert={activeTab !== 'problems'}>
			<CompileFeedback panel="problems" {locale} {diagnostics} {compileLog} {canNavigateDiagnostic} {navigateToDiagnostic} />
		</div>
		<div id="workbench-dock-panel-output" class="workbench-dock-panel" role="tabpanel" tabindex="0" aria-labelledby="workbench-dock-tab-output" hidden={activeTab !== 'output'} inert={activeTab !== 'output'}>
			<CompileFeedback panel="output" {locale} {diagnostics} {compileLog} {canNavigateDiagnostic} {navigateToDiagnostic} />
		</div>
		{#if workspaceId}
			<div id="workbench-dock-panel-terminal" class="workbench-dock-panel terminal-dock-panel" role="tabpanel" tabindex="0" aria-labelledby="workbench-dock-tab-terminal" hidden={activeTab !== 'terminal'} inert={activeTab !== 'terminal'}>
				<TerminalPanel {workspaceId} {locale} active={activeTab === 'terminal'} panelHeight={dockHeight} sessionFactory={terminalSessionFactory} viewFactory={terminalViewFactory} />
			</div>
		{/if}
	</div>
</section>

<style>
	.workbench-dock {
		position: relative;
		z-index: 4;
		flex: 0 0 auto;
		min-width: 0;
		min-height: 40px;
		max-height: 80dvh;
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line);
		background: var(--surface);
	}
	:global(.workbench-dock-separator.splitter.horizontal) {
		position: absolute;
		top: -4px;
		left: 0;
		width: 100%;
		height: 8px;
		z-index: 6;
	}
	.workbench-dock-tabs {
		flex: 0 0 40px;
		min-width: 0;
		height: 40px;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		background: var(--canvas);
	}
	.workbench-dock-tabs [role='tab'] {
		min-height: 30px;
		padding: 4px 10px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted);
		font-size: 13px;
	}
	.workbench-dock-tabs [role='tab'][aria-selected='true'] {
		color: var(--accent);
		background: var(--selection);
		border-color: var(--line);
	}
	.workbench-dock-close {
		width: 32px;
		min-width: 32px;
		height: 30px;
		min-height: 30px;
		margin-inline-start: auto;
		padding: 6px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted);
	}
	.workbench-dock-close svg { display: block; }
	.workbench-dock-body {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.workbench-dock-body[hidden] { display: none !important; }
	.workbench-dock-panel {
		min-width: 0;
		min-height: 0;
	}
	.workbench-dock-panel[hidden] { display: none !important; }
	.terminal-dock-panel { height: 100%; }
	@media (max-width: 620px) {
		.workbench-dock-tabs { gap: 2px; padding-inline: 6px; }
		.workbench-dock-tabs [role='tab'] { padding-inline: 7px; font-size: 12px; }
	}
</style>
