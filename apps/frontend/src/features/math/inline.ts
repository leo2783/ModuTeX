import { createMathField, disposeMathField, isMathComposition, toVisualLatex } from './field.ts';
import { MATH_CATALOG } from './catalog.ts';
import { matrixSource, type EquationDraft } from './source.ts';
import { editableMatrix } from './matrix.ts';

/** A local draft at the document caret. Source and its undo history change only on Finish. */
export function editInlineEquation(host: HTMLElement, draft: EquationDraft, text: (zh: string, en: string) => string,
	commit: (draft: EquationDraft) => void, cancel: () => void): () => void {
	const owner = host.ownerDocument;
	const tools = owner.createElement('span'); tools.className = 'inline-equation-tools';
	tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', text('公式工具', 'Equation tools'));
	const catalogPanel = owner.createElement('div'); catalogPanel.className = 'inline-equation-catalog';
	catalogPanel.style.display = 'none';
	const input = owner.createElement('span'); input.className = 'inline-equation-input';
	const error = owner.createElement('span'); error.className = 'inline-equation-error'; error.setAttribute('role', 'alert');
	host.replaceChildren(tools, input, error, catalogPanel);
	const field = createMathField(input);
	field.setAttribute('aria-label', text('視覺公式輸入', 'Visual equation input'));
	field.smartMode = false; field.setValue(toVisualLatex(draft.latex, true), { silenceNotifications: true });
	let accepted = draft.latex, disposed = false, catalogOpen = false, inline = draft.inline;
	function button(label: string, paths: string[], action: () => void, color?: string) {
		const button = owner.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
		const svg = owner.createElementNS('http://www.w3.org/2000/svg', 'svg');
		for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: color ?? 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
		for (const d of paths) { const path = owner.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
		button.append(svg);
		if (color) button.style.color = color;
		button.addEventListener('pointerdown', event => event.preventDefault());
		button.addEventListener('click', action); tools.append(button);
		return button;
	}
	function insertLatex(latex: string) {
		field.focus();
		latex = toVisualLatex(latex, true);
		field.insert(field.selectionIsCollapsed ? latex.replaceAll('#@', '#?') : latex, { selectionMode: 'placeholder', format: 'latex' });
	}
	for (const [zh, en, latex, paths] of [
		['分數', 'Fraction', '\\frac{#@}{#?}', ['M5 12h14M10 4h4M10 20h4']],
		['根號', 'Square root', '\\sqrt{#@}', ['M3 13l3 5L10 5h11']],
		['上標', 'Superscript', '^{#@}', ['M5 10l8 10M13 10 5 20M16 4h4v3h-4v3h4']],
		['下標', 'Subscript', '_{#@}', ['M5 4l8 10M13 4 5 14M16 14h4v3h-4v3h4']],
		['積分', 'Integral', '\\int_{#?}^{#?} #@', ['M16 3c-6-4-5 22-11 18']]
	] as const) button(text(zh, en), [...paths], () => insertLatex(latex));
	const matrixOptions = owner.createElement('div'); matrixOptions.className = 'inline-matrix-options'; matrixOptions.hidden = true; host.append(matrixOptions);
	function size(label: string) { const wrap = owner.createElement('label'); wrap.textContent = label; const input = owner.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '10'; input.value = '3'; wrap.append(input); matrixOptions.append(wrap); return input; }
	const rows = size(text('行', 'Rows')), columns = size(text('列', 'Columns'));
	const brackets = owner.createElement('select'); brackets.setAttribute('aria-label', text('矩陣括號', 'Matrix brackets'));
	for (const [value, label] of [['parentheses', '( )'], ['square', '[ ]'], ['curly', '{ }'], ['bars', '| |'], ['double-bars', '‖ ‖'], ['none', text('無括號', 'None')]] as const) { const option = owner.createElement('option'); option.value = value; option.textContent = label; brackets.append(option); } matrixOptions.append(brackets);
	const insertMatrix = owner.createElement('button'); insertMatrix.type = 'button'; insertMatrix.textContent = text('插入矩陣', 'Insert matrix'); insertMatrix.addEventListener('pointerdown', event => event.preventDefault());
	// A sole matrix may be surrounded by ordinary math: resize only that matrix.
	function currentMatrix() {
		const latex = field.value;
		const starts = [...latex.matchAll(/\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/g)];
		if (starts.length !== 1) return null;
		const start = starts[0]!, closing = '\\end{' + start[1] + '}';
		const end = latex.indexOf(closing, start.index! + start[0].length);
		if (end < 0) return null;
		const parsed = editableMatrix(latex.slice(start.index, end + closing.length));
		return parsed ? { ...parsed, from: start.index!, to: end + closing.length } : null;
	}
	function syncMatrixOptions() {
		const current = currentMatrix();
		if (current) { rows.value = String(current.matrix.rows); columns.value = String(current.matrix.columns); brackets.value = current.brackets; }
		insertMatrix.textContent = current ? text('套用尺寸', 'Apply size') : text('插入矩陣', 'Insert matrix');
	}
	insertMatrix.addEventListener('click', () => {
		const r = rows.valueAsNumber, c = columns.valueAsNumber;
		if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || r > 10 || c < 1 || c > 10) { error.textContent = text('行與列須為 1 至 10。', 'Rows and columns must be 1–10.'); return; }
		const current = currentMatrix();
		if (current && current.matrix.cells.some((cell, index) => cell && (Math.floor(index / current.matrix.columns) >= r || index % current.matrix.columns >= c))) {
			error.textContent = text('縮小會移除已有內容，請先清空要移除的格子。', 'Clear the cells being removed before reducing the size.'); return;
		}
		const cells = Array.from({ length: r * c }, (_, index) => {
			const row = Math.floor(index / c), col = index % c;
			return current && row < current.matrix.rows && col < current.matrix.columns ? current.matrix.cells[row * current.matrix.columns + col] || '#?' : '#?';
		});
		const replacement = toVisualLatex(matrixSource({ rows: r, columns: c, cells }, brackets.value as Parameters<typeof matrixSource>[1]), true);
		if (current) { field.setValue(field.value.slice(0, current.from) + replacement + field.value.slice(current.to)); field.focus(); }
		else insertLatex(replacement);
		error.textContent = ''; syncMatrixOptions();
	}); matrixOptions.append(insertMatrix);
	const matrixButton = button(text('矩陣尺寸與括號', 'Matrix size and brackets'), ['M6 3H3v18h3M18 3h3v18h-3M8 7h1M15 7h1M8 13h1M15 13h1'], () => { matrixOptions.hidden = !matrixOptions.hidden; if (!matrixOptions.hidden) syncMatrixOptions(); matrixButton.setAttribute('aria-expanded', String(!matrixOptions.hidden)); catalogPanel.style.display = 'none'; });
	if (currentMatrix()) { matrixOptions.hidden = false; syncMatrixOptions(); }
	matrixButton.setAttribute('aria-expanded', String(!matrixOptions.hidden));
	const placement = button(text('行內公式', 'Inline equation'), ['M3 18h18M7 12l6-8M7 4l6 8M16 12h5'], () => { inline = !inline; host.classList.toggle('is-inline', inline); placement.setAttribute('aria-pressed', String(inline)); }); placement.setAttribute('aria-pressed', String(inline));
	let activeCategory: string | null = null;
	function renderCatalog() {
		catalogPanel.replaceChildren();
		if (activeCategory) {
			const back = owner.createElement('button'); back.type = 'button'; back.textContent = text('返回種類', 'Back to categories');
			back.addEventListener('pointerdown', event => event.preventDefault());
			back.addEventListener('click', () => { activeCategory = null; renderCatalog(); }); catalogPanel.append(back);
		}
		const nav = owner.createElement('div'); nav.className = 'inline-equation-catalog-nav';
		for (const cat of activeCategory ? [] : MATH_CATALOG) {
			const tab = owner.createElement('button'); tab.type = 'button';
			tab.className = 'catalog-tab' + (cat.id === activeCategory ? ' active' : '');
			tab.textContent = text(cat.nameZh, cat.nameEn);
			tab.addEventListener('pointerdown', event => event.preventDefault());
			tab.addEventListener('click', () => { activeCategory = cat.id; renderCatalog(); });
			nav.append(tab);
		}
		const grid = owner.createElement('div'); grid.className = 'inline-equation-catalog-grid';
		const cat = MATH_CATALOG.find(c => c.id === activeCategory);
		if (cat) {
			for (const item of cat.items) {
				const btn = owner.createElement('button'); btn.type = 'button';
				btn.className = 'catalog-item-btn';
				btn.title = text(item.labelZh, item.labelEn); btn.setAttribute('aria-label', btn.title);
				btn.textContent = item.display;
				btn.addEventListener('pointerdown', event => event.preventDefault());
				btn.addEventListener('click', () => {
					insertLatex(item.latex); catalogOpen = false; catalogPanel.style.display = 'none'; expand.setAttribute('aria-expanded', 'false');
				});
				grid.append(btn);
			}
		}
		catalogPanel.append(nav, grid);
	}
	const expand = button(text('展開數學選單', 'Expand math menu'), ['M4 6h16M4 12h16M4 18h10'], () => {
		catalogOpen = !catalogOpen;
		catalogPanel.style.display = catalogOpen ? 'flex' : 'none';
		if (catalogOpen) { activeCategory = null; renderCatalog(); }
		expand.setAttribute('aria-expanded', String(catalogOpen));
	});
	expand.setAttribute('aria-expanded', 'false');
	function finish() {
		if (disposed) return;
		const latex = field.value;
		if (!latex.trim() || latex.length > 65536 || latex.includes('\u0000')) {
			error.textContent = text('請輸入有效公式。', 'Enter a valid equation.'); field.focus(); return;
		}
		commit({ latex, inline });
	}
	button(text('完成公式', 'Finish equation'), ['M5 12l4 4L19 6'], finish).classList.add('confirm-action');
	button(text('取消公式', 'Cancel equation'), ['M6 6l12 12M18 6 6 18'], cancel).classList.add('cancel-action');
	const changed = () => {
		const value = field.value;
		if (value.length > 65536 || value.includes('\u0000')) {
			field.setValue(accepted, { silenceNotifications: true }); error.textContent = text('公式過長或含有無效字元。', 'Equation is too long or contains invalid characters.');
		} else { accepted = value; error.textContent = ''; }
	};
	const keydown = (event: KeyboardEvent) => {
		if (isMathComposition(field, event)) return;
		if (event.key === 'Escape' || event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault(); event.stopPropagation();
			if (event.key === 'Escape') cancel(); else finish();
		}
	};
	const paste = (event: ClipboardEvent) => {
		if ((event.clipboardData?.getData('text/plain').length ?? 0) + accepted.length > 65536) { event.preventDefault(); error.textContent = text('貼上的公式過長。', 'Pasted equation is too long.'); }
	};
	field.addEventListener('input', changed); field.addEventListener('keydown', keydown, true); field.addEventListener('paste', paste);
	field.focus();
	const focusFrame = owner.defaultView!.requestAnimationFrame(() => { if (!disposed) field.focus(); });
	return () => { disposed = true; owner.defaultView!.cancelAnimationFrame(focusFrame); field.removeEventListener('input', changed); field.removeEventListener('keydown', keydown, true); field.removeEventListener('paste', paste); disposeMathField(field); host.replaceChildren(); };
}
