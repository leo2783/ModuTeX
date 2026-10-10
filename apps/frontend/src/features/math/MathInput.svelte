<script lang="ts">
	import { onMount } from 'svelte';
	import type { MathfieldElement } from 'mathlive';
	import { text, type Language } from '../../i18n/text.ts';
	let { value, onChange, onUnavailable, locale = 'zh-Hant' }: { value: string; onChange: (latex: string) => void; onUnavailable?: () => void; locale?: Language } = $props();
	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);
	type MathInputError = 'too-long' | 'paste-too-long' | 'load-failed';
	let host: HTMLDivElement;
	let field = $state.raw<MathfieldElement | null>(null);
	let loading = $state(true);
	let error = $state<MathInputError | null>(null);
	function errorMessage(code: MathInputError): string {
		if (code === 'too-long') return t('公式過長，請縮短後再試。', 'The equation is too long. Shorten it and try again.');
		if (code === 'paste-too-long') return t('貼上的公式過長，請縮短後再試。', 'The pasted equation is too long. Shorten it and try again.');
		return t('視覺公式輸入無法載入，請使用下方 LaTeX 欄位。', 'The visual equation input could not load. Use the LaTeX field below.');
	}
	let accepted = '';
	$effect(() => {
		if (!field) return;
		accepted = value;
		if (field.value !== value) field.setValue(value, { silenceNotifications: true });
	});
	$effect(() => {
		if (field) field.setAttribute('aria-label', t('視覺公式輸入', 'Visual equation input'));
	});
	function insert(latex: string) { field?.focus(); field?.insert(latex); }
	onMount(() => {
		let alive = true;
		let dispose: (() => void) | undefined;
		void import('./field.ts').then(({ createMathField, disposeMathField }) => {
			if (!alive) return;
			const input = createMathField(host);
			input.setAttribute('aria-label', t('視覺公式輸入', 'Visual equation input'));
			input.smartMode = false;
			accepted = value; input.setValue(value, { silenceNotifications: true });
			const changed = () => {
				const latex = input.value;
				if (latex.length > 65536 || latex.includes('\u0000')) {
					input.setValue(accepted, { silenceNotifications: true }); error = 'too-long'; return;
				}
				accepted = latex; error = null; onChange(latex);
			};
			const paste = (event: ClipboardEvent) => {
				if ((event.clipboardData?.getData('text/plain').length ?? 0) + accepted.length > 65536) { event.preventDefault(); error = 'paste-too-long'; }
			};
			input.addEventListener('input', changed); input.addEventListener('paste', paste);
			field = input; loading = false;
			dispose = () => {
				input.removeEventListener('input', changed); input.removeEventListener('paste', paste);
				disposeMathField(input); field = null;
			};
		}).catch(() => { if (alive) { loading = false; error = 'load-failed'; onUnavailable?.(); } });
		return () => { alive = false; dispose?.(); };
	});
</script>

<div class="math-input" aria-busy={loading}>
	<div class="formula-tools" role="group" aria-label={t('公式工具', 'Equation tools')}>
		<button onclick={() => insert('\\frac{#@}{#?}')} disabled={!field}>{t('分數', 'Fraction')}</button>
		<button onclick={() => insert('\\sqrt{#@}')} disabled={!field}>{t('根號', 'Square root')}</button>
		<button onclick={() => insert('^{#@}')} disabled={!field}>{t('上標', 'Superscript')}</button>
		<button onclick={() => insert('_{#@}')} disabled={!field}>{t('下標', 'Subscript')}</button>
		<button onclick={() => insert('\\int_{#?}^{#?} #@')} disabled={!field}>{t('積分', 'Integral')}</button>
	</div>
	{#if loading}<p role="status">{t('正在載入公式工具…', 'Loading equation tools…')}</p>{/if}
	<div class="field-host" bind:this={host}></div>
	{#if error}<p class="input-error" role="alert">{errorMessage(error)}</p>{/if}
</div>

<style>
	.math-input { margin-block: 12px; min-width: 0; }
	.formula-tools { display: flex; flex-wrap: wrap; gap: 6px; margin-block-end: 8px; }
	.field-host :global(math-field) { display: block; width: 100%; min-height: 64px; padding: 8px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; --caret-color: var(--accent); --selection-background-color: var(--selection); }
	.field-host :global(math-field:focus-within) { outline: 2px solid var(--accent); outline-offset: 2px; }
	.field-host :global(math-field::part(virtual-keyboard-toggle)),
	.field-host :global(math-field::part(menu-toggle)) { display: none !important; }
	p { font-size: 14px; line-height: 1.5; }
	.input-error { color: var(--error); }
</style>
