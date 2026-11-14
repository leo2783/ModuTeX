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
	Field.fontsDirectory = null;
	Field.soundsDirectory = null;
	const field = ownerDocument.createElement('math-field') as MathfieldElement;
	// Windows IMEs may report Enter with keyCode 229 and isComposing=false.
	// Keep candidate navigation native, away from both editor shortcut handlers.
	const controller = new AbortController();
	const state = { active: false, dispose: () => controller.abort() };
	compositions.set(field, state);
	// CJK labels are text inside mathematics. Transform only freshly typed input;
	// setValue(), existing LaTeX, macro arguments and source editing stay literal.
	const textLabels = (value: string) => {
		const latex = value.replace(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]+/gu, label => `\\text{${label}}`);
		// An empty math group keeps the insertion caret in math mode. Switching
		// mode afterward would create a second, content-free undo checkpoint.
		return /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]$/u.test(value) ? latex + '{}' : latex;
	};
	const safeTypedText = (value: string) => !/[\\%{}$&#_^\r\n]/u.test(value);
	let pending: { value: string; selection: string; data: string } | null = null;
	function flushTypedText() {
		const input = pending;
		pending = null;
		if (!input || controller.signal.aborted || !field.isConnected || field.readOnly || field.disabled ||
			field.value !== input.value || JSON.stringify(field.selection) !== input.selection) return;
		field.insert(textLabels(input.data), { format: 'latex', mode: 'math', selectionMode: 'after' });
	}
	function queueTypedText(data: string) {
		if (pending) pending.data += data;
		else {
			const current = pending = { value: field.value, selection: JSON.stringify(field.selection), data };
			queueMicrotask(() => { if (pending === current) flushTypedText(); });
		}
	}
	field.addEventListener('beforeinput', event => {
		const input = event as InputEvent;
		// MathLive also emits beforeinput from the host while changing its model.
		// Only intercept browser text input originating in its keyboard sink.
		if (!input.composedPath().some(node => node instanceof Element && node.getAttribute('part') === 'keyboard-sink') ||
			input.inputType !== 'insertText' || input.isComposing || state.active || field.readOnly || field.disabled ||
			field.mode !== 'math' || !input.cancelable || !input.data) return;
		// Leave literal LaTeX keystrokes and their native shortcut semantics alone.
		if (!safeTypedText(input.data)) { flushTypedText(); return; }
		if (pending && (field.value !== pending.value || JSON.stringify(field.selection) !== pending.selection)) flushTypedText();
		if (!pending && !/\p{Script=Han}/u.test(input.data)) return;
		input.preventDefault();
		queueTypedText(input.data);
	}, { capture: true, signal: controller.signal });
	field.addEventListener('paste', event => {
		const data = event.clipboardData?.getData('text/plain');
		if (event.defaultPrevented || field.readOnly || field.disabled || state.active || field.mode !== 'math' ||
			!data || !/\p{Script=Han}/u.test(data) || !safeTypedText(data) || event.clipboardData?.getData('application/x-latex') ||
			field.value.length + textLabels(data).length > 65536) return;
		flushTypedText();
		event.preventDefault(); event.stopImmediatePropagation();
		queueTypedText(data);
	}, { capture: true, signal: controller.signal });
	field.addEventListener('compositionstart', () => { state.active = true; }, { capture: true, signal: controller.signal });
	field.addEventListener('compositionend', () => { state.active = false; }, { capture: true, signal: controller.signal });
	field.addEventListener('compositionend', event => {
		const data = event.data;
		if (field.readOnly || field.disabled || controller.signal.aborted || !field.isConnected ||
			field.mode !== 'math' || !data || !/\p{Script=Han}/u.test(data) || !safeTypedText(data)) return;
		// MathLive has already removed its temporary composition atom. Replace only
		// the exact committed characters, never a surrounding fraction or macro.
		const end = field.position, start = end - Array.from(data).length;
		if (start < 0 || field.getValue(start, end) !== data) return;
		field.selection = { ranges: [[start, end]] };
		field.insert(textLabels(data), { format: 'latex', mode: 'math', selectionMode: 'after' });
	}, { signal: controller.signal });
	field.addEventListener('keydown', event => {
		if (isMathComposition(field, event)) event.stopImmediatePropagation();
	}, { capture: true, signal: controller.signal });
	field.addEventListener('mount', () => {
		field.menuItems = [];
		field.macros = { ...field.macros, htmlData: { args: 2, def: '#2' }, href: { args: 2, def: '#2' }, htmlClass: { args: 2, def: '#2' }, htmlId: { args: 2, def: '#2' }, style: { args: 2, def: '#2' } };
	}, { once: true, signal: controller.signal });
	target.replaceChildren(field);
	return field;
}

export function disposeMathField(field: MathfieldElement | null): void {
	if (!field) return;
	compositions.get(field)?.dispose(); compositions.delete(field);
	field.remove();
}
