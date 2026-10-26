<script lang="ts">
	import { onMount } from 'svelte';
	let { t, name, saving, error, save, discard, cancel }: {
		t: (zh: string, en: string) => string; name: string; saving: boolean; error: string;
		save: () => void; discard: () => void; cancel: () => void;
	} = $props();
	let dialog: HTMLDialogElement;
	let cancelButton: HTMLButtonElement;
	onMount(() => {
		const previous = document.activeElement;
		dialog.showModal();
		cancelButton.focus();
		return () => {
			const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected ? previous :
				[...document.querySelectorAll<HTMLElement>('.cm-content, .ProseMirror')].find(element => !element.closest('[hidden], [inert]'));
			target?.focus();
		};
	});
</script>

<dialog bind:this={dialog} aria-labelledby="close" aria-describedby="close-description" aria-busy={saving} oncancel={(event) => { event.preventDefault(); if (!saving) cancel(); }}>
	<h2 id="close">{t('儲存變更？', 'Save changes?')}</h2>
	<p id="close-description"><strong>{name}</strong>{t(' 有未儲存的變更。', ' has unsaved changes.')}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button type="button" class="discard" onclick={discard} disabled={saving}>{t('不儲存', "Don't save")}</button>
		<button bind:this={cancelButton} type="button" onclick={cancel} disabled={saving}>{t('取消', 'Cancel')}</button>
		<button type="button" class="primary" onclick={save} disabled={saving}>{saving ? t('儲存中…', 'Saving…') : t('儲存並關閉', 'Save & close')}</button>
	</div>
</dialog>

<style>
	dialog { box-sizing: border-box; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 24px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 16px 48px rgb(0 0 0 / 18%); }
	dialog::backdrop { background: rgb(0 0 0 / 45%); }
	h2 { margin: 0 0 12px; font-size: 20px; line-height: 1.4; }
	p { margin: 0; color: var(--muted); line-height: 1.6; overflow-wrap: anywhere; }
	p strong { color: var(--ink); font-weight: 600; }
	p.error { color: var(--error); }
	p.error { margin-top: 12px; }
	.actions { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; margin-top: 24px; align-items: center; }
	.actions button { min-height: 40px; white-space: nowrap; }
	.discard { justify-self: start; background: transparent; border-color: transparent; }
	@media (max-width: 420px) {
		dialog { padding: 20px; }
		.actions { grid-template-columns: 1fr 1fr; }
		.discard { justify-self: stretch; }
		.primary { grid-column: 1 / -1; }
	}
</style>
