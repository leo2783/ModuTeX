<script lang="ts">
	import changelog from '../../../../CHANGELOG.md?raw';
	import limitations from '../../../../docs/user/KNOWN_LIMITATIONS.md?raw';
	import { contentBlocks, inlineParts, releaseNotes, type ReleaseNote } from '../features/release-notes/content.ts';
	import { text, type Language } from '../i18n/text.ts';

	let { showLimitations = false, locale = 'zh-Hant' }: { showLimitations?: boolean; locale?: Language } = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
	const loaded: { records: readonly ReleaseNote[]; failed: boolean } = (() => {
		try { return { records: releaseNotes(changelog), failed: false }; }
		catch { return { records: [], failed: true }; }
	})();
	const { records, failed } = loaded;
	let selected = $state(0);
	let heading = $state<HTMLHeadingElement | null>(null);
	let versionHeading = $state<HTMLHeadingElement | null>(null);
	let lastLimitations: boolean | null = null;

	const note = $derived(records[selected]);
	const blocks = $derived(showLimitations ? contentBlocks(limitations) : note?.blocks ?? []);

	function selectVersion(index: number) {
		selected = index;
		if (showLimitations && typeof window !== 'undefined') {
			window.location.hash = '#/release-notes';
		}
		(versionHeading ?? heading)?.focus();
	}

	function selectLimitations() {
		heading?.focus();
	}

	$effect(() => {
		const current = showLimitations;
		if (lastLimitations === null) {
			lastLimitations = current;
			return;
		}
		if (current !== lastLimitations) {
			lastLimitations = current;
			if (current) {
				heading?.focus();
			} else {
				(versionHeading ?? heading)?.focus();
			}
		}
	});
</script>

{#snippet inline(text: string)}
	{#each inlineParts(text) as part}
		{#if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'link'}<a href={part.href}>{part.text}</a>{:else}{part.text}{/if}
	{/each}
{/snippet}
<main class="release-page" aria-labelledby="release-heading">
	<aside aria-label={t('版本索引', 'Release index')}>
		<h2>{t('版本', 'Versions')}</h2>
		{#each records as record, index (record.version)}
			<a
				href="#/release-notes"
				class="version-nav-link"
				aria-current={!showLimitations && selected === index ? 'page' : undefined}
				onclick={() => selectVersion(index)}
			>{record.version}</a>
		{/each}
		<a
			href="#/release-notes/limitations"
			class="version-nav-link"
			aria-current={showLimitations ? 'page' : undefined}
			onclick={selectLimitations}
		>{t('已知限制', 'Known limitations')}</a>
	</aside>
	<div class="reading-pane">
		<header>
			<h1 id="release-heading" bind:this={heading} tabindex="-1">{showLimitations ? t('0.1.0 已知限制', '0.1.0 known limitations') : t('版本紀錄', 'Release notes')}</h1>
			<a href="#/workbench">{t('返回工作台', 'Back to workbench')}</a>
		</header>
		{#if failed}
			<p role="alert">{t('無法讀取版本紀錄。請確認程式檔案完整。', 'Unable to read release notes. Check that the application files are complete.')}</p>
		{:else if !showLimitations && !note}
			<p>{t('尚無版本紀錄。', 'No release notes available.')}</p>
		{:else}
			{#if !showLimitations && note}
				<div class="version-heading">
					<h2 id="version-heading" bind:this={versionHeading} tabindex="-1">{note.version}</h2>
					{#if note.status}<span>{note.status}</span>{/if}
				</div>
			{/if}
			<article lang={showLimitations ? 'zh-Hant' : 'en'} aria-label={showLimitations ? t('已知限制', 'Known limitations') : t('版本紀錄', 'Changelog')}>
				{#each blocks as block}
					{#if block.kind === 'heading'}<h3>{block.text}</h3>
					{:else if block.kind === 'list'}<ul>{#each block.items as item}<li>{@render inline(item)}</li>{/each}</ul>
					{:else if block.kind === 'code'}<div class="code-container"><pre class="code-block"><code>{block.text}</code></pre></div>
					{:else}<p>{@render inline(block.text)}</p>{/if}
				{/each}
			</article>
		{/if}
	</div>
</main>
<style>
	.release-page {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: grid;
		grid-template-columns: minmax(160px, 18fr) minmax(0, 82fr);
		background: var(--surface);
	}
	aside {
		padding: 24px 12px;
		border-right: 1px solid var(--line);
		overflow-y: auto;
		overflow-x: hidden;
		min-width: 0;
	}
	aside h2 {
		font-size: 16px;
		margin: 0 12px 16px;
		overflow-wrap: anywhere;
	}
	aside a {
		display: block;
		padding: 10px 12px;
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
		word-break: break-word;
		line-height: 1.4;
		border-radius: 4px;
	}
	aside a:hover {
		background: var(--selection);
	}
	aside a:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	aside [aria-current='page'] {
		background: var(--selection);
		color: var(--accent);
		font-weight: 600;
	}
	.reading-pane {
		min-width: 0;
		max-width: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 40px clamp(20px, 5vw, 64px);
		box-sizing: border-box;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 16px;
		border-bottom: 1px solid var(--line);
		padding-bottom: 24px;
		min-width: 0;
	}
	h1 {
		font-size: 28px;
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
		word-break: break-word;
		min-width: 0;
	}
	h1:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 4px;
	}
	a { color: var(--accent); text-underline-offset: 3px; }
	.version-heading {
		display: flex;
		align-items: baseline;
		gap: 16px;
		flex-wrap: wrap;
		margin: 24px 0;
		min-width: 0;
	}
	.version-heading h2 { margin: 0; font-size: 24px; overflow-wrap: anywhere; }
	.version-heading h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
	.version-heading span { color: var(--muted); }
	article {
		max-width: 72ch;
		min-width: 0;
		line-height: 1.7;
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	article h3 {
		font-size: 19px;
		margin: 28px 0 12px;
		padding-top: 20px;
		border-top: 1px solid var(--line);
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	article li { margin-block: 8px; overflow-wrap: anywhere; word-break: break-word; }
	.code-container {
		max-width: 72ch;
		min-width: 0;
		margin: 16px 0;
		border-radius: 4px;
		overflow: hidden;
	}
	.code-block {
		background: var(--canvas);
		padding: 16px;
		overflow-x: auto;
		white-space: pre;
		margin: 0;
		max-width: 100%;
		-webkit-overflow-scrolling: touch;
	}
	code { font: 0.95em Consolas, monospace; }
	@media (max-width: 620px) {
		.release-page { display: flex; flex-direction: column; }
		aside {
			flex: none;
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
			padding: 12px 8px;
			border-right: none;
			border-bottom: 1px solid var(--line);
			max-width: 100%;
			box-sizing: border-box;
		}
		aside h2 { width: 100%; margin: 0 0 4px; }
		aside a { padding: 8px 10px; font-size: 14px; }
		.reading-pane { padding: 24px 16px; }
	}
</style>
