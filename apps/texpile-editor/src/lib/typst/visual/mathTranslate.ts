// Typst math -> LaTeX, over the CST the converter already holds. STRICTLY conservative: the
// translation exists so MathLive (which speaks LaTeX) can edit the equation, and a wrong
// translation would round-trip wrong bytes into the document - so anything not provably
// translatable returns null and the equation stays a raw island. The return trip (LaTeX ->
// Typst) is MathLive's own atom-to-typst serializer, not ours (see latexToTypst.ts).
import type { SyntaxNode } from '@lezer/common';

/** multi-letter typst math identifiers with an exact LaTeX counterpart. Additive-only. */
const IDENTS: Record<string, string> = {
	alpha: '\\alpha',
	beta: '\\beta',
	gamma: '\\gamma',
	delta: '\\delta',
	epsilon: '\\varepsilon',
	zeta: '\\zeta',
	eta: '\\eta',
	theta: '\\vartheta',
	iota: '\\iota',
	kappa: '\\kappa',
	lambda: '\\lambda',
	mu: '\\mu',
	nu: '\\nu',
	xi: '\\xi',
	pi: '\\pi',
	rho: '\\rho',
	sigma: '\\sigma',
	tau: '\\tau',
	upsilon: '\\upsilon',
	phi: '\\varphi',
	chi: '\\chi',
	psi: '\\psi',
	omega: '\\omega',
	Gamma: '\\Gamma',
	Delta: '\\Delta',
	Theta: '\\Theta',
	Lambda: '\\Lambda',
	Xi: '\\Xi',
	Pi: '\\Pi',
	Sigma: '\\Sigma',
	Phi: '\\Phi',
	Psi: '\\Psi',
	Omega: '\\Omega',
	sum: '\\sum',
	product: '\\prod',
	integral: '\\int',
	oo: '\\infty',
	infinity: '\\infty',
	infty: '\\infty',
	times: '\\times',
	div: '\\div',
	pm: '\\pm',
	mp: '\\mp',
	dot: '\\cdot',
	approx: '\\approx',
	equiv: '\\equiv',
	prop: '\\propto',
	subset: '\\subset',
	supset: '\\supset',
	union: '\\cup',
	sect: '\\cap',
	forall: '\\forall',
	exists: '\\exists',
	nabla: '\\nabla',
	partial: '\\partial',
	emptyset: '\\emptyset',
	RR: '\\mathbb{R}',
	NN: '\\mathbb{N}',
	ZZ: '\\mathbb{Z}',
	QQ: '\\mathbb{Q}',
	CC: '\\mathbb{C}',
	sin: '\\sin',
	cos: '\\cos',
	tan: '\\tan',
	log: '\\log',
	ln: '\\ln',
	exp: '\\exp',
	lim: '\\lim',
	max: '\\max',
	min: '\\min',
	// typst's differential; \mathrm{d} is what MathLive's typst serializer maps back to `dif`
	dif: '\\mathrm{d}'
};

/** typst math shorthands (own CST kind) with an exact LaTeX counterpart. */
const SHORTHANDS: Record<string, string> = {
	'<=': '\\le',
	'>=': '\\ge',
	'!=': '\\ne',
	'->': '\\to',
	'=>': '\\Rightarrow',
	'<-': '\\leftarrow',
	'...': '\\ldots'
};

/** MathText that can pass through as-is: no LaTeX-special characters. */
const SAFE_TEXT = /^[A-Za-z0-9+\-=(),.!?:;|'\s/<>*]*$/;

function kids(node: SyntaxNode): SyntaxNode[] {
	const out: SyntaxNode[] = [];
	for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
	return out;
}

/**
 * An attach/frac operand. `_(k=1)` and `(a+b)/2` group with parens typst HIDES - the CST wraps
 * them as Math [LeftParen ... RightParen] - so the LaTeX braces must replace them, not show them.
 */
function operand(n: SyntaxNode, src: string): string | null {
	const dk = kids(n);
	if (n.name === 'Math' && dk.length >= 2 && dk[0].name === 'LeftParen' && dk[dk.length - 1].name === 'RightParen') {
		const parts: string[] = [];
		for (const inner of dk.slice(1, -1)) {
			const t = translate(inner, src);
			if (t == null) return null;
			parts.push(t);
		}
		return parts.join('');
	}
	return translate(n, src);
}

function translate(node: SyntaxNode, src: string): string | null {
	const slice = src.slice(node.from, node.to);
	switch (node.name) {
		case 'Math': {
			const parts: string[] = [];
			for (const k of kids(node)) {
				const t = translate(k, src);
				if (t == null) return null;
				parts.push(t);
			}
			return parts.join('');
		}
		case 'MathText':
			return SAFE_TEXT.test(slice) ? slice : null;
		case 'Space':
			return ' ';
		case 'MathIdent':
			if (slice.length === 1) return slice;
			return IDENTS[slice] ?? null;
		case 'MathShorthand':
			return SHORTHANDS[slice] ?? null;
		case 'MathAttach': {
			// base then any of (_ sub) / (^ sup), in source order; whitespace is layout, not content
			const parts = kids(node).filter((k) => k.name !== 'Space');
			if (parts.length === 0) return null;
			const base = translate(parts[0], src);
			if (base == null) return null;
			let out = base;
			for (let i = 1; i < parts.length; i += 2) {
				const op = parts[i]?.name;
				const arg = parts[i + 1] ? operand(parts[i + 1], src) : null;
				if (arg == null) return null;
				if (op === 'Underscore') out += `_{${arg}}`;
				else if (op === 'Hat') out += `^{${arg}}`;
				else return null;
			}
			return out;
		}
		case 'MathFrac': {
			// `x / y` carries Space nodes around the slash; they are layout, not content
			const parts = kids(node).filter((k) => k.name !== 'Slash' && k.name !== 'Space');
			if (parts.length !== 2) return null;
			const a = operand(parts[0], src);
			const b = operand(parts[1], src);
			return a != null && b != null ? `\\frac{${a}}{${b}}` : null;
		}
		case 'MathDelimited': {
			const parts: string[] = [];
			for (const k of kids(node)) {
				const t = translate(k, src);
				if (t == null) return null;
				parts.push(t);
			}
			return parts.join('');
		}
		case 'MathPrimes':
			return /^'+$/.test(slice) ? slice : null;
		default:
			// FieldAccess (theta.alt), FuncCall (mat, cases, sqrt via juxtaposition), roots,
			// alignment points, strings, code: no faithful mapping - the equation stays raw
			return null;
	}
}

/**
 * The LaTeX for a whole `Equation` CST node, or null when any part lacks an exact mapping.
 * `sqrt(...)`-style juxtaposed calls are rejected as a WHOLE equation: the call shows up as a
 * translatable MathIdent next to a MathDelimited, which would silently drop the function.
 */
export function typstMathToLatex(equation: SyntaxNode, src: string): string | null {
	const math = kids(equation).find((k) => k.name === 'Math');
	if (!math) return null;
	// reject ident-followed-by-delimited anywhere: f(x) is fine for single letters (MathLive
	// reads it back the same), but sqrt(x)/vec(x) would translate to a bare name
	for (let c: SyntaxNode | null = math.firstChild; c; c = c.nextSibling) {
		if (c.name === 'MathIdent' && src.slice(c.from, c.to).length > 1 && c.nextSibling?.name === 'MathDelimited') return null;
	}
	const out = translate(math, src);
	return out?.trim() ? out.trim() : null;
}
