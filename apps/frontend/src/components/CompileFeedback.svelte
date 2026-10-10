<script lang="ts">
	import type { Diagnostic } from '@modutex/frontend-contracts';
	import { text, type Language } from '../i18n/text.ts';
	let { locale, diagnostics, compileLog, canNavigateDiagnostic, navigateToDiagnostic }: {
		locale: Language; diagnostics: readonly Diagnostic[]; compileLog: string;
		canNavigateDiagnostic: (diagnostic: Diagnostic) => boolean;
		navigateToDiagnostic: (diagnostic: Diagnostic) => void;
	} = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
</script>
	{#if diagnostics.length}
		<section class="compile-problems" aria-label={t('編譯問題', 'Compilation problems')}>
			<h2>{t('編譯問題', 'Compilation problems')} ({diagnostics.length})</h2>
			<ul>
				{#each diagnostics as diagnostic}
					<li class="diagnostic-row">
						<span class="diagnostic-severity" data-severity={diagnostic.severity}>
							{diagnostic.severity === 'error' ? t('錯誤', 'Error') : diagnostic.severity === 'warning' ? t('警告', 'Warning') : t('資訊', 'Info')}
						</span>
						<span class="diagnostic-text">{diagnostic.message}</span>
						{#if diagnostic.line !== null}
							<button class="text-button" disabled={!canNavigateDiagnostic(diagnostic)} onclick={() => navigateToDiagnostic(diagnostic)}>
								{diagnostic.path}:{diagnostic.line} · {t('前往原始碼', 'Go to source')}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	{#if compileLog}
		<details class="compile-log" open={diagnostics.some((d) => d.severity === 'error')}>
			<summary>{t('TeX 編譯記錄', 'TeX compilation log')}</summary>
			<pre>{compileLog}</pre>
		</details>
	{/if}

<style>
	.diagnostic-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		line-height: 1.6;
	}
	.diagnostic-severity {
		font-size: 11px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 3px;
		text-transform: uppercase;
	}
	.diagnostic-severity[data-severity='error'] {
		background: rgba(163, 50, 50, 0.15);
		color: var(--error);
	}
	.diagnostic-severity[data-severity='warning'] {
		background: rgba(220, 160, 30, 0.15);
		color: var(--ink);
	}
	.diagnostic-severity[data-severity='info'] {
		background: var(--selection);
		color: var(--accent);
	}
	.diagnostic-text {
		flex: 1;
		min-width: 0;
	}
</style>