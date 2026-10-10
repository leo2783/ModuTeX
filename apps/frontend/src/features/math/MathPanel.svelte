<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { equationSource, matrixSource, resizeMatrix, type MatrixDraft, type EquationDraft } from './source.ts';
	import { text, type Language } from '../../i18n/text.ts';
	let { kind, active, onInsert, onClose, onEquation, initialDraft = null, sessionKey = 'insert', editing = false, showSource = true, locale = 'zh-Hant' }: { kind: 'equation' | 'matrix'; active: boolean; onInsert: (source: string) => void; onClose: () => void; onEquation?: (draft: EquationDraft) => void; initialDraft?: EquationDraft | null; sessionKey?: string; editing?: boolean; showSource?: boolean; locale?: Language } = $props();
	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);
	const mathInput = () => import('./MathInput.svelte');
	let panel: HTMLElement;
	type PanelKind = 'equation' | 'matrix';
	let formula = $state(''); let inline = $state(false);
	let mathUnavailable = $state(false);
	let formulaInput = $state<HTMLTextAreaElement | null>(null);
	let matrix = $state<MatrixDraft>({ rows: 3, columns: 3, cells: Array(9).fill('') });
	let brackets = $state<'parentheses' | 'square' | 'none'>('parentheses');
	let matrixPreviewHost = $state<HTMLDivElement | null>(null);
	let matrixPreviewField: import('mathlive').MathfieldElement | null = null;
	let previewGeneration = 0;
	/** Codes, not text: a locale switch re-renders the message in the new language. */
	let error = $state<'dimensions' | 'cell' | 'formula' | null>(null);
	/** A null sentinel makes the default "insert" key a valid first session. */
	let loadedSession: { readonly kind: PanelKind; readonly key: string } | null = null;
	let destroyed = false;
	function disposeMatrixPreview() {
		if (matrixPreviewField) {
			matrixPreviewField.remove();
			matrixPreviewField = null;
		}
	}
	function isCurrentSession(expectedKind: PanelKind, expectedKey: string): boolean {
		return !destroyed && active && kind === expectedKind && sessionKey === expectedKey &&
			loadedSession !== null && loadedSession.kind === expectedKind && loadedSession.key === expectedKey;
	}
	function ensureSession(): boolean {
		if (destroyed || !active) return false;
		if (!loadedSession || loadedSession.kind !== kind || loadedSession.key !== sessionKey) {
			loadedSession = { kind, key: sessionKey };
			disposeMatrixPreview();
			formula = kind === 'equation' ? initialDraft?.latex ?? '' : '';
			mathUnavailable = false;
			inline = kind === 'equation' ? initialDraft?.inline ?? false : false;
			matrix = { rows: 3, columns: 3, cells: Array(9).fill('') };
			brackets = 'parentheses';
			error = null;
		}
		return true;
	}
	onDestroy(() => {
		destroyed = true;
		disposeMatrixPreview();
	});
	$effect(() => {
		const focusKind = kind, focusKey = sessionKey;
		if (!active || destroyed || !ensureSession()) return;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || !isCurrentSession(focusKind, focusKey)) return;
			panel?.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type="number"]')?.focus();
		}).catch(() => {});
		return () => { cancelled = true; };
	});
	$effect(() => {
		const value = formula;
		if (formulaInput && formulaInput.value !== value) formulaInput.value = value;
	});
	$effect(() => {
		if (!active || destroyed || kind !== 'matrix' || !matrixPreviewHost) {
			disposeMatrixPreview();
			return;
		}
		const host = matrixPreviewHost;
		const ticket = ++previewGeneration;
		const currentSession = sessionKey;
		let source = '';
		try {
			source = matrixSource(matrix, brackets);
			if (error === 'cell') error = null;
		} catch {
			error = 'cell';
			if (matrixPreviewField) matrixPreviewField.setValue('', { silenceNotifications: true });
			return;
		}
		if (matrixPreviewField && matrixPreviewField.isConnected && matrixPreviewField.parentElement === host) {
			matrixPreviewField.setValue(source, { silenceNotifications: true });
		} else {
			void import('./field.ts').then(({ createMathField }) => {
				if (destroyed || !active || kind !== 'matrix' || ticket !== previewGeneration || matrixPreviewHost !== host || sessionKey !== currentSession) return;
				disposeMatrixPreview();
				const field = createMathField(host);
				field.readOnly = true;
				field.setAttribute('aria-label', t('矩陣預覽', 'Matrix preview'));
				field.setAttribute('tabindex', '-1');
				field.setValue(source, { silenceNotifications: true });
				matrixPreviewField = field;
			}).catch(() => {
				/* 保留宿主狀態，不掩蓋異常 */
			});
		}
	});
	function updateFormula(event: Event) {
		const input = event.currentTarget as HTMLTextAreaElement;
		if (!active || !ensureSession() || kind !== 'equation') { input.value = formula; return; }
		formula = input.value;
	}
	function equationChangeHandler(expectedKind: PanelKind, expectedKey: string) {
		return (latex: string) => {
			if (destroyed || !active || expectedKind !== 'equation' || kind !== expectedKind || sessionKey !== expectedKey || !ensureSession()) return;
			formula = latex;
		};
	}
	function updateInline(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		if (!active || !ensureSession()) { input.checked = inline; return; }
		inline = input.checked;
	}
	function updateBrackets(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		if (!active || !ensureSession() || kind !== 'matrix') { select.value = brackets; return; }
		const value = select.value;
		if (value === 'parentheses' || value === 'square' || value === 'none') brackets = value;
		else select.value = brackets;
	}
	function errorMessage(code: 'dimensions' | 'cell' | 'formula'): string {
		if (code === 'dimensions') return t('行列數請輸入 1 到 10 的整數。', 'Enter a whole number from 1 to 10 for rows and columns.');
		if (code === 'cell') return t('儲存格請使用完整的單行 LaTeX，不含分欄、換列或環境指令。', 'Use complete single-line LaTeX in each cell, without column separators, line breaks or environment commands.');
		return t('請輸入公式；最多 65,536 字元。', 'Enter an equation of up to 65,536 characters.');
	}
	const cellLabel = (row: number, column: number) => t('第 ' + row + ' 行，第 ' + column + ' 列', 'Row ' + row + ', column ' + column);
	function resize(rows: number, columns: number) {
		if (!active || !ensureSession() || kind !== 'matrix') return;
		const expectedKey = sessionKey;
		try {
			const next = resizeMatrix(matrix, rows, columns);
			if (next.discarded && !window.confirm(t('縮小矩陣會刪除範圍外的內容。要繼續嗎？', 'Shrinking the matrix deletes content outside the new size. Continue?'))) return;
			if (!isCurrentSession('matrix', expectedKey)) return;
			matrix = next.matrix; error = null;
		} catch { if (isCurrentSession('matrix', expectedKey)) error = 'dimensions'; }
	}
	function updateCell(index: number, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		if (!active || !ensureSession() || kind !== 'matrix') {
			if (matrix.cells[index] !== undefined) input.value = matrix.cells[index]!;
			return;
		}
		if (index < 0 || index >= matrix.cells.length) return;
		const cells = [...matrix.cells];
		cells[index] = input.value;
		matrix = { ...matrix, cells };
	}
	function handleMatrixKeyDown(event: KeyboardEvent, index: number) {
		if (event.isComposing || event.keyCode === 229) return;
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const r = Math.floor(index / matrix.columns);
		const c = index % matrix.columns;
		const input = event.currentTarget as HTMLInputElement;
		if (event.key === 'Tab') {
			if (!event.shiftKey && index < matrix.cells.length - 1) { event.preventDefault(); focusMatrixCell(index + 1); }
			else if (event.shiftKey && index > 0) { event.preventDefault(); focusMatrixCell(index - 1); }
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (r < matrix.rows - 1) focusMatrixCell((r + 1) * matrix.columns + c);
		} else if (event.key === 'ArrowUp') {
			if (r > 0) { event.preventDefault(); focusMatrixCell((r - 1) * matrix.columns + c); }
		} else if (event.key === 'ArrowDown') {
			if (r < matrix.rows - 1) { event.preventDefault(); focusMatrixCell((r + 1) * matrix.columns + c); }
		} else if (event.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) {
			if (c > 0) { event.preventDefault(); focusMatrixCell(index - 1); }
		} else if (event.key === 'ArrowRight' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
			if (c < matrix.columns - 1) { event.preventDefault(); focusMatrixCell(index + 1); }
		}
	}
	function focusMatrixCell(index: number) {
		panel?.querySelector<HTMLInputElement>(`.matrix-grid input:nth-child(${index + 1})`)?.focus();
	}
	function insert() {
		if (!active || !ensureSession()) return;
		const insertKind = kind, insertKey = sessionKey;
		try { if (kind === 'equation' && onEquation) { equationSource(formula, inline); onEquation({ latex: formula, inline }); } else onInsert(equationSource(kind === 'equation' ? formula : matrixSource(matrix, brackets), inline)); }
		catch { if (isCurrentSession(insertKind, insertKey)) error = insertKind === 'matrix' ? 'cell' : 'formula'; }
	}
</script>

<section class="math-panel" bind:this={panel} aria-label={kind === 'matrix' ? t('插入矩陣', 'Insert matrix') : t('插入公式', 'Insert equation')}>
	<div class="panel-header"><h2>{kind === 'matrix' ? t('矩陣', 'Matrix') : t('公式', 'Equation')}</h2><button class="text-button" onclick={onClose}>{t('關閉', 'Close')}</button></div>
	<label class="inline-option"><input type="checkbox" checked={inline} disabled={!active} onchange={updateInline} />{t('行內公式', 'Inline equation')}</label>
	{#if kind === 'equation'}
		{#if active}{#await mathInput() then module}<module.default value={formula} {locale} onChange={equationChangeHandler(kind, sessionKey)} onUnavailable={() => { mathUnavailable = true; }} />{:catch}<p class="panel-error" role="alert">{t('公式工具無法載入，請關閉後重試。', 'The equation tool could not load. Close it and try again.')}</p>{/await}{/if}
		{#if showSource || mathUnavailable}<label class="formula">{t('LaTeX 公式', 'LaTeX equation')}<textarea bind:this={formulaInput} rows="3" maxlength="65536" spellcheck="false" disabled={!active} oninput={updateFormula}></textarea></label>{/if}
	{:else}
		<div class="dimensions">
			<label>n×n <input type="number" min="1" max="10" value={matrix.rows === matrix.columns ? matrix.rows : ''} onchange={(event) => { resize(event.currentTarget.valueAsNumber, event.currentTarget.valueAsNumber); event.currentTarget.value = matrix.rows === matrix.columns ? String(matrix.rows) : ''; }} disabled={!active} /></label>
			<label>{t('行', 'Rows')} <input type="number" min="1" max="10" value={matrix.rows} onchange={(event) => { resize(event.currentTarget.valueAsNumber, matrix.columns); event.currentTarget.value = String(matrix.rows); }} disabled={!active} /></label>
			<label>{t('列', 'Columns')} <input type="number" min="1" max="10" value={matrix.columns} onchange={(event) => { resize(matrix.rows, event.currentTarget.valueAsNumber); event.currentTarget.value = String(matrix.columns); }} disabled={!active} /></label>
			<label>{t('括號', 'Brackets')} <select value={brackets} onchange={updateBrackets} disabled={!active}><option value="parentheses">{t('圓括號', 'Parentheses')}</option><option value="square">{t('方括號', 'Square brackets')}</option><option value="none">{t('無括號', 'None')}</option></select></label>
		</div>
		<div class="matrix-scroll"><div class="matrix-grid" style:grid-template-columns={'repeat(' + matrix.columns + ', minmax(64px, 1fr))'}>
			{#each matrix.cells as cell, index}<input aria-label={cellLabel(Math.floor(index / matrix.columns) + 1, index % matrix.columns + 1)} value={cell} maxlength="1024" spellcheck="false" disabled={!active}
				oninput={(event) => updateCell(index, event)} onkeydown={(event) => handleMatrixKeyDown(event, index)} />{/each}
		</div></div>
		<div class="matrix-preview-wrapper" aria-label={t('矩陣預覽', 'Matrix preview')}>
			<span class="preview-title">{t('矩陣視覺預覽', 'Matrix visual preview')}</span>
			<div class="matrix-preview-host" bind:this={matrixPreviewHost}></div>
		</div>
	{/if}
	{#if error}<p class="panel-error" role="alert">{errorMessage(error)}</p>{/if}
	<div class="panel-actions"><button onclick={onClose}>{t('取消', 'Cancel')}</button><button class="primary" onclick={insert} disabled={!active}>{editing && kind === 'equation' ? t('套用', 'Apply') : t('插入', 'Insert')}</button></div>
</section>

<style>
	.math-panel { padding: 12px 16px; background: var(--canvas); border-bottom: 1px solid var(--line); max-height: 50dvh; overflow: auto; }
	.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	h2 { margin: 0; font-size: 16px; font-weight: 600; }
	label { display: flex; align-items: center; gap: 6px; }
	.inline-option { margin: 12px 0; }
	.formula { display: block; }
	textarea { display: block; width: 100%; margin-top: 6px; resize: vertical; font: 14px/1.5 Consolas, monospace; }
	input, textarea, select { color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 6px; }
	.dimensions { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
	.dimensions input { width: 56px; }
	.matrix-scroll { overflow-x: auto; }
	.matrix-grid { display: grid; gap: 4px; min-width: max-content; }
	.matrix-grid input { min-width: 0; width: 100%; font: 14px/1.5 Consolas, monospace; }
	.matrix-preview-wrapper { margin-top: 12px; padding: 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
	.preview-title { font-size: 13px; font-weight: 600; color: var(--muted); display: block; margin-bottom: 6px; }
	.matrix-preview-host { min-height: 48px; display: flex; align-items: center; justify-content: center; overflow-x: auto; }
	.matrix-preview-host :global(math-field) { border: none; background: transparent; color: var(--ink); font-size: 16px; }
	.panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
	.panel-error { color: var(--error); line-height: 1.5; }
</style>
