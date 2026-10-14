<script lang="ts">
	import type { Preferences } from '../state/preferences.ts';
	import { text } from '../i18n/text.ts';

	let { preferences, notice, locale, onChange, onRestore }: {
		preferences: Preferences;
		notice: string;
		locale?: import('../i18n/text.ts').Language;
		onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
		onRestore: () => void;
	} = $props();

	let activeSection = $state('general-preferences');

	const t = (zh: string, en: string) => text(locale ?? preferences.language, zh, en);

	type FontErrorKey = 'empty' | 'nonInteger' | 'range';
	let fontErrorKey = $state<FontErrorKey | null>(null);
	let fontDraft = $state<string | null>(null);
	let lastSyncedFontSize: number | null = null;

	$effect(() => {
		const currentPref = preferences.sourceFontSize;
		if (lastSyncedFontSize === null) {
			lastSyncedFontSize = currentPref;
			return;
		}
		if (currentPref !== lastSyncedFontSize) {
			lastSyncedFontSize = currentPref;
			fontDraft = String(currentPref);
			fontErrorKey = null;
		}
	});

	const effectiveFontDraft = $derived(fontDraft ?? String(preferences.sourceFontSize));
	const fontErrorMessage = $derived.by(() => {
		if (!fontErrorKey) return '';
		switch (fontErrorKey) {
			case 'empty':
				return t('請輸入 12 至 24 之間的整數', 'Enter an integer between 12 and 24');
			case 'nonInteger':
				return t('字型大小必須為整數', 'Font size must be an integer');
			case 'range':
				return t('字型大小必須介於 12 至 24 px 之間', 'Font size must be between 12 and 24 px');
		}
	});

	function validateAndCommitFontSize(raw: string) {
		const trimmed = raw.trim();
		if (trimmed === '') {
			fontErrorKey = 'empty';
			return;
		}
		const num = Number(trimmed);
		if (Number.isNaN(num)) {
			fontErrorKey = 'empty';
			return;
		}
		if (!Number.isInteger(num)) {
			fontErrorKey = 'nonInteger';
			return;
		}
		if (num < 12 || num > 24) {
			fontErrorKey = 'range';
			return;
		}
		fontErrorKey = null;
		fontDraft = String(num);
		onChange('sourceFontSize', num);
	}

	function handleFontInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		fontDraft = input.value;
		if (fontErrorKey !== null) {
			const trimmed = input.value.trim();
			if (trimmed !== '') {
				const num = Number(trimmed);
				if (!Number.isNaN(num) && Number.isInteger(num) && num >= 12 && num <= 24) {
					fontErrorKey = null;
				}
			}
		}
	}

	function handleFontChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		fontDraft = input.value;
		validateAndCommitFontSize(input.value);
	}

	function restoreSettings() {
		onRestore();
		fontDraft = null;
		fontErrorKey = null;
	}

	function navigateToSection(id: string) {
		activeSection = id;
		const target = document.getElementById(id);
		if (target) {
			target.scrollIntoView?.({ block: 'start' });
			target.focus();
		}
	}
</script>

<main class="settings-page" aria-labelledby="settings-heading">
	<aside aria-label={t('設定分類', 'Settings sections')}>
		<button
			type="button"
			class="text-button"
			aria-current={activeSection === 'general-preferences' ? 'true' : undefined}
			onclick={() => navigateToSection('general-preferences')}
		>{t('一般', 'General')}</button>
		<button
			type="button"
			class="text-button"
			aria-current={activeSection === 'appearance' ? 'true' : undefined}
			onclick={() => navigateToSection('appearance')}
		>{t('外觀', 'Appearance')}</button>
		<button
			type="button"
			class="text-button"
			aria-current={activeSection === 'editor-preferences' ? 'true' : undefined}
			onclick={() => navigateToSection('editor-preferences')}
		>{t('編輯器', 'Editor')}</button>
		<button
			type="button"
			class="text-button"
			aria-current={activeSection === 'shortcut-preferences' ? 'true' : undefined}
			onclick={() => navigateToSection('shortcut-preferences')}
		>{t('快捷鍵', 'Shortcuts')}</button>
		<button
			type="button"
			class="text-button"
			aria-current={activeSection === 'restore-preferences' ? 'true' : undefined}
			onclick={() => navigateToSection('restore-preferences')}
		>{t('恢復預設值', 'Restore defaults')}</button>
	</aside>
	<div class="settings-content">
		<header>
			<h1 id="settings-heading" tabindex="-1">{t('設定', 'Settings')}</h1>
			<a href="#/workbench">{t('返回工作台', 'Back to workbench')}</a>
		</header>
		<section aria-labelledby="general-preferences">
			<h2 id="general-preferences" tabindex="-1">{t('一般', 'General')}</h2>
			<div class="setting-row">
				<label for="language-value">{t('語言', 'Language')}</label>
				<select
					id="language-value"
					value={preferences.language}
					onchange={(event) => onChange('language', event.currentTarget.value as Preferences['language'])}
				>
					<option value="zh-Hant" lang="zh-Hant">繁體中文</option>
					<option value="en" lang="en">English</option>
				</select>
			</div>
		</section>
		<section aria-labelledby="appearance">
			<h2 id="appearance" tabindex="-1">{t('外觀', 'Appearance')}</h2>
			<div class="setting-row">
				<label for="appearance-value">{t('色彩模式', 'Color mode')}</label>
				<select
					id="appearance-value"
					value={preferences.appearance}
					onchange={(event) => onChange('appearance', event.currentTarget.value as Preferences['appearance'])}
				>
					<option value="system">{t('跟隨系統', 'System')}</option>
					<option value="light">{t('淺色', 'Light')}</option>
					<option value="dark">{t('深色', 'Dark')}</option>
				</select>
			</div>
		</section>
		<section aria-labelledby="editor-preferences">
			<h2 id="editor-preferences" tabindex="-1">{t('原始碼編輯器', 'Source editor')}</h2>
			<div class="setting-row">
				<label for="source-font-size">{t('字型大小', 'Font size')}</label>
				<div class="number-control-group">
					<div class="number-field">
						<input
							id="source-font-size"
							type="number"
							min="12"
							max="24"
							step="1"
							value={effectiveFontDraft}
							aria-invalid={fontErrorKey !== null ? 'true' : undefined}
							aria-describedby={fontErrorKey !== null ? 'source-font-size-error' : undefined}
							oninput={handleFontInput}
							onchange={handleFontChange}
						/>
						<span>px</span>
					</div>
					{#if fontErrorMessage}
						<p id="source-font-size-error" class="inline-field-error" role="alert">{fontErrorMessage}</p>
					{/if}
				</div>
			</div>
			<div class="setting-row">
				<label for="source-line-numbers">{t('顯示行號', 'Show line numbers')}</label>
				<input
					id="source-line-numbers"
					type="checkbox"
					checked={preferences.showLineNumbers}
					onchange={(event) => onChange('showLineNumbers', event.currentTarget.checked)}
				/>
			</div>
			<div class="setting-row">
				<label for="source-wrapping">{t('自動換行', 'Wrap lines')}</label>
				<input
					id="source-wrapping"
					type="checkbox"
					checked={preferences.wrapLines}
					onchange={(event) => onChange('wrapLines', event.currentTarget.checked)}
				/>
			</div>
		</section>
		{#if notice}
			<p class="settings-notice" role="status">{notice}</p>
		{/if}
		<section aria-labelledby="shortcut-preferences">
			<h2 id="shortcut-preferences" tabindex="-1">{t('快捷鍵', 'Shortcuts')}</h2>
			<div class="setting-row">
				<label for="compile-shortcut">{t('編譯 PDF', 'Compile PDF')}</label>
				<select
					id="compile-shortcut"
					value={preferences.compileShortcut}
					onchange={(event) => onChange('compileShortcut', event.currentTarget.value as Preferences['compileShortcut'])}
				>
					<option value="mod-enter">Ctrl / Command + Enter</option>
					<option value="mod-shift-b">Ctrl / Command + Shift + B</option>
					<option value="none">{t('不使用快捷鍵', 'Disabled')}</option>
				</select>
			</div>
			<p class="settings-notice">{t('Ctrl／Command + O 開啟文件；Ctrl／Command + S 儲存。編譯快捷鍵僅在工作台使用。', 'Ctrl / Command + O opens a document; Ctrl / Command + S saves. The compile shortcut is available in the workbench.')}</p>
		</section>
		<section aria-labelledby="restore-preferences">
			<h2 id="restore-preferences" tabindex="-1">{t('恢復預設值', 'Restore defaults')}</h2>
			<div class="setting-row">
				<span>{t('將支援的前端介面設定（語言、色彩模式、編輯器與快捷鍵）恢復為預設值。不會變更文件內容、編譯引擎或快取。', 'Restore supported frontend preferences (language, color mode, editor, shortcuts) to defaults. Document content, compile engine, and cache are not affected.')}</span>
				<button type="button" class="restore-button" onclick={restoreSettings}>{t('恢復預設值', 'Restore defaults')}</button>
			</div>
		</section>
	</div>
</main>

<style>
	.settings-page {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr);
		background: var(--canvas);
	}
	aside {
		padding: 24px 16px;
		border-right: 1px solid var(--line);
		background: var(--surface);
		min-width: 0;
	}
	aside button {
		display: block;
		padding: 8px 12px;
		color: var(--ink);
		border-radius: 4px;
		min-height: 36px;
		width: 100%;
		text-align: left;
		min-width: 0;
		overflow-wrap: break-word;
		word-break: break-word;
	}
	aside button[aria-current='true'] {
		background: var(--selection);
		color: var(--accent);
		font-weight: 600;
	}
	.settings-content {
		overflow: auto;
		padding: 32px clamp(16px, 5vw, 80px);
		min-width: 0;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		max-width: 900px;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 26px;
		font-weight: 650;
		min-width: 0;
		overflow-wrap: break-word;
	}
	header a {
		color: var(--accent);
		text-underline-offset: 3px;
	}
	section {
		max-width: 900px;
		margin: 32px 0;
		min-width: 0;
	}
	h2 {
		margin: 0 0 16px;
		padding-bottom: 12px;
		font-size: 18px;
		border-bottom: 1px solid var(--line);
		min-width: 0;
		overflow-wrap: break-word;
	}
	h2:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}
	.setting-row {
		display: grid;
		grid-template-columns: minmax(120px, 1fr) minmax(160px, 280px);
		align-items: center;
		gap: 16px;
		padding: 12px 0;
		min-width: 0;
	}
	.setting-row label,
	.setting-row span {
		min-width: 0;
		overflow-wrap: break-word;
		word-break: break-word;
	}
	input, select {
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 4px;
		min-height: 36px;
		padding: 6px 10px;
		min-width: 0;
		max-width: 100%;
		box-sizing: border-box;
	}
	input[type='checkbox'] {
		width: 20px;
		height: 20px;
		min-height: 20px;
		accent-color: var(--accent);
		margin: 0;
		justify-self: start;
	}
	.number-control-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.number-field {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.number-field input {
		width: 100px;
		font-variant-numeric: tabular-nums;
	}
	.inline-field-error {
		margin: 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--error);
		overflow-wrap: break-word;
		word-break: break-word;
	}
	.restore-button {
		justify-self: start;
	}
	.settings-notice {
		max-width: 65ch;
		color: var(--muted);
		line-height: 1.6;
		min-width: 0;
		overflow-wrap: break-word;
	}
	@media (max-width: 620px) {
		.settings-page {
			grid-template-columns: minmax(0, 1fr);
		}
		aside {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			padding: 8px 16px;
			border-right: none;
			border-bottom: 1px solid var(--line);
		}
		aside button {
			width: auto;
			max-width: 100%;
			text-align: center;
		}
		.settings-content {
			padding: 24px 16px;
		}
		.setting-row {
			grid-template-columns: minmax(0, 1fr);
			gap: 8px;
		}
	}
</style>
