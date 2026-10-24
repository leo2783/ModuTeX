<script lang="ts">
	import type { CompileConfig, CompileProfile, FileEntry, WorkspaceInfo } from '@modutex/frontend-contracts';
	import type { FileDesktopPort } from '../features/files/desktop.ts';
	import { text, type Language } from '../i18n/text.ts';

	let { desktop, workspace, entries, locale = 'zh-Hant' }: {
		desktop: FileDesktopPort | null;
		workspace: WorkspaceInfo | null;
		entries: readonly FileEntry[];
		locale?: Language;
	} = $props();

	const t = (zh: string, en: string) => text(locale, zh, en);

	let config = $state<CompileConfig | null>(null);
	let busy = $state(false);
	let issue = $state('');
	let mainFile = $state('');
	let profile = $state<CompileProfile>('managed');
	let outputDir = $state('');
	let pdf = $state('');
	let log = $state('');
	let customCommand = $state('');

	function adopt(value: CompileConfig) {
		config = value;
		mainFile = value.mainFile ?? '';
		profile = value.profile;
		outputDir = value.outputDir ?? '';
		pdf = value.pdf ?? '';
		log = value.log ?? '';
		customCommand = value.customCommand ?? '';
	}

	async function load() {
		if (!desktop || !workspace) {
			config = null;
			return;
		}
		busy = true;
		issue = '';
		try {
			const next = await desktop.getCompileConfig(workspace.id);
			if (workspace?.id !== next.workspaceId) return;
			adopt(next);
		} catch {
			issue = t('無法讀取編譯設定。', 'Compile configuration could not be read.');
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		const owner = workspace;
		const port = desktop;
		if (!owner || !port) {
			config = null;
			return;
		}
		let current = true;
		void port.getCompileConfig(owner.id).then((next) => {
			if (!current || workspace?.id !== next.workspaceId) return;
			adopt(next);
			issue = '';
		}).catch(() => {
			if (current) issue = t('無法讀取編譯設定。', 'Compile configuration could not be read.');
		});
		return () => { current = false; };
	});

	async function save() {
		if (!desktop || !workspace || !config || busy) return;
		busy = true;
		issue = '';
		try {
			const next = await desktop.updateCompileConfig({
				workspaceId: workspace.id,
				expectedRevision: config.revision,
				mainFile: mainFile || null,
				profile,
				outputDir: outputDir || null,
				pdf: pdf || null,
				log: log || null,
				customCommand: profile === 'custom' ? customCommand : null
			});
			if (workspace?.id === next.workspaceId) adopt(next);
		} catch (error) {
			issue = error instanceof Error && error.message === 'CONFIG_CONFLICT'
				? t('設定已在其他地方變更。請重新載入後再儲存。', 'Configuration changed elsewhere. Reload before saving.')
				: t('設定未儲存。請檢查工作區相對路徑與既有目錄。', 'Configuration was not saved. Check workspace-relative paths and existing directories.');
		} finally {
			busy = false;
		}
	}

</script>

<main class="settings-page" aria-labelledby="compile-settings-title">
	<div class="settings-container">
		<header class="settings-header">
			<h1 id="compile-settings-title">{t('編譯設定', 'Compile settings')}</h1>
		</header>
		{#if !desktop}
			<p class="settings-status" role="status">{t('此執行環境不支援桌面編譯設定。', 'Desktop compile configuration is unavailable in this runtime.')}</p>
		{:else if !workspace}
			<p class="settings-status" role="status">{t('設定編譯設定檔前，請先開啟工作區。', 'Open a workspace before configuring its compile profile.')}</p>
		{:else}
			{#if issue}<p class="settings-alert" role="alert">{issue}</p>{/if}
			<section class="settings-section" aria-labelledby="workspace-profile-heading">
				<fieldset class="settings-fieldset" disabled={busy || !config}>
					<legend class="settings-legend">
						<h2 id="workspace-profile-heading">{t('工作區設定檔', 'Workspace profile')}</h2>
					</legend>
					<div class="fields-stack">
						<div class="form-row two-cols">
							<label for="compile-main-file" class="form-field">
								<span class="field-label">{t('主 TeX 文件', 'Main TeX file')}</span>
								<select id="compile-main-file" bind:value={mainFile}>
									<option value="">{t('選擇主文件', 'Choose a main file')}</option>
									{#each entries.filter((entry) => entry.kind === 'file' && entry.path.toLowerCase().endsWith('.tex')) as entry}
										<option value={entry.path}>{entry.path}</option>
									{/each}
								</select>
							</label>
							<label for="compile-profile" class="form-field">
								<span class="field-label">{t('編譯引擎設定檔', 'Engine profile')}</span>
								<select id="compile-profile" bind:value={profile}>
									<option value="managed">{t('內建引擎', 'Managed')}</option>
									<option value="system">{t('系統 TeX', 'System TeX')}</option>
									<option value="custom" disabled={config ? !config.canSetCommand : true}>{t('使用者授權自訂命令', 'User-authorized custom command')}</option>
								</select>
							</label>
						</div>
						<label for="compile-output-dir" class="form-field">
							<span class="field-label">{t('輸出目錄（必須已存在於工作區內）', 'Output directory (must already exist in the workspace)')}</span>
							<input id="compile-output-dir" bind:value={outputDir} autocomplete="off" spellcheck="false" />
						</label>
						<div class="form-row two-cols">
							<label for="compile-pdf-path" class="form-field">
								<span class="field-label">{t('PDF 路徑（選用；覆寫預設輸出目錄位置）', 'PDF path (optional; overrides the output-directory default)')}</span>
								<input id="compile-pdf-path" bind:value={pdf} autocomplete="off" spellcheck="false" />
							</label>
							<label for="compile-log-path" class="form-field">
								<span class="field-label">{t('記錄路徑（選用；覆寫預設輸出目錄位置）', 'Log path (optional; overrides the output-directory default)')}</span>
								<input id="compile-log-path" bind:value={log} autocomplete="off" spellcheck="false" />
							</label>
						</div>
						{#if profile === 'custom'}
							<label for="compile-custom-command" class="form-field">
								<span class="field-label">{t('受信任的命令範本；請使用 {main} 與 {out} 預留位置', 'Trusted command template; use {main} and {out} placeholders')}</span>
								<input id="compile-custom-command" bind:value={customCommand} maxlength="4096" autocomplete="off" spellcheck="false" />
							</label>
						{/if}
					</div>
				</fieldset>
				<footer class="settings-actions">
					<button type="button" class="primary" onclick={save} disabled={busy || !config}>{t('儲存工作區編譯設定', 'Save workspace compile settings')}</button>
					<button type="button" onclick={load} disabled={busy}>{t('重新載入設定', 'Reload configuration')}</button>
				</footer>
			</section>
		{/if}
	</div>
</main>

<style>
	.settings-page {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		padding: 32px clamp(16px, 5vw, 80px);
		background: var(--canvas);
	}
	.settings-container {
		max-width: 840px;
		margin: 0 auto;
		min-width: 0;
	}
	.settings-header {
		margin-bottom: 32px;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 26px;
		font-weight: 650;
		min-width: 0;
		overflow-wrap: break-word;
		color: var(--ink);
	}
	.settings-section {
		margin: 32px 0;
		min-width: 0;
	}
	.settings-fieldset {
		border: none;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.settings-legend {
		display: block;
		width: 100%;
		padding: 0;
		margin: 0 0 20px;
		min-width: 0;
	}
	h2 {
		margin: 0;
		padding-bottom: 12px;
		font-size: 18px;
		font-weight: 650;
		border-bottom: 1px solid var(--line);
		min-width: 0;
		overflow-wrap: break-word;
		color: var(--ink);
	}
	h2:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}
	.fields-stack {
		display: flex;
		flex-direction: column;
		gap: 20px;
		min-width: 0;
	}
	.form-row.two-cols {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		min-width: 0;
	}
	.form-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}
	.field-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.4;
		min-width: 0;
		overflow-wrap: break-word;
		word-break: break-word;
	}
	input,
	select {
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 4px;
		min-height: 36px;
		padding: 6px 10px;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		font-size: 14px;
	}
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.settings-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		margin-top: 28px;
		padding-top: 20px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}
	.settings-actions button {
		min-height: 36px;
		padding: 7px 16px;
		font: inherit;
		font-size: 14px;
		font-weight: 500;
		border-radius: 4px;
		cursor: pointer;
		min-width: 0;
	}
	.settings-actions button.primary {
		color: var(--surface);
		background: var(--accent);
		border: 1px solid var(--accent);
	}
	.settings-actions button.primary:hover:not(:disabled) {
		filter: brightness(1.08);
	}
	.settings-actions button:disabled {
		opacity: 0.48;
		cursor: not-allowed;
	}
	.settings-alert {
		margin: 0 0 20px;
		padding: 10px 14px;
		border-radius: 4px;
		border: 1px solid var(--error);
		background: var(--surface);
		color: var(--error);
		font-size: 14px;
		line-height: 1.5;
		overflow-wrap: break-word;
	}
	.settings-status {
		color: var(--muted);
		line-height: 1.6;
		margin: 16px 0;
		font-size: 14px;
		overflow-wrap: break-word;
	}
	@media (max-width: 680px) {
		.settings-page {
			padding: 24px 16px;
		}
		.form-row.two-cols {
			grid-template-columns: minmax(0, 1fr);
			gap: 20px;
		}
		.settings-actions {
			flex-direction: column;
			align-items: stretch;
		}
		.settings-actions button {
			width: 100%;
			text-align: center;
		}
	}
</style>
