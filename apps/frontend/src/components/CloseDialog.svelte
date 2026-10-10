<script lang="ts">
	import { onMount } from 'svelte';
	import { text, type Language } from '../i18n/text.ts';
	let { locale, name, saving, error, onSave, onDiscard, onCancel }: {
		locale: Language; name: string; saving: boolean; error: string;
		onSave: () => void; onDiscard: () => void; onCancel: () => void;
	} = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
	let dialog: HTMLDialogElement;
	onMount(() => {
		const previous = document.activeElement;
		dialog.showModal();
		return () => {
			dialog.close();
			const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected ? previous :
				Array.from(document.querySelectorAll<HTMLElement>('.cm-content, .ProseMirror')).find(element => !element.closest('[hidden], [inert]'));
			target?.focus();
		};
	});
</script>

<dialog bind:this={dialog} aria-labelledby="close-title" oncancel={(event) => { event.preventDefault(); if (!saving) onCancel(); }}>
	<h2 id="close-title">{t('儲存變更？', 'Save changes?')}</h2>
	<p>{t(`「${name}」有未儲存的變更。`, `“${name}” has unsaved changes.`)}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button type="button" onclick={onCancel} disabled={saving}>{t('取消', 'Cancel')}</button>
		<button type="button" onclick={onDiscard} disabled={saving}>{t('捨棄變更並關閉', 'Discard changes and close')}</button>
		<button type="button" class="primary" onclick={onSave} disabled={saving}>{saving ? t('儲存中…', 'Saving…') : t('儲存後關閉', 'Save and close')}</button>
	</div>
</dialog>

<style>
	dialog { width: min(440px, calc(100vw - 32px)); padding: 24px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
	dialog::backdrop { background: rgb(0 0 0 / 45%); }
	h2 { margin: 0 0 12px; font-size: 18px; }
	p { color: var(--muted); line-height: 1.5; }
	p.error { color: var(--error); }
	.actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
</style>
