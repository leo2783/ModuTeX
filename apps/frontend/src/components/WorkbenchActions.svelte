<script lang="ts">
	import { text, type Language } from '../i18n/text.ts';
	let { locale, desktop, hasSource, opening, saving, compiling, dirty, missing, cancellationPending,
		onFolder, onOpen, onNew, onSave, onSaveAs, onCompile, onCancel }: {
		locale: Language; desktop: boolean; hasSource: boolean; opening: boolean; saving: boolean;
		compiling: boolean; dirty: boolean; missing: boolean; cancellationPending: boolean;
		onFolder: () => void; onOpen: () => void; onNew: () => void; onSave: () => void;
		onSaveAs: () => void; onCompile: () => void; onCancel: () => void;
	} = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
</script>

<div class="action-group" role="group" aria-label={t('檔案操作', 'File actions')}>
	{#if desktop}<button onclick={onFolder} disabled={opening || saving}>{t('開啟資料夾', 'Open folder')}</button>{/if}
	<button onclick={onOpen} disabled={opening || saving}>{t('開啟文件', 'Open document')}</button>
	<button onclick={onNew} disabled={opening || saving || compiling}>{t('新文件', 'New document')}</button>
	{#if desktop && hasSource}
		<button onclick={onSave} disabled={opening || saving || !dirty || missing}>{saving ? t('儲存中…', 'Saving…') : t('儲存', 'Save')}</button>
		<button onclick={onSaveAs} disabled={opening || saving || compiling}>{t('另存新檔', 'Save as')}</button>
	{/if}
</div>
{#if desktop && hasSource && !missing}
	<div class="action-group compile-actions" role="group" aria-label={t('編譯操作', 'Compile actions')}>
		{#if compiling}<button onclick={onCancel} disabled={cancellationPending}>{cancellationPending ? t('正在取消…', 'Cancelling…') : t('取消編譯', 'Cancel compilation')}</button>
		{:else}<button class="primary" onclick={onCompile} disabled={opening || saving}>{t('編譯 PDF', 'Compile PDF')}</button>{/if}
	</div>
{/if}

<style>
	.action-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.compile-actions { padding-inline-start: 12px; border-inline-start: 1px solid var(--line); }
</style>
