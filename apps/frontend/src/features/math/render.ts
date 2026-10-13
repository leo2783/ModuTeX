import { createMathField, disposeMathField, toVisualLatex } from './field.ts';

/** Actual library rendering without accepting generated HTML into our DOM. */
export function renderEquation(target: HTMLElement, latex: string): (() => void) & { update(latex: string): void } {
	const field = createMathField(target);
	field.readOnly = true;
	field.setAttribute('aria-label', '公式'); field.setAttribute('tabindex', '-1');
	field.setValue(toVisualLatex(latex), { silenceNotifications: true });
	return Object.assign(() => disposeMathField(field), {
		update(next: string) { field.setValue(toVisualLatex(next), { silenceNotifications: true }); }
	});
}
