<script lang="ts">
	import installation from '../../../../docs/user/INSTALLATION.md?raw';
	import agpl from '../../../../LICENSE?raw';
	import apache from '../../../../LICENSES/Apache-2.0.txt?raw';
	import tectonicNotice from '../../../../vendor/notices/TECTONIC-NOTICE.md?raw';
	import tectonicLicense from '../../../../vendor/notices/TECTONIC-LICENSE.txt?raw';
	import drawioNotice from '../../../../vendor/notices/DRAWIO-NOTICE.md?raw';
	import drawioLicense from '../../../../vendor/notices/DRAWIO-LICENSE.txt?raw';
	import frontendNotices from '../../THIRD_PARTY_NOTICES.md?raw';
	import { helpTopics, helpText, type HelpTopic } from '../features/help/topics.ts';
	import { contentBlocks, inlineParts } from '../features/release-notes/content.ts';
	import { text, type Language } from '../i18n/text.ts';
	import { helpEnglish, helpTitles } from '../i18n/help-en.ts';

	let { topic = 'getting-started', locale = 'zh-Hant' }: { topic?: HelpTopic; locale?: Language } = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
	let heading = $state<HTMLHeadingElement | null>(null);
	let lastTopic: HelpTopic | null = null;

	const title = $derived(t(helpTopics.find((item) => item.id === topic)?.title ?? '說明', helpTitles[topic] ?? 'Help'));
	const document = $derived(topic === 'installation' ? installation : (locale === 'en' ? helpEnglish : helpText)[topic] ?? '');
	const loaded = $derived.by(() => { try { return { blocks: contentBlocks(document), failed: false }; } catch { return { blocks: [], failed: true }; } });

	function handleTopicNavigation() {
		heading?.focus();
	}

	$effect(() => {
		const current = topic;
		if (lastTopic === null) {
			lastTopic = current;
			return;
		}
		if (current !== lastTopic) {
			lastTopic = current;
			heading?.focus();
		}
	});

	const notices = $derived([
		{ name: 'Tectonic 0.17.0', notice: tectonicNotice, license: tectonicLicense },
		{ name: 'Draw.io 31.1.8', notice: drawioNotice, license: drawioLicense },
		{ name: t('前端元件', 'Frontend components'), notice: '', license: frontendNotices }
	]);
</script>
{#snippet inline(text: string)}{#each inlineParts(text) as part}{#if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'link'}<a href={part.href}>{part.text}</a>{:else}{part.text}{/if}{/each}{/snippet}
<main class="help-page" aria-labelledby="help-heading">
	<nav aria-label={t('說明分類', 'Help topics')}>
		{#each helpTopics as item}
			<a
				href={'#/help/' + item.id}
				aria-current={topic === item.id ? 'page' : undefined}
				onclick={handleTopicNavigation}
			>{t(item.title, helpTitles[item.id])}</a>
		{/each}
	</nav>
	<div class="reading-pane">
		<header>
			<h1 id="help-heading" bind:this={heading} tabindex="-1">{title}</h1>
			<a href="#/workbench">{t('返回工作台', 'Back to workbench')}</a>
		</header>
		{#if topic === 'agpl' || topic === 'apache'}
			<pre class="license-text" lang="en">{topic === 'agpl' ? agpl : apache}</pre>
		{:else if topic === 'notices'}
			<p>{t('本頁收錄下列元件的附帶聲明與授權；不取代分發物中其他依賴、字型及素材的 notices。', 'These are the bundled notices and licenses for the listed components. Other dependencies, fonts and assets may have additional notices in the distribution.')}</p>
			{#each notices as item}
				<section>
					<h2>{item.name}</h2>
					{#if item.notice}<pre class="notice-text" lang="en">{item.notice}</pre>{/if}
					<details><summary>{t('授權全文', 'Full license text')}</summary><pre class="license-text" lang="en">{item.license}</pre></details>
				</section>
			{/each}
		{:else if loaded.failed}
			<p role="alert">{t('無法讀取說明文件。請確認程式檔案完整。', 'Unable to read help. Check that the application files are complete.')}</p>
		{:else}
			<article lang={topic === 'installation' ? 'zh-Hant' : locale}>
				{#each loaded.blocks as block}
					{#if block.kind === 'heading'}<h2>{block.text}</h2>
					{:else if block.kind === 'list'}<ul>{#each block.items as item}<li>{@render inline(item)}</li>{/each}</ul>
					{:else if block.kind === 'code'}<div class="code-container"><pre class="code-block"><code>{block.text}</code></pre></div>
					{:else}<p>{@render inline(block.text)}</p>{/if}
				{/each}
			</article>
		{/if}
	</div>
</main>
<style>
	.help-page {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: grid;
		grid-template-columns: minmax(180px, 20fr) minmax(0, 80fr);
		background: var(--surface);
	}
	nav {
		padding: 24px 12px;
		overflow-y: auto;
		overflow-x: hidden;
		border-inline-end: 1px solid var(--line);
		min-width: 0;
	}
	nav a {
		display: block;
		padding: 10px 12px;
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
		word-break: break-word;
		line-height: 1.4;
		border-radius: 4px;
	}
	nav a:hover {
		background: var(--selection);
	}
	nav a:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	nav [aria-current='page'] {
		background: var(--selection);
		color: var(--accent);
		font-weight: 600;
	}
	.reading-pane {
		min-width: 0;
		max-width: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 32px 40px;
		font-size: 16px;
		line-height: 1.7;
		box-sizing: border-box;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		border-bottom: 1px solid var(--line);
		padding-bottom: 24px;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 28px;
		font-weight: 600;
		overflow-wrap: anywhere;
		word-break: break-word;
		min-width: 0;
	}
	h1:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 4px;
	}
	h2 {
		margin: 28px 0 12px;
		font-size: 20px;
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	article, section, p {
		max-width: 72ch;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	li { margin-block: 8px; overflow-wrap: anywhere; word-break: break-word; }
	a { color: var(--accent); text-underline-offset: 3px; }
	.license-text, .notice-text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		word-break: break-word;
		font: inherit;
		max-width: 72ch;
		min-width: 0;
		line-height: 1.6;
		margin: 16px 0;
	}
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
	details { max-width: 72ch; min-width: 0; margin-top: 12px; }
	summary { cursor: pointer; color: var(--accent); padding-block: 8px; font-weight: 500; }
	summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	@media (max-width: 620px) {
		.help-page { display: flex; flex-direction: column; }
		nav {
			flex: none;
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			padding: 12px 8px;
			border-inline-end: none;
			border-bottom: 1px solid var(--line);
			max-width: 100%;
			box-sizing: border-box;
		}
		nav a {
			padding: 8px 10px;
			font-size: 14px;
		}
		.reading-pane {
			padding: 20px 16px;
		}
	}
</style>
