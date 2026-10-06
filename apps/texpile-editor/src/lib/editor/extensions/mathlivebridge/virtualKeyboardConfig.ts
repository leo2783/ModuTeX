import { initVirtualKeyboardInCurrentBrowsingContext } from 'mathlive';
import type { VirtualKeyboardLayout, VirtualKeyboardName } from 'mathlive';
import { generateMatrixLatex, type MatrixEnvironment } from './matrixLatex';
import { m } from '$lib/paraglide/messages';

export const VIRTUAL_MATRIX_REQUEST_EVENT = 'modutex:virtual-matrix-request';

const VIRTUAL_MATRIX_PRESETS: Readonly<Record<number, { rows: number; columns: number; environment: MatrixEnvironment }>> = {
	1: { rows: 2, columns: 2, environment: 'pmatrix' },
	2: { rows: 2, columns: 2, environment: 'bmatrix' },
	3: { rows: 2, columns: 2, environment: 'vmatrix' },
	4: { rows: 2, columns: 2, environment: 'matrix' },
	5: { rows: 3, columns: 1, environment: 'pmatrix' },
	6: { rows: 3, columns: 1, environment: 'bmatrix' }
};

/** Resolve only the finite app-owned numeric commands sent by the installed MathLive keyboard. */
export function virtualMatrixLatexForPreset(detail: unknown): string | null {
	if (typeof detail !== 'number' || !Number.isInteger(detail)) return null;
	const preset = VIRTUAL_MATRIX_PRESETS[detail];
	return preset ? generateMatrixLatex(preset.rows, preset.columns, preset.environment) : null;
}

const virtualMatrixCommand = (preset: number): [string, string, number] => ['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, preset];
import { loadSettings } from '$lib/settings';

const basicLayout = (): VirtualKeyboardLayout => ({
	label: m.mathpal_kbd_basic_label(),
	tooltip: m.mathpal_kbd_basic_tooltip(),
	rows: [
		[
			{ latex: '\\frac{#@}{#0}', class: 'small', variants: ['\\tfrac{#@}{#0}', '\\dfrac{#@}{#0}'] },
			{ latex: '\\sqrt{#0}', variants: ['\\sqrt[3]{#0}', '\\sqrt[#?]{#0}'] },
			'#@^{#?}',
			{ latex: '#@_{#?}', variants: ['#@^{#?}_{#?}', '_{#?}^{#?}'] },
			{ label: '[separator]', width: 0.5 },
			'[7]',
			'[8]',
			'[9]',
			{ latex: '\\div', class: 'small' },
			'[backspace]'
		],
		[
			'[(]',
			'[)]',
			{ latex: '\\lvert #0 \\rvert', class: 'small' },
			{ latex: '\\pm', variants: ['\\mp'] },
			{ label: '[separator]', width: 0.5 },
			'[4]',
			'[5]',
			'[6]',
			'\\times',
			'[undo]'
		],
		[
			{ latex: '\\le', variants: ['<', '\\ll', '\\lneq'] },
			{ latex: '\\ge', variants: ['>', '\\gg', '\\gneq'] },
			'=',
			{ latex: '\\ne', variants: ['\\approx', '\\equiv', '\\cong'] },
			{ label: '[separator]', width: 0.5 },
			'[1]',
			'[2]',
			'[3]',
			'[+]',
			'[redo]'
		],
		[
			'x',
			'y',
			{ latex: 'n', variants: ['m', 'k', 'i', 'j'] },
			{ latex: '\\pi', class: 'tex', variants: ['e', '\\phi', '\\theta'] },
			{ label: '[separator]', width: 0.5 },
			{ label: '[0]', width: 2 },
			'[.]',
			'[-]',
			'[left]',
			'[right]'
		]
	]
});

const calculusLayout = (): VirtualKeyboardLayout => ({
	label: m.mathpal_kbd_calculus_label(),
	tooltip: m.mathpal_kbd_calculus_tooltip(),
	rows: [
		[
			{ latex: '\\int_{#?}^{#?}#0\\,d#?', class: 'small' },
			{ latex: '\\int#0\\,d#?', class: 'small' },
			{ latex: '\\iint#0\\,d#?\\,d#?', class: 'small', variants: ['\\iiint', '\\oint'] },
			{ latex: '\\frac{d#@}{d#?}', class: 'small' },
			{ latex: '\\frac{\\partial#@}{\\partial#?}', class: 'small' },
			{ label: '[separator]', width: 0.5 },
			'[7]',
			'[8]',
			'[9]',
			'[backspace]'
		],
		[
			{ latex: '\\lim_{#?\\to#?}#0', class: 'small' },
			{ latex: '\\sum_{#?}^{#?}#0', class: 'small' },
			{ latex: '\\prod_{#?}^{#?}#0', class: 'small' },
			{ latex: '\\infty', variants: ['-\\infty'] },
			{ latex: '\\to', variants: ['\\rightarrow', '\\Rightarrow', '\\mapsto'] },
			{ label: '[separator]', width: 0.5 },
			'[4]',
			'[5]',
			'[6]',
			'[undo]'
		],
		[
			{ latex: "f'(#?)", class: 'small', variants: ["f''(#?)", "f'''(#?)"] },
			{ latex: '\\nabla', variants: ['\\nabla^2', '\\Delta'] },
			{ latex: '\\vec{#@}', class: 'small', variants: ['\\hat{#@}', '\\bar{#@}'] },
			{ latex: 'dx', class: 'small', variants: ['dy', 'dz', 'dt', 'du', 'dv'] },
			{ latex: '\\Delta', variants: ['\\delta', '\\epsilon', '\\varepsilon'] },
			{ label: '[separator]', width: 0.5 },
			'[1]',
			'[2]',
			'[3]',
			'[redo]'
		],
		[
			'x',
			't',
			'n',
			{ latex: '\\theta', variants: ['\\phi', '\\psi', '\\omega'] },
			'\\pi',
			{ label: '[separator]', width: 0.5 },
			{ label: '[0]', width: 2 },
			'[.]',
			'[left]',
			'[right]'
		]
	]
});

const algebraLayout = (): VirtualKeyboardLayout => ({
	label: m.mathpal_kbd_algebra_label(),
	tooltip: m.mathpal_kbd_algebra_tooltip(),
	rows: [
		[
			{
				latex: '\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}',
				class: 'small',
				command: virtualMatrixCommand(1),
				variants: [
					{ latex: '\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}', command: virtualMatrixCommand(2) },
					{ latex: '\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}', command: virtualMatrixCommand(3) },
					{ latex: '\\begin{matrix}#?&#?\\\\#?&#?\\end{matrix}', command: virtualMatrixCommand(4) }
				]
			},
			{
				latex: '\\begin{pmatrix}#?\\\\#?\\\\#?\\end{pmatrix}',
				class: 'small',
				command: virtualMatrixCommand(5),
				variants: [{ latex: '\\begin{bmatrix}#?\\\\#?\\\\#?\\end{bmatrix}', command: virtualMatrixCommand(6) }]
			},
			{ latex: '\\det', class: 'small' },
			{ latex: '^{-1}', class: 'small' },
			{ latex: '^{T}', class: 'small', variants: ['^{H}', '^{\\dagger}'] },
			{ label: '[separator]', width: 0.5 },
			'[7]',
			'[8]',
			'[9]',
			'[backspace]'
		],
		[
			{ latex: '\\in', variants: ['\\notin', '\\ni'] },
			{ latex: '\\subset', variants: ['\\subseteq', '\\subsetneq', '\\supset', '\\supseteq'] },
			{ latex: '\\cup', variants: ['\\cap', '\\setminus'] },
			{ latex: '\\emptyset', variants: ['\\varnothing'] },
			{ latex: '\\mathbb{R}', class: 'tex', variants: ['\\mathbb{N}', '\\mathbb{Z}', '\\mathbb{Q}', '\\mathbb{C}'] },
			{ label: '[separator]', width: 0.5 },
			'[4]',
			'[5]',
			'[6]',
			'[undo]'
		],
		[
			{ latex: '\\forall', variants: ['\\exists', '\\nexists'] },
			{ latex: '\\land', variants: ['\\lor', '\\lnot'] },
			{ latex: '\\implies', variants: ['\\iff', '\\Leftarrow'] },
			{ latex: '\\therefore', variants: ['\\because'] },
			'\\ldots',
			{ label: '[separator]', width: 0.5 },
			'[1]',
			'[2]',
			'[3]',
			'[redo]'
		],
		[
			'a',
			'b',
			'c',
			{ latex: 'n', variants: ['m', 'k'] },
			{ latex: 'i', variants: ['j'] },
			{ label: '[separator]', width: 0.5 },
			{ label: '[0]', width: 2 },
			'[.]',
			'[left]',
			'[right]'
		]
	]
});

const symbolsLayout = (): VirtualKeyboardLayout => ({
	label: m.mathpal_kbd_symbols_label(),
	tooltip: m.mathpal_kbd_symbols_tooltip(),
	rows: [
		[
			{ latex: '\\alpha', shift: '\\Alpha' },
			{ latex: '\\beta', shift: '\\Beta' },
			{ latex: '\\gamma', shift: '\\Gamma' },
			{ latex: '\\delta', shift: '\\Delta' },
			{ latex: '\\epsilon', shift: '\\varepsilon' },
			{ latex: '\\zeta', shift: '\\Zeta' },
			{ latex: '\\eta', shift: '\\Eta' },
			{ latex: '\\theta', shift: '\\Theta', variants: ['\\vartheta'] },
			{ latex: '\\iota', shift: '\\Iota' },
			'[backspace]'
		],
		[
			{ latex: '\\kappa', shift: '\\Kappa' },
			{ latex: '\\lambda', shift: '\\Lambda' },
			{ latex: '\\mu', shift: '\\Mu' },
			{ latex: '\\nu', shift: '\\Nu' },
			{ latex: '\\xi', shift: '\\Xi' },
			{ latex: 'o', shift: 'O' },
			{ latex: '\\pi', shift: '\\Pi', variants: ['\\varpi'] },
			{ latex: '\\rho', shift: '\\Rho', variants: ['\\varrho'] },
			{ latex: '\\sigma', shift: '\\Sigma', variants: ['\\varsigma'] },
			'[undo]'
		],
		[
			{ latex: '\\tau', shift: '\\Tau' },
			{ latex: '\\upsilon', shift: '\\Upsilon' },
			{ latex: '\\phi', shift: '\\Phi', variants: ['\\varphi'] },
			{ latex: '\\chi', shift: '\\Chi' },
			{ latex: '\\psi', shift: '\\Psi' },
			{ latex: '\\omega', shift: '\\Omega' },
			{ latex: '\\partial' },
			{ latex: '\\nabla' },
			{ latex: '\\hbar', variants: ['\\hslash'] },
			'[redo]'
		],
		[
			'[shift]',
			{ latex: '\\infty', variants: ['-\\infty'] },
			{ latex: '\\angle', variants: ['\\measuredangle', '\\sphericalangle'] },
			{ latex: '\\perp', variants: ['\\parallel'] },
			{ latex: '\\degree' },
			{ latex: '\\prime', variants: ['\\dprime', '\\trprime'] },
			{ latex: '\\cdot', variants: ['\\bullet', '\\circ'] },
			{ latex: '\\star', variants: ['\\ast'] },
			'[left]',
			'[right]'
		]
	]
});

const trigLayout = (): VirtualKeyboardLayout => ({
	label: m.mathpal_kbd_trig_label(),
	tooltip: m.mathpal_kbd_trig_tooltip(),
	rows: [
		[
			{ latex: '\\sin', class: 'small', variants: ['\\sin^{-1}', '\\arcsin'] },
			{ latex: '\\cos', class: 'small', variants: ['\\cos^{-1}', '\\arccos'] },
			{ latex: '\\tan', class: 'small', variants: ['\\tan^{-1}', '\\arctan'] },
			{ label: '[separator]', width: 0.5 },
			{ latex: '\\sinh', class: 'small' },
			{ latex: '\\cosh', class: 'small' },
			{ latex: '\\tanh', class: 'small' },
			{ label: '[separator]', width: 0.5 },
			'[backspace]'
		],
		[
			{ latex: '\\csc', class: 'small', variants: ['\\csc^{-1}', '\\arccsc'] },
			{ latex: '\\sec', class: 'small', variants: ['\\sec^{-1}', '\\arcsec'] },
			{ latex: '\\cot', class: 'small', variants: ['\\cot^{-1}', '\\arccot'] },
			{ label: '[separator]', width: 0.5 },
			{ latex: '\\ln', class: 'small', variants: ['\\log', '\\log_{#?}'] },
			{ latex: '\\exp', class: 'small' },
			{ latex: 'e^{#?}', class: 'small' },
			{ label: '[separator]', width: 0.5 },
			'[undo]'
		],
		[
			{ latex: '\\sqrt{#0}', variants: ['\\sqrt[3]{#0}', '\\sqrt[#?]{#0}'] },
			'#@^{#?}',
			{ latex: '#@^{2}' },
			{ label: '[separator]', width: 0.5 },
			{ latex: '\\min', class: 'small' },
			{ latex: '\\max', class: 'small' },
			{ latex: '\\mod', class: 'small' },
			{ label: '[separator]', width: 0.5 },
			'[redo]'
		],
		[
			'\\theta',
			'\\phi',
			'\\pi',
			{ latex: '\\degree' },
			{ label: '[separator]', width: 0.5 },
			{ latex: '\\lvert #0 \\rvert', class: 'small' },
			{ latex: '\\lfloor #0 \\rfloor', class: 'small' },
			{ latex: '\\lceil #0 \\rceil', class: 'small' },
			'[left]',
			'[right]'
		]
	]
});

export function texpileKeyboardLayouts(): (VirtualKeyboardLayout | VirtualKeyboardName)[] {
	return [basicLayout(), calculusLayout(), algebraLayout(), trigLayout(), symbolsLayout(), 'alphabetic'];
}

function isTouchDevice(): boolean {
	if (typeof window === 'undefined') return false;
	return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Installs localized Texpile layouts on MathLive's current singleton. */
export async function configureMathVirtualKeyboard(): Promise<void> {
	if (typeof window === 'undefined') return;

	// MathLive 0.110 can expose a null global until this initializer runs. Initialize synchronously
	// before settings hydration so a mathfield mounting during that wait can use the real singleton.
	initVirtualKeyboardInCurrentBrowsingContext();
	await loadSettings();
	// Do not capture the global before the await: settings hydration and field mount/unmount can
	// overlap, so configure the singleton currently owned by MathLive after hydration completes.
	const keyboard = window.mathVirtualKeyboard;
	if (!keyboard) {
		throw new Error('MathLive did not initialize its virtual keyboard in the current browsing context.');
	}
	keyboard.layouts = texpileKeyboardLayouts();

	if (!isTouchDevice() && !document.getElementById('texpile-math-virtual-keyboard-toggle-style')) {
		const style = document.createElement('style');
		style.id = 'texpile-math-virtual-keyboard-toggle-style';
		style.textContent = `
			math-field::part(virtual-keyboard-toggle) {
				display: none !important;
			}
		`;
		document.head.appendChild(style);
	}
}
