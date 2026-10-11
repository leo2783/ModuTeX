<script lang="ts">
	import { tick } from 'svelte';
	import { codeSource, type CodeDraft } from './source.ts';
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
	let loadedKey: string | null = null;
	let error = $state<'delimiter' | 'general' | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	// 切換不同選取階段時同步草稿
	$effect(() => {
		if (sessionKey !== loadedKey) {
			draftCode = initialDraft?.code ?? '';
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
				onApply({ code: draftCode });
			} else {
				onInsert(codeSource(draftCode));
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
		<label for="code-source-input" class="code-label">
			{t('程式碼', 'Code')}
		</label>
		<textarea
			id="code-source-input"
			bind:this={textareaEl}
			bind:value={draftCode}
			rows="10"
			class="code-textarea"
			spellcheck="false"
			disabled={!active}
			onkeydown={handleKeyDown}
			placeholder={t('請在此輸入程式碼...', 'Enter code here...')}
		></textarea>
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
	.code-panel {
		padding: 12px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: 8px;
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
	.code-label {
		display: block;
		font-size: 13px;
		color: var(--muted);
		margin-bottom: 4px;
	}
	.code-textarea {
		width: 100%;
		box-sizing: border-box;
		font-family: Consolas, 'Fira Code', monospace;
		font-size: 13px;
		line-height: 1.6;
		padding: 8px 10px;
		background: var(--canvas);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 4px;
		resize: vertical;
		tab-size: 2;
		white-space: pre;
	}
	.code-textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	.code-error {
		margin: 0;
		font-size: 13px;
		color: #e53935;
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
		color: #b91c1c;
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
