import { createMathField } from './field.ts';

/** Actual library rendering without accepting generated HTML into our DOM. */
export function renderEquation(target: HTMLElement, latex: string): () => void {
	const field = createMathField(target);
	field.readOnly = true;
	field.setAttribute('aria-label', '公式'); field.setAttribute('tabindex', '-1');
	field.setValue(latex, { silenceNotifications: true });
	return () => field.remove();
}
