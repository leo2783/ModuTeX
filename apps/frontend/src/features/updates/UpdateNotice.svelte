<script lang="ts">
	import { onMount } from 'svelte';
	import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
	import { text as localizedText, type Language } from '../../i18n/text.ts';

	type Phase = 'checking' | 'available' | 'downloading' | 'ready' | 'preparing' | 'installing' | 'dismissed';
	type Failure = 'download' | 'prepare' | 'install' | null;
	type BusyReason = 'compiling' | 'busy' | null;

	interface Props {
		readonly language: Language;
		readonly installAllowed: boolean;
		readonly needsSave: boolean;
		readonly busyReason: BusyReason;
		readonly beforeInstall: () => Promise<boolean>;
		readonly canInstall: () => boolean;
	}

	let { language, installAllowed, needsSave, busyReason, beforeInstall, canInstall }: Props = $props();
	let phase = $state<Phase>('checking');
	let failure = $state<Failure>(null);
	let version = $state('');
	let currentVersion = $state('');
	let downloadTotal = $state<number | null>(null);
	let downloadedBytes = $state(0);
	let pausedAfterDownload = $state(false);
	let activeUpdate: Update | null = null;
	let disposed = false;
	let operationId = 0;
	const closedUpdates = new WeakSet<object>();

	const progressPercent = $derived(
		downloadTotal !== null && downloadTotal > 0
			? Math.min(100, Math.floor((downloadedBytes / downloadTotal) * 100))
			: null
	);

	function t(traditionalChinese: string, english: string): string {
		return localizedText(language, traditionalChinese, english);
	}

	function closeUpdate(update: Update): void {
		if (closedUpdates.has(update)) return;
		closedUpdates.add(update);
		try {
			void Promise.resolve(update.close()).catch(() => {});
		} catch {}
	}

	async function checkForUpdate(): Promise<void> {
		let candidate: Update | null = null;
		try {
			const { check } = await import('@tauri-apps/plugin-updater');
			if (disposed) return;
			candidate = await check({ timeout: 15_000 });
			if (!candidate) {
				if (!disposed) phase = 'dismissed';
				return;
			}
			if (disposed) {
				closeUpdate(candidate);
				return;
			}
			activeUpdate = candidate;
			version = candidate.version.slice(0, 128);
			currentVersion = candidate.currentVersion.slice(0, 128);
			phase = 'available';
		} catch {
			if (candidate) {
				if (activeUpdate === candidate) activeUpdate = null;
				closeUpdate(candidate);
			}
			if (!disposed) phase = 'dismissed';
		}
	}

	async function downloadUpdate(): Promise<void> {
		const update = activeUpdate;
		if (!update || phase !== 'available') return;

		const operation = ++operationId;
		failure = null;
		pausedAfterDownload = false;
		downloadTotal = null;
		downloadedBytes = 0;
		phase = 'downloading';

		try {
			await update.download(
				(event: DownloadEvent) => {
					if (
						disposed ||
						operation !== operationId ||
						phase !== 'downloading' ||
						activeUpdate !== update
					) {
						return;
					}
					if (event.event === 'Started') {
						const total = event.data.contentLength;
						downloadTotal =
							typeof total === 'number' && Number.isSafeInteger(total) && total > 0
								? total
								: null;
						downloadedBytes = 0;
					} else if (event.event === 'Progress') {
						const chunkLength = event.data.chunkLength;
						if (Number.isFinite(chunkLength) && chunkLength > 0) {
							downloadedBytes = Math.min(
								Number.MAX_SAFE_INTEGER,
								downloadedBytes + chunkLength
							);
						}
					}
				},
				{ timeout: 300_000 }
			);
		} catch {
			if (disposed) {
				closeUpdate(update);
				return;
			}
			if (operation !== operationId || phase !== 'downloading' || activeUpdate !== update) return;
			failure = 'download';
			phase = 'available';
			return;
		}

		if (disposed) {
			closeUpdate(update);
			return;
		}
		if (operation !== operationId || phase !== 'downloading' || activeUpdate !== update) return;
		pausedAfterDownload = !installAllowed || !canInstall();
		phase = 'ready';
	}

	async function installUpdate(): Promise<void> {
		const update = activeUpdate;
		if (!update || phase !== 'ready') return;
		if (!installAllowed) {
			failure = 'prepare';
			pausedAfterDownload = true;
			return;
		}

		const operation = ++operationId;
		failure = null;
		phase = 'preparing';
		let prepared = false;
		try {
			prepared = await beforeInstall();
		} catch {
			prepared = false;
		}

		if (disposed) {
			closeUpdate(update);
			return;
		}
		if (operation !== operationId || phase !== 'preparing' || activeUpdate !== update) return;

		let canInstallNow = false;
		try {
			canInstallNow = prepared && canInstall();
		} catch {
			canInstallNow = false;
		}
		if (!canInstallNow) {
			failure = 'prepare';
			pausedAfterDownload = !installAllowed || !canInstall();
			phase = 'ready';
			return;
		}

		phase = 'installing';
		try {
			await update.install();
		} catch {
			if (disposed) {
				closeUpdate(update);
				return;
			}
			if (operation !== operationId || phase !== 'installing' || activeUpdate !== update) return;
			failure = 'install';
			phase = 'ready';
			return;
		}

		if (disposed) {
			closeUpdate(update);
			return;
		}
		if (operation !== operationId || phase !== 'installing' || activeUpdate !== update) return;
		activeUpdate = null;
		closeUpdate(update);
		pausedAfterDownload = false;
		phase = 'dismissed';
	}

	function later(): void {
		if (phase === 'downloading' || phase === 'installing') return;
		operationId += 1;
		const update = activeUpdate;
		activeUpdate = null;
		if (update) closeUpdate(update);
		failure = null;
		pausedAfterDownload = false;
		phase = 'dismissed';
	}

	onMount(() => {
		void checkForUpdate();
		return () => {
			disposed = true;
			operationId += 1;
			const update = activeUpdate;
			activeUpdate = null;
			if (update && phase !== 'downloading' && phase !== 'installing') closeUpdate(update);
		};
	});
</script>

{#if phase === 'available' || phase === 'downloading' || phase === 'ready' || phase === 'preparing' || phase === 'installing'}
	<section class="update-notice" aria-label={t('軟體更新', 'Software update')}>
		<div class="notice-copy">
			<strong>{t('有可用更新', 'Update available')}</strong>
			<p>
				{t('目前版本', 'Current version')} {currentVersion}
				<span aria-hidden="true">→</span>
				{t('更新版本', 'Update version')} {version}
			</p>
		</div>

		{#if phase === 'downloading'}
			<div class="download-progress">
				<p role="status" aria-live="polite">
					{t('正在下載更新', 'Downloading update')}
					{#if progressPercent !== null} {progressPercent}%{/if}
				</p>
				{#if downloadTotal !== null && progressPercent !== null}
					<progress
						max={downloadTotal}
						value={Math.min(downloadedBytes, downloadTotal)}
						aria-label={t('更新下載進度', 'Update download progress')}
					></progress>
				{:else}
					<progress aria-label={t('更新下載進度', 'Update download progress')}></progress>
				{/if}
			</div>
		{/if}

		{#if phase === 'ready' && busyReason === 'compiling'}
			<p class="notice-message" role="status" aria-live="polite">
				{t('正在等待編譯完成，完成後即可安裝更新。', 'Waiting for compilation to finish. You can install the update afterward.')}
			</p>
		{:else if phase === 'ready' && busyReason === 'busy'}
			<p class="notice-message" role="status" aria-live="polite">
				{t('請先完成目前工作，再安裝更新。', 'Finish the current task before installing the update.')}
			</p>
		{:else if phase === 'ready' && needsSave}
			<p class="notice-message" role="status" aria-live="polite">
				{t('請儲存變更，安裝更新時才不會遺失編輯內容。', 'Save your changes before installing the update to keep your edits.')}
			</p>
		{:else if phase === 'ready' && pausedAfterDownload && !canInstall()}
			<p class="notice-message" role="status" aria-live="polite">
				{t('更新已暫停，請先儲存變更或完成目前工作，再安裝更新。', 'The update is paused. Save your changes or finish the current task before installing.')}
			</p>
		{/if}

		{#if phase === 'preparing'}
			<p class="notice-message" role="status" aria-live="polite">
				{needsSave
					? t('正在儲存變更後準備更新…', 'Saving changes before updating…')
					: t('正在確認可以安全安裝更新…', 'Checking that the update can be installed safely…')}
			</p>
		{/if}

		{#if failure === 'download'}
			<p class="notice-error" role="alert">
				{t('更新下載失敗。可以重試。', 'Update download failed. You can retry.')}
			</p>
		{:else if failure === 'prepare'}
			<p class="notice-message" role="status" aria-live="polite">
				{t('更新已暫停，尚未安裝。請檢查儲存狀態後重試。', 'Update paused. Nothing was installed. Check the save status and retry.')}
			</p>
		{:else if failure === 'install'}
			<p class="notice-error" role="alert">
				{t('無法啟動更新安裝程式。可以重試。', 'Could not start the update installer. You can retry.')}
			</p>
		{/if}

		<div class="update-actions">
			{#if phase === 'available'}
				<button class="primary" type="button" onclick={downloadUpdate}>
					{failure === 'download' ? t('重試下載更新', 'Retry download') : t('下載更新', 'Download update')}
				</button>
			{:else if phase === 'ready'}
				<button class="primary" type="button" onclick={installUpdate} disabled={!installAllowed}>
					{needsSave ? t('儲存並更新', 'Save and update') : t('安裝更新', 'Install update')}
				</button>
			{:else if phase === 'preparing'}
				<span role="status" aria-live="polite">
					{t('正在準備更新…', 'Preparing update…')}
				</span>
			{:else if phase === 'installing'}
				<span role="status" aria-live="polite">
					{t('正在啟動更新安裝程式', 'Starting the update installer')}
				</span>
			{/if}
			{#if phase === 'available' || phase === 'downloading' || phase === 'ready' || phase === 'preparing'}
				<button type="button" onclick={later} disabled={phase === 'downloading'}>
					{t('稍後', 'Later')}
				</button>
			{/if}
		</div>
	</section>
{/if}

<style>
	.update-notice {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 20px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}

	.notice-copy {
		flex: 1 1 220px;
		min-width: 0;
	}

	.notice-copy p,
	.download-progress p,
	.notice-message,
	.notice-error {
		margin: 4px 0 0;
	}

	.notice-copy p,
	.download-progress p,
	.notice-message {
		color: var(--muted);
	}

	.download-progress {
		flex: 1 1 180px;
		max-width: 320px;
	}

	.download-progress progress {
		display: block;
		width: 100%;
		margin-top: 5px;
		accent-color: var(--accent);
	}

	.notice-error {
		color: var(--error);
	}

	.update-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
	}

	@media (max-width: 700px) {
		.update-actions {
			margin-left: 0;
		}
	}
</style>
