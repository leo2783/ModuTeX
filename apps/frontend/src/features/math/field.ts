import type { MathfieldElement } from 'mathlive';
import 'mathlive';
import 'mathlive/fonts.css';
import { editableMatrix } from './matrix.ts';

const compositions = new WeakMap<MathfieldElement, { active: boolean; dispose: () => void }>();
export function isMathComposition(field: MathfieldElement, event?: KeyboardEvent): boolean {
	return !!compositions.get(field)?.active || !!event?.isComposing || event?.keyCode === 229 || event?.key === 'Process';
}

if (typeof document !== 'undefined') {
	const STYLE_ID = 'mathlive-hide-chrome';
	if (!document.getElementById(STYLE_ID)) {
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
			math-field::part(virtual-keyboard-toggle),
			math-field::part(menu-toggle) {
				display: none !important;
			}
		`;
		document.head.appendChild(style);
	}
}

/** Converts base LaTeX matrix array environments into native visual environments to prevent broken delimiters in MathLive. */
export function toVisualLatex(latex: string, editablePlaceholders = false): string {
	const parsed = editableMatrix(latex);
	if (!parsed) return latex;
	const { matrix, brackets } = parsed;
	const environment = { parentheses: 'pmatrix', square: 'bmatrix', none: 'matrix', curly: 'Bmatrix', bars: 'vmatrix', 'double-bars': 'Vmatrix' }[brackets];
	const rows = Array.from({ length: matrix.rows }, (_, row) => matrix.cells.slice(row * matrix.columns, (row + 1) * matrix.columns).map(cell => cell || (editablePlaceholders ? '\\placeholder{}' : '{}')).join(' & '));
	return '\\begin{' + environment + '}' + rows.join('\\\\') + '\\end{' + environment + '}';
}

/** Use the registered element, including when Vite reloads a library module. */
export function createMathField(target: HTMLElement): MathfieldElement {
	const ownerDocument = target.ownerDocument;
	const Field = ownerDocument.defaultView?.customElements.get('math-field') as typeof MathfieldElement | undefined;
	if (!Field) throw new Error('MATH_FIELD_NOT_REGISTERED');
	if (typeof window !== 'undefined' && window.mathVirtualKeyboard) {
		window.mathVirtualKeyboard.hide();
	}
	Field.fontsDirectory = null;
	Field.soundsDirectory = null;
	const field = ownerDocument.createElement('math-field') as MathfieldElement;
	field.mathVirtualKeyboardPolicy = 'manual';
	// Windows IMEs may report Enter with keyCode 229 and isComposing=false.
	// Keep candidate navigation native, away from both editor shortcut handlers.
	const controller = new AbortController();
	const state = { active: false, dispose: () => controller.abort() };
	compositions.set(field, state);
	field.addEventListener('compositionstart', () => { state.active = true; }, { capture: true, signal: controller.signal });
	field.addEventListener('compositionend', () => { state.active = false; }, { capture: true, signal: controller.signal });
	field.addEventListener('keydown', event => {
		if (isMathComposition(field, event)) event.stopImmediatePropagation();
	}, { capture: true, signal: controller.signal });
	target.replaceChildren(field);
	field.menuItems = [];
	field.macros = { ...field.macros, htmlData: { args: 2, def: '#2' }, href: { args: 2, def: '#2' }, htmlClass: { args: 2, def: '#2' }, htmlId: { args: 2, def: '#2' }, style: { args: 2, def: '#2' } };
	return field;
}

export function disposeMathField(field: MathfieldElement | null): void {
	if (!field) return;
	compositions.get(field)?.dispose(); compositions.delete(field);
	window.mathVirtualKeyboard?.hide();
	field.remove();
}
