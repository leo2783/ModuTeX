<script lang="ts">
	import { tick } from 'svelte';
	import { codeSource, CODE_LANGUAGES, type CodeDraft } from './source.ts';
	import { highlightCode } from './highlight.ts';
	import { text, type Language } from '../../i18n/text.ts';

	let {
		active,
		initialDraft = null,
		sessionKey = 'insert',
		editing = false,
		locale = 'zh-Hant',
		onInsert,
		onApply,
		onClose
	}: {
		active: boolean;
		initialDraft?: CodeDraft | null;
		sessionKey?: string;
		editing?: boolean;
		locale?: Language;
		onInsert: (source: string) => void;
		onApply?: (draft: CodeDraft) => void;
		onClose: () => void;
	} = $props();

	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);

	let draftCode = $state('');
	let language = $state('text');
	let loadedKey: string | null = null;
	let error = $state<'delimiter' | 'general' | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let highlightEl = $state<HTMLPreElement | null>(null);
	$effect(() => { if (highlightEl) return highlightCode(highlightEl, draftCode + '\n', language); });

	// 切換不同選取階段時同步草稿
	$effect(() => {
		if (sessionKey !== loadedKey) {
			draftCode = initialDraft?.code ?? '';
			language = initialDraft?.language ?? 'text';
			loadedKey = sessionKey;
			error = null;
			if (active) {
				void tick().then(() => textareaEl?.focus());
			}
		}
	});

	function handleKeyDown(event: KeyboardEvent) {
		if (!active) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		// Ctrl+Enter 或 Cmd+Enter 快速確認套用
		if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			event.preventDefault();
			confirm();
			return;
		}
		// 支援 Tab 縮排
		if (event.key === 'Tab') {
			event.preventDefault();
			const target = event.currentTarget as HTMLTextAreaElement;
			const start = target.selectionStart;
			const end = target.selectionEnd;
			draftCode = draftCode.slice(0, start) + '  ' + draftCode.slice(end);
			void tick().then(() => {
				target.selectionStart = target.selectionEnd = start + 2;
			});
		}
	}

	function confirm() {
		if (!active) return;
		// 檢查是否包含禁止之結束標記
		if (draftCode.includes('\\end{verbatim}') || draftCode.includes('\\end{verbatim*}')) {
			error = 'delimiter';
			return;
		}
		try {
			if (editing && onApply) {
				onApply({ code: draftCode, language });
			} else {
				onInsert(codeSource(draftCode, false, language));
			}
			error = null;
		} catch {
			error = 'general';
		}
	}
</script>

<section class="code-panel" aria-labelledby="code-panel-title">
	<div class="code-heading">
		<h2 id="code-panel-title">
			{editing ? t('編輯程式碼區塊', 'Edit Code Block') : t('插入程式碼區塊', 'Insert Code Block')}
		</h2>
		<button type="button" class="text-button" onclick={onClose} disabled={!active}>
			{t('關閉', 'Close')}
		</button>
	</div>

	<div class="code-editor-wrapper">
		<div class="language-row">
		<label for="code-language">{t('程式碼語言', 'Code language')}</label>
		<select id="code-language" bind:value={language} disabled={!active}>
			{#each CODE_LANGUAGES as entry}<option value={entry[0]}>{t(entry[1], entry[2])}</option>{/each}
		</select>
		</div>
		<div class="code-input-stack">
		<pre class="code-highlight syntax-colored" aria-hidden="true" bind:this={highlightEl}></pre>
		<textarea
			id="code-source-input"
			bind:this={textareaEl}
			bind:value={draftCode}
			rows="10"
			class="code-textarea"
			aria-label={t('程式碼', 'Code')}
			spellcheck="false"
			disabled={!active}
			onkeydown={handleKeyDown}
			onscroll={() => { if (highlightEl && textareaEl) { highlightEl.scrollTop = textareaEl.scrollTop; highlightEl.scrollLeft = textareaEl.scrollLeft; } }}
			placeholder={t('請在此輸入程式碼...', 'Enter code here...')}
		></textarea>
		</div>
	</div>

	{#if error === 'delimiter'}
		<p class="code-error" role="alert">
			{t('程式碼不能包含結束標記 \\end{verbatim}。', 'Code cannot contain the end delimiter \\end{verbatim}.')}
		</p>
	{:else if error === 'general'}
		<p class="code-error" role="alert">
			{t('無法套用程式碼內容。', 'Could not apply code changes.')}
		</p>
	{/if}

	<div class="code-actions">
		<button type="button" class="btn-cancel" onclick={onClose} disabled={!active}>
			{t('取消', 'Cancel')}
		</button>
		<button type="button" class="btn-confirm" onclick={confirm} disabled={!active}>
			{editing ? t('套用', 'Apply') : t('插入', 'Insert')}
		</button>
	</div>
</section>

<style>
	.code-editor-wrapper { display: grid; gap: 10px; }
	.language-row { display: flex; align-items: center; gap: 10px; margin: 0; }
	.language-row label { font-size: 13px; color: var(--muted); }
	.language-row select { min-width: 180px; max-width: 100%; padding: 7px 32px 7px 10px; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; }
	.code-input-stack { position: relative; background: var(--canvas); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
	.code-input-stack:focus-within { outline: 2px solid var(--accent); outline-offset: -1px; }
	.code-highlight { position: absolute; inset: 0; margin: 0; padding: 12px; font: 14px/1.6 Consolas, 'Fira Code', monospace; white-space: pre; tab-size: 2; overflow: hidden; pointer-events: none; }
	.code-panel {
		white-space: normal;
		font-size: 14px;
		line-height: 1.4;
		padding: 12px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-height: 60vh;
		overflow-y: auto;
	}
	.code-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.code-heading h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}
	.code-textarea {
		width: 100%;
		box-sizing: border-box;
		font-family: Consolas, 'Fira Code', monospace;
		font-size: 14px;
		line-height: 1.6;
		padding: 12px;
		display: block;
		min-height: 144px;
		height: clamp(144px, 24vh, 240px);
		position: relative;
		background: transparent;
		color: transparent;
		caret-color: var(--ink);
		border: 0;
		border-radius: 4px;
		resize: vertical;
		tab-size: 2;
		white-space: pre;
	}
	.code-textarea:focus {
		outline: none;
		outline-offset: -1px;
	}
	.code-error {
		margin: 0;
		font-size: 13px;
		color: var(--error);
	}
	.code-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}
	.btn-cancel,
	.btn-confirm {
		padding: 6px 14px;
		font-size: 13px;
		border-radius: 4px;
		cursor: pointer;
		border: 1px solid var(--line);
	}
	.btn-cancel {
		background: var(--surface);
		color: var(--error);
	}
	.btn-confirm {
		background: #15803d;
		color: #ffffff;
		border-color: #15803d;
	}
	.btn-confirm:hover:not(:disabled) {
		opacity: 0.9;
	}
	.btn-cancel:hover:not(:disabled) {
		background: var(--canvas);
	}
</style>
