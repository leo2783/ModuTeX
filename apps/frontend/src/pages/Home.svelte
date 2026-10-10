<script lang="ts">
	import { templateOptions, type TemplateId } from '../features/files/templates.ts';
	import type { RecentDocument } from '../features/files/recent.ts';
	import { text, type Language } from '../i18n/text.ts';
	let { locale = 'zh-Hant', desktop, busy, currentName = '', dirty = false, recent = [], recentNotice = '', onRecent, onRemoveRecent, onOpen, onCreate }: { locale?: Language;
		desktop: boolean; busy: boolean; currentName?: string; dirty?: boolean;
		recent?: readonly RecentDocument[]; recentNotice?: string;
		onRecent?: (id: string) => void; onRemoveRecent?: (id: string) => void;
		onOpen: (kind: 'file' | 'folder') => void; onCreate: (id: TemplateId) => void;
	} = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
	const templateText = { blank: ['Blank document', 'Minimal LaTeX document'], article: ['Article', 'Title and sections'], report: ['Report', 'Title and chapters'] } as const;
</script>

<main class="home" aria-labelledby="home-title">
	<div class="home-content">
		<h1 id="home-title">{t('文件', 'Documents')}</h1>
		<div class="open-actions" role="group" aria-label={t('開啟或建立文件', 'Open or create a document')}>
			<button type="button" onclick={() => onOpen('file')} disabled={busy}>{t('開啟文件', 'Open document')}</button>
			{#if desktop}<button type="button" onclick={() => onOpen('folder')} disabled={busy}>{t('開啟資料夾', 'Open folder')}</button>{/if}
			<button type="button" onclick={() => onCreate('blank')} disabled={busy}>{t('新文件', 'New document')}</button>
		</div>
		{#if currentName}
			<section class="current-document" aria-labelledby="current-title">
				<h2 id="current-title">{t('目前文件', 'Current document')}</h2>
				<a href="#/workbench"><span>{currentName}</span><span>{dirty ? t('未儲存', 'Unsaved') : t('回到工作台', 'Back to workbench')}</span></a>
			</section>
		{/if}
		{#if desktop}
			<section class="recent" aria-labelledby="recent-title">
				<h2 id="recent-title">{t('最近文件', 'Recent documents')}</h2>
				{#if recentNotice}<p role="status">{recentNotice}</p>{/if}
				{#if recent.length}<ul>{#each recent as item (item.id)}<li class="recent-row">
					<button type="button" class="recent-open" onclick={() => onRecent?.(item.id)} disabled={busy || !onRecent} aria-label={t('開啟', 'Open') + ` ${item.label}${item.entryPath ? ' / ' + item.entryPath : ''}`}>
						<span class="recent-path">{item.label}{item.entryPath ? ' / ' + item.entryPath : ''}</span>
					</button>
					<button type="button" class="recent-remove" onclick={() => onRemoveRecent?.(item.id)} disabled={busy || !onRemoveRecent} aria-label={t(`移除 ${item.label} 的紀錄`, `Remove ${item.label} from recent documents`)}>{t('移除', 'Remove')}</button>
				</li>{/each}</ul>{:else if !recentNotice}<p class="empty-recent">{t('尚未開啟文件。', 'No documents opened yet.')}</p>{/if}
			</section>
		{/if}
		<section class="templates" aria-labelledby="templates-title">
			<h2 id="templates-title">{t('從模板開始', 'Start from a template')}</h2>
			<ul>{#each templateOptions as option (option.id)}<li>
				<button type="button" class="template-button" onclick={() => onCreate(option.id)} disabled={busy}><strong>{t(option.title, templateText[option.id][0])}</strong><span>{t(option.description, templateText[option.id][1])}</span></button>
			</li>{/each}</ul>
		</section>
		{#if !desktop}<p class="browser-note">{t('瀏覽器可編輯與預覽；儲存文件與編譯請使用桌面版。', 'You can edit and preview in the browser. Use the desktop app to save and compile documents.')}</p>{/if}
		<nav class="help-links" aria-label={t('文件說明', 'Document help')}><a href="#/help/getting-started">{t('開始使用', 'Getting started')}</a><a href="#/help/licenses">{t('授權', 'Licenses')}</a></nav>
	</div>
</main>

<style>
	.home {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: clamp(20px, 4vw, 48px) clamp(16px, 3vw, 24px);
		box-sizing: border-box;
	}
	.home-content {
		max-width: 72ch;
		width: 100%;
		min-width: 0;
		margin-inline: auto;
		box-sizing: border-box;
	}
	h1 { margin: 0 0 24px; font-size: 28px; font-weight: 650; overflow-wrap: anywhere; }
	h2 { margin: 0 0 16px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
	.open-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		max-width: 100%;
	}
	.open-actions button {
		max-width: 100%;
		overflow-wrap: anywhere;
		white-space: normal;
		text-align: center;
	}
	.current-document, .templates, .recent { margin-top: 40px; min-width: 0; }
	.recent-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
	}
	.recent-row .recent-open {
		flex: 1 1 auto;
		min-width: 0;
		text-align: start;
		padding: 8px 12px;
	}
	.recent-path {
		display: block;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
		line-height: 1.45;
	}
	.recent-row .recent-remove {
		flex: 0 0 auto;
		width: auto;
		white-space: nowrap;
		color: var(--muted);
		padding: 8px 10px;
	}
	.empty-recent { color: var(--muted); margin: 8px 0; }
	.current-document a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		color: var(--ink);
		padding: 16px 0;
		border-block: 1px solid var(--line);
		text-decoration: none;
		min-width: 0;
	}
	.current-document a span:first-child {
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
		line-height: 1.45;
	}
	.current-document a span:last-child {
		color: var(--muted);
		flex-shrink: 0;
		white-space: nowrap;
	}
	ul { margin: 0; padding: 0; list-style: none; min-width: 0; }
	li { min-width: 0; }
	li + li { border-top: 1px solid var(--line); }
	.template-button {
		width: 100%;
		display: flex;
		align-items: baseline;
		text-align: start;
		gap: 24px;
		padding: 16px 8px;
		border: none;
		border-radius: 4px;
		background: transparent;
		min-width: 0;
		box-sizing: border-box;
	}
	.template-button:hover:not(:disabled),
	.template-button:focus-visible {
		background: var(--selection);
	}
	li strong {
		min-width: 6em;
		font-weight: 600;
		flex-shrink: 0;
		overflow-wrap: anywhere;
	}
	li span, .browser-note {
		color: var(--muted);
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	.browser-note { margin-top: 24px; line-height: 1.6; }
	.help-links {
		display: flex;
		flex-wrap: wrap;
		gap: 16px 24px;
		margin-top: 40px;
		max-width: 100%;
	}
	.help-links a {
		color: var(--accent);
		text-underline-offset: 3px;
		padding-block: 6px;
		overflow-wrap: anywhere;
	}
	@media (max-width: 480px) {
		.home { padding: 20px 12px; }
		.template-button {
			flex-direction: column;
			align-items: start;
			gap: 6px;
			padding: 12px 6px;
		}
		li strong { min-width: 0; }
		.current-document a {
			flex-direction: column;
			align-items: start;
			gap: 6px;
		}
		.current-document a span:last-child {
			white-space: normal;
		}
	}
</style>
