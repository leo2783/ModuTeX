<script lang="ts">
	import { onMount } from 'svelte';
	let { t, name, saving, error, save, discard, cancel }: {
		t: (zh: string, en: string) => string; name: string; saving: boolean; error: string;
		save: () => void; discard: () => void; cancel: () => void;
	} = $props();
	let dialog: HTMLDialogElement;
	onMount(() => {
		const previous = document.activeElement;
		dialog.showModal();
		return () => {
			const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected ? previous :
				[...document.querySelectorAll<HTMLElement>('.cm-content, .ProseMirror')].find(element => !element.closest('[hidden], [inert]'));
			target?.focus();
		};
	});
</script>

<dialog bind:this={dialog} aria-labelledby="close" oncancel={(event) => { event.preventDefault(); if (!saving) cancel(); }}>
	<h2 id="close">{t('儲存變更？', 'Save changes?')}</h2>
	<p>{t(`「${name}」有未儲存的變更。`, `“${name}” has unsaved changes.`)}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button type="button" onclick={cancel} disabled={saving}>{t('取消', 'Cancel')}</button>
		<button type="button" onclick={discard} disabled={saving}>{t('捨棄變更並關閉', 'Discard changes and close')}</button>
		<button type="button" class="primary" onclick={save} disabled={saving}>{saving ? t('儲存中…', 'Saving…') : t('儲存後關閉', 'Save and close')}</button>
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
