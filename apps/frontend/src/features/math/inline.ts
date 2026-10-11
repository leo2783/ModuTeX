import { createMathField, disposeMathField } from './field.ts';
import type { EquationDraft } from './source.ts';

/** A local draft at the document caret. Source and its undo history change only on Finish. */
export function editInlineEquation(host: HTMLElement, draft: EquationDraft, text: (zh: string, en: string) => string,
	commit: (draft: EquationDraft) => void, cancel: () => void): () => void {
	const owner = host.ownerDocument;
	const tools = owner.createElement('span'); tools.className = 'inline-equation-tools';
	tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', text('公式工具', 'Equation tools'));
	const input = owner.createElement('span'); input.className = 'inline-equation-input';
	const error = owner.createElement('span'); error.className = 'inline-equation-error'; error.setAttribute('role', 'alert');
	host.replaceChildren(tools, input, error);
	const field = createMathField(input);
	field.setAttribute('aria-label', text('視覺公式輸入', 'Visual equation input'));
	field.smartMode = false; field.setValue(draft.latex, { silenceNotifications: true });
	let accepted = draft.latex, disposed = false;
	function button(label: string, paths: string[], action: () => void) {
		const button = owner.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
		const svg = owner.createElementNS('http://www.w3.org/2000/svg', 'svg');
		for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
		for (const d of paths) { const path = owner.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
		button.append(svg); button.addEventListener('click', action); tools.append(button);
		return button;
	}
	for (const [zh, en, latex, paths] of [
		['分數', 'Fraction', '\\frac{#@}{#?}', ['M5 12h14M10 4h4M10 20h4']],
		['根號', 'Square root', '\\sqrt{#@}', ['M3 13l3 5L10 5h11']],
		['上標', 'Superscript', '^{#@}', ['M5 10l8 10M13 10 5 20M16 4h4v3h-4v3h4']],
		['下標', 'Subscript', '_{#@}', ['M5 4l8 10M13 4 5 14M16 14h4v3h-4v3h4']],
		['積分', 'Integral', '\\int_{#?}^{#?} #@', ['M16 3c-6-4-5 22-11 18']]
	] as const) button(text(zh, en), [...paths], () => { field.focus(); field.insert(latex); });
	function finish() {
		if (disposed) return;
		const latex = field.value;
		if (!latex.trim() || latex.length > 65536 || latex.includes('\u0000')) {
			error.textContent = text('請輸入有效公式。', 'Enter a valid equation.'); field.focus(); return;
		}
		commit({ latex, inline: draft.inline });
	}
	button(text('完成公式', 'Finish equation'), ['M5 12l4 4L19 6'], finish);
	button(text('取消公式', 'Cancel equation'), ['M6 6l12 12M18 6 6 18'], cancel);
	const changed = () => {
		const value = field.value;
		if (value.length > 65536 || value.includes('\u0000')) {
			field.setValue(accepted, { silenceNotifications: true }); error.textContent = text('公式過長或含有無效字元。', 'Equation is too long or contains invalid characters.');
		} else { accepted = value; error.textContent = ''; }
	};
	const keydown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
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
