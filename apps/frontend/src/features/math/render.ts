import { MathfieldElement } from 'mathlive';
import 'mathlive/fonts.css';

/** Actual library rendering without accepting generated HTML into our DOM. */
export function renderEquation(target: HTMLElement, latex: string): () => void {
	MathfieldElement.fontsDirectory = null; MathfieldElement.soundsDirectory = null;
	const field = new MathfieldElement();
	field.readOnly = true; field.mathVirtualKeyboardPolicy = 'manual'; field.menuItems = [];
	field.setAttribute('aria-label', '公式'); field.setAttribute('tabindex', '-1');
	field.macros = { ...field.macros, htmlData: { args: 2, def: '#2' }, href: { args: 2, def: '#2' }, htmlClass: { args: 2, def: '#2' }, htmlId: { args: 2, def: '#2' }, style: { args: 2, def: '#2' } };
	field.setValue(latex, { silenceNotifications: true }); target.replaceChildren(field);
	return () => field.remove();
}
