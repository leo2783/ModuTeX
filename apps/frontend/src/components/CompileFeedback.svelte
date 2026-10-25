<script lang="ts">
	import type { Diagnostic } from '@modutex/frontend-contracts';
	import { text, type Language } from '../i18n/text.ts';
	let { locale, panel = 'problems', diagnostics, compileLog, canNavigateDiagnostic, navigateToDiagnostic }: {
		locale: Language; diagnostics: readonly Diagnostic[]; compileLog: string;
		panel?: 'problems' | 'output';
		canNavigateDiagnostic: (diagnostic: Diagnostic) => boolean;
		navigateToDiagnostic: (diagnostic: Diagnostic) => void;
	} = $props();
	const t = (zh: string, en: string) => text(locale, zh, en);
</script>
	{#if panel === 'problems'}
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
		{:else}
			<p class="compile-empty">{t('目前沒有編譯問題。', 'No compilation problems.')}</p>
		{/if}
	{:else if compileLog}
		<pre class="compile-output" aria-label={t('TeX 編譯記錄', 'TeX compilation log')}>{compileLog}</pre>
	{:else}
		<p class="compile-empty">{t('目前沒有編譯輸出。', 'No compilation output.')}</p>
	{/if}

<style>
	.compile-empty { margin: 0; padding: 12px 16px; color: var(--muted); }
	.compile-output { margin: 0; padding: 10px 12px; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 Consolas, monospace; }
	.compile-problems { padding: 10px 12px; }
	.compile-problems h2 { margin: 0 0 6px; font-size: 14px; }
	.compile-problems ul { margin: 0; padding-inline-start: 20px; }
	.compile-problems li { overflow-wrap: anywhere; line-height: 1.45; }
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
