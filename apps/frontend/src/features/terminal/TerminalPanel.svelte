<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { createTerminalSession, createTerminalView } from './terminal-runtime.mjs';
	import type {
		TerminalAvailability,
		TerminalCallbacks,
		TerminalController,
		TerminalExit,
		TerminalSessionError
	} from './session.mjs';
	import type { Language } from '../../i18n/text.ts';
	import type { TerminalView } from './xterm-view.ts';

	type Phase =
		| 'closed'
		| 'checking'
		| 'unavailable'
		| 'error'
		| 'ready'
		| 'starting'
		| 'running'
		| 'exited'
		| 'closing'
		| 'cleanup-error';
	type PanelProps = {
		workspaceId?: string | null;
		enabled?: boolean;
		locale?: Language;
		sessionFactory?: typeof createTerminalSession;
		viewFactory?: typeof createTerminalView;
	};

	let {
		workspaceId = null,
		enabled = true,
		locale = 'en',
		sessionFactory = createTerminalSession,
		viewFactory = createTerminalView
	}: PanelProps = $props();

	let isOpen = $state(false);
	let phase = $state<Phase>('closed');
	let statusText = $state('');
	let viewReady = $state(false);
	let terminalHost = $state<HTMLDivElement | null>(null);
	let toggleButton = $state<HTMLButtonElement | null>(null);
	let statusElement = $state<HTMLSpanElement | null>(null);

	let activeController: TerminalController | null = null;
	let activeView: TerminalView | null = null;
	let sessionAbort: AbortController | null = null;
	let panelEpoch = 0;
	let sessionEpoch = 0;
	let disposed = false;
	let observedWorkspaceId = (() => workspaceId)();
	let observedEnabled = (() => enabled)();

	const t = (zh: string, en: string) => locale === 'zh-Hant' ? zh : en;

	function currentPanel(token: number, owner: string): boolean {
		return !disposed && panelEpoch === token && isOpen && enabled && workspaceId === owner;
	}

	function describeError(value: unknown): string {
		const candidate = value as {
			readonly code?: unknown;
			readonly detail?: unknown;
			readonly message?: unknown;
		} | null;
		const code = typeof candidate?.code === 'string' ? candidate.code : '';
		const detail = typeof candidate?.detail === 'string' ? candidate.detail : '';
		const message = detail || (typeof candidate?.message === 'string' ? candidate.message : '');
		if (code === 'STALE_WORKSPACE') {
			return t('工作區已關閉，終端機已停止。', 'The workspace is closed; the terminal has stopped.');
		}
		if (code === 'TERMINAL_UNAVAILABLE') {
			return t('此環境無法使用終端機。', 'The terminal is unavailable in this environment.');
		}
		if (code === 'OUTPUT_BACKPRESSURE') {
			return t('終端機輸出過多，已停止工作階段以保護工作區。', 'Terminal output exceeded its safe limit; the session was stopped.');
		}
		if (message) return message;
		return t('終端機操作失敗。請關閉後重新開啟。', 'The terminal operation failed. Close it and try again.');
	}

	function availabilityMessage(result: TerminalAvailability): string {
		const detail = result.detail || result.reason;
		return detail
			? `${t('終端機無法使用：', 'Terminal unavailable: ')}${detail}`
			: t('此工作區目前無法啟動終端機。', 'A terminal cannot be started for this workspace.');
	}

	function reportExit(exit: TerminalExit): string {
		const code = exit.exitCode === null
			? t('未知', 'unknown')
			: String(exit.exitCode);
		return `${t('程序已結束（代碼：', 'Process exited (code: ')}${code}） — ${exit.reason}`;
	}

	async function makeController(owner: string, token: number): Promise<TerminalController | null> {
		const ownSession = ++sessionEpoch;
		const abort = new AbortController();
		sessionAbort = abort;
		const callbacks: TerminalCallbacks = {
			onOutput: (bytes) => {
				if (!currentPanel(token, owner) || ownSession !== sessionEpoch) return;
				return activeView?.write(bytes);
			},
			onExit: (exit) => {
				if (!currentPanel(token, owner) || ownSession !== sessionEpoch) return;
				phase = 'exited';
				statusText = reportExit(exit);
			},
			onFailure: (error: TerminalSessionError) => {
				if (!currentPanel(token, owner) || ownSession !== sessionEpoch) return;
				phase = 'error';
				statusText = describeError(error);
			},
			onBackpressure: () => {
				if (!currentPanel(token, owner) || ownSession !== sessionEpoch) return;
				statusText = t(
					'貼上內容超過終端機輸入佇列上限，請分批貼上。',
					'The paste exceeds the terminal input queue limit. Paste it in smaller parts.'
				);
			},
			onCleanupFailure: (error: TerminalSessionError) => {
				if (!currentPanel(token, owner) || ownSession !== sessionEpoch) return;
				phase = 'cleanup-error';
				statusText = `${t('無法確認終端機已停止：', 'Terminal cleanup could not be confirmed: ')}${describeError(error)}`;
			}
		};

		const controller = await sessionFactory(owner, callbacks, abort.signal);
		if (!currentPanel(token, owner) || ownSession !== sessionEpoch) {
			abort.abort();
			await controller.close().catch(() => {});
			return null;
		}
		activeController = controller;
		return controller;
	}

	async function initializePanel(token: number, owner: string): Promise<void> {
		try {
			const controller = await makeController(owner, token);
			if (!controller || !currentPanel(token, owner)) return;
			const availability = await controller.availability();
			if (!currentPanel(token, owner)) return;
			if (!availability.available) {
				phase = 'unavailable';
				statusText = availabilityMessage(availability);
				return;
			}

			if (!activeView) {
				viewReady = true;
				await tick();
				if (!currentPanel(token, owner) || !terminalHost) return;
				const view = await viewFactory(terminalHost, {
					onInput: (data) => {
						if (phase !== 'running' || !activeController) return;
						if (!activeController.send(data)) {
							statusText = t(
								'終端機無法接受更多輸入，請稍候。',
								'The terminal cannot accept more input yet.'
							);
						}
					},
					onResize: (cols, rows) => {
						if (
							(phase === 'running' || phase === 'starting') &&
							activeController
						) {
							activeController.resize(cols, rows);
						}
					}
				});
				if (!currentPanel(token, owner)) {
					view.dispose();
					return;
				}
				activeView = view;
			}
			activeView?.fit();
			phase = 'ready';
			statusText = t('終端機已就緒。', 'Terminal ready.');
		} catch (error) {
			if (!currentPanel(token, owner)) return;
			phase = 'error';
			statusText = describeError(error);
		}
	}

	async function openPanel(): Promise<void> {
		if (!enabled || !workspaceId || disposed) return;
		isOpen = true;
		phase = 'checking';
		statusText = t('正在檢查終端機…', 'Checking terminal availability…');
		const token = ++panelEpoch;
		const owner = workspaceId;
		await tick();
		if (currentPanel(token, owner)) await initializePanel(token, owner);
	}

	async function retireController(): Promise<void> {
		const controller = activeController;
		if (!controller) return;
		const abort = sessionAbort;
		activeController = null;
		sessionAbort = null;
		sessionEpoch++;
		abort?.abort();
		try {
			await controller.close();
		} catch (error) {
			activeController = controller;
			sessionAbort = abort;
			throw error;
		}
	}

	async function retryAvailability(): Promise<void> {
		if (!isOpen || !workspaceId) return;
		const token = panelEpoch;
		const owner = workspaceId;
		phase = 'checking';
		statusText = t('正在重新檢查終端機…', 'Checking terminal availability again…');
		try {
			await retireController();
			if (!currentPanel(token, owner)) return;
			if (activeView) {
				activeView.dispose();
				activeView = null;
				viewReady = false;
			}
			await tick();
			if (currentPanel(token, owner)) await initializePanel(token, owner);
		} catch (error) {
			if (!currentPanel(token, owner)) return;
			phase = 'cleanup-error';
			statusText = `${t('無法確認終端機已停止：', 'Terminal cleanup could not be confirmed: ')}${describeError(error)}`;
		}
	}

	async function startShell(): Promise<void> {
		if (
			!isOpen ||
			!workspaceId ||
			!['ready', 'exited', 'error'].includes(phase)
		) {
			return;
		}
		const token = panelEpoch;
		const owner = workspaceId;
		const previousPhase = phase;
		if (previousPhase === 'exited' || previousPhase === 'error') {
			phase = 'checking';
			statusText = t('正在重新開啟終端機…', 'Reopening the terminal…');
			try {
				await retireController();
			} catch (error) {
				if (!currentPanel(token, owner)) return;
				phase = 'cleanup-error';
				statusText = `${t('無法確認終端機已停止：', 'Terminal cleanup could not be confirmed: ')}${describeError(error)}`;
				return;
			}
			if (!currentPanel(token, owner)) return;
			await initializePanel(token, owner);
			if ((phase as Phase) !== 'ready' || !currentPanel(token, owner)) return;
		}

		const controller = activeController;
		if (!controller || !activeView) return;
		activeView.reset();
		activeView.fit();
		const initialSize = activeView.size();
		phase = 'starting';
		statusText = t('正在啟動終端機…', 'Starting terminal…');
		try {
			await controller.start(initialSize.cols, initialSize.rows);
			if (!currentPanel(token, owner)) return;
			if (phase === 'starting') {
				phase = 'running';
				statusText = t('終端機已連線。', 'Terminal connected.');
			}
			if (phase === 'running') {
				const currentSize = activeView.size();
				controller.resize(currentSize.cols, currentSize.rows);
				activeView.focus();
			}
		} catch (error) {
			if (!currentPanel(token, owner) || (phase as Phase) === 'cleanup-error') return;
			phase = 'error';
			statusText = describeError(error);
		}
	}

	async function closePanel(): Promise<void> {
		if (!isOpen) return;
		const token = ++panelEpoch;
		sessionEpoch++;
		phase = 'closing';
		statusText = t('正在停止終端機…', 'Stopping terminal…');
		const controller = activeController;
		const abort = sessionAbort;
		activeController = null;
		sessionAbort = null;
		abort?.abort();
		try {
			if (controller) await controller.close();
			if (token !== panelEpoch || disposed) return;
			activeView?.dispose();
			activeView = null;
			viewReady = false;
			isOpen = false;
			phase = 'closed';
			statusText = '';
			await tick();
			toggleButton?.focus();
		} catch (error) {
			if (token !== panelEpoch || disposed) return;
			activeController = controller;
			sessionAbort = abort;
			activeView?.dispose();
			activeView = null;
			viewReady = false;
			phase = 'cleanup-error';
			statusText = `${t('無法確認終端機已停止：', 'Terminal cleanup could not be confirmed: ')}${describeError(error)}`;
		}
	}

	function retireForScopeChange(): void {
		panelEpoch++;
		sessionEpoch++;
		const controller = activeController;
		const abort = sessionAbort;
		activeController = null;
		sessionAbort = null;
		abort?.abort();
		activeView?.dispose();
		activeView = null;
		viewReady = false;
		isOpen = false;
		phase = 'closed';
		statusText = '';
		if (controller) void controller.close().catch(() => {});
	}

	$effect(() => {
		const nextWorkspaceId = workspaceId;
		const nextEnabled = enabled;
		if (
			nextWorkspaceId === observedWorkspaceId &&
			nextEnabled === observedEnabled
		) {
			return;
		}
		observedWorkspaceId = nextWorkspaceId;
		observedEnabled = nextEnabled;
		retireForScopeChange();
	});

	onDestroy(() => {
		disposed = true;
		panelEpoch++;
		sessionEpoch++;
		const controller = activeController;
		activeController = null;
		sessionAbort?.abort();
		sessionAbort = null;
		activeView?.dispose();
		activeView = null;
		if (controller) void controller.close().catch(() => {});
	});
</script>

{#if enabled && workspaceId}
	<section class="terminal-dock" aria-label={t('終端機', 'Terminal')}>
		<div class="terminal-toolbar">
			<button
				bind:this={toggleButton}
				type="button"
				class="terminal-toggle"
				data-terminal-action="toggle"
				aria-expanded={isOpen}
				aria-controls="workbench-terminal-panel"
				onclick={() => isOpen ? void closePanel() : void openPanel()}
			>
				{t('終端機', 'Terminal')}
			</button>
			{#if isOpen}
				{#if phase === 'ready'}
					<button type="button" data-terminal-action="start" onclick={startShell}>
						{t('啟動終端機', 'Start terminal')}
					</button>
				{:else if phase === 'exited'}
					<button type="button" data-terminal-action="restart" onclick={startShell}>
						{t('重新啟動', 'Restart terminal')}
					</button>
				{:else if phase === 'error'}
					<button type="button" data-terminal-action="retry" onclick={startShell}>
						{t('重試終端機', 'Retry terminal')}
					</button>
				{:else if phase === 'unavailable'}
					<button type="button" data-terminal-action="retry-availability" onclick={retryAvailability}>
						{t('重新檢查', 'Check again')}
					</button>
				{:else if phase === 'cleanup-error'}
					<button type="button" data-terminal-action="retry-cleanup" onclick={closePanel}>
						{t('重試清理', 'Retry cleanup')}
					</button>
				{/if}
				<span
					bind:this={statusElement}
					class="terminal-status"
					role={phase === 'error' || phase === 'unavailable' || phase === 'cleanup-error' ? 'alert' : 'status'}
					tabindex="-1"
				>{statusText}</span>
				<button type="button" data-terminal-action="close" onclick={closePanel}>
					{t('關閉終端機', 'Close terminal')}
				</button>
			{/if}
		</div>
		<div
			id="workbench-terminal-panel"
			class="terminal-panel"
			hidden={!isOpen}
			aria-label={t('互動式終端機', 'Interactive terminal')}
		>
			{#if isOpen}
				{#if viewReady}
					<div
						bind:this={terminalHost}
						class="terminal-host"
						aria-label={t('終端機輸入與輸出', 'Terminal input and output')}
					></div>
				{:else}
					<p
						class="terminal-message"
						role={phase === 'error' || phase === 'unavailable' || phase === 'cleanup-error' ? 'alert' : 'status'}
					>{statusText}</p>
				{/if}
			{/if}
		</div>
	</section>
{/if}

<style>
	.terminal-dock {
		flex: 0 0 auto;
		min-width: 0;
		border-top: 1px solid var(--line);
		background: var(--surface);
	}
	.terminal-toolbar {
		min-height: 40px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
		background: var(--canvas);
	}
	.terminal-toolbar button {
		min-height: 28px;
		padding: 4px 10px;
	}
	.terminal-toggle[aria-expanded='true'] {
		color: var(--accent);
		background: var(--selection);
	}
	.terminal-status {
		flex: 1;
		min-width: 0;
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.terminal-status[role='alert'],
	.terminal-message[role='alert'] {
		color: var(--error);
	}
	.terminal-panel {
		display: flex;
		min-width: 0;
		min-height: 120px;
		height: min(32dvh, 320px);
		padding: 8px 12px;
		background: var(--surface);
	}
	.terminal-host {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	.terminal-message {
		margin: 0;
		align-self: center;
		padding: 8px 4px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	@media (max-width: 620px) {
		.terminal-toolbar {
			flex-wrap: wrap;
		}
		.terminal-status {
			flex-basis: 100%;
			order: 3;
		}
		.terminal-panel {
			height: min(38dvh, 280px);
		}
	}
</style>
