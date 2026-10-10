import type { MathfieldElement } from 'mathlive';
import 'mathlive';
import 'mathlive/fonts.css';

/** Use the registered element, including when Vite reloads a library module. */
export function createMathField(target: HTMLElement): MathfieldElement {
	const Field = customElements.get('math-field') as typeof MathfieldElement | undefined;
	if (!Field) throw new Error('MATH_FIELD_NOT_REGISTERED');
	Field.fontsDirectory = null;
	Field.soundsDirectory = null;
	const field = document.createElement('math-field') as MathfieldElement;
	field.mathVirtualKeyboardPolicy = 'manual';
	target.replaceChildren(field);
	field.menuItems = [];
	field.macros = { ...field.macros, htmlData: { args: 2, def: '#2' }, href: { args: 2, def: '#2' }, htmlClass: { args: 2, def: '#2' }, htmlId: { args: 2, def: '#2' }, style: { args: 2, def: '#2' } };
	return field;
}
