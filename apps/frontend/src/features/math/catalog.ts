export interface CatalogItem {
	readonly id: string;
	readonly labelZh: string;
	readonly labelEn: string;
	readonly latex: string;
	readonly display: string;
}

export interface CatalogCategory {
	readonly id: string;
	readonly nameZh: string;
	readonly nameEn: string;
	readonly items: readonly CatalogItem[];
}

const symbols = (entries: readonly (readonly [string, string, string])[]): readonly CatalogItem[] => entries.map(([id, display, latex]) => ({ id, display, latex, labelZh: display, labelEn: display }));
export const MATH_CATALOG: readonly CatalogCategory[] = [
	{ id: 'common', nameZh: '常用結構', nameEn: 'Common structures', items: symbols([
		['nthroot', 'n 次根', '\\sqrt[#?]{#@}'], ['reciprocal', '倒數', '\\frac{1}{#@}'], ['abs', '絕對值', '\\left|#@\\right|'], ['parentheses', '括號', '\\left(#@\\right)'], ['inverse', '反矩陣', '#@^{-1}'], ['transpose', '轉置', '#@^{\\mathsf{T}}'], ['trace', '跡', '\\operatorname{tr}(#?)'], ['determinant', '行列式', '\\det(#?)'], ['unit-vector', '單位向量', '\\hat{#@}'], ['dots', '水平省略', '\\cdots'], ['vdots', '垂直省略', '\\vdots'], ['ddots', '對角省略', '\\ddots'], ['binom', '二項係數', '\\binom{#?}{#?}'], ['differential', '微分 d', '\\mathrm{d}'], ['division', '÷', '\\div'], ['minus-plus', '∓', '\\mp'], ['much-less', '≪', '\\ll'], ['much-greater', '≫', '\\gg'], ['less', '<', '<'], ['greater', '>', '>'], ['equals', '=', '='], ['degrees', '度數', '#@^{\\circ}']
	]) },
	{ id: 'matrix', nameZh: '矩陣結構', nameEn: 'Matrix structures', items: symbols([
		['column-vector', '列向量', '\\begin{pmatrix}#?\\\\#?\\\\#?\\end{pmatrix}'], ['identity', '單位矩陣', '\\begin{pmatrix}1&0&0\\\\0&1&0\\\\0&0&1\\end{pmatrix}'], ['pmatrix', '圓括號矩陣', '\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}'], ['bmatrix', '方括號矩陣', '\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}'], ['Bmatrix', '大括號矩陣', '\\begin{Bmatrix}#?&#?\\\\#?&#?\\end{Bmatrix}'], ['vmatrix', '行列式矩陣', '\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}'], ['Vmatrix', '雙直線矩陣', '\\begin{Vmatrix}#?&#?\\\\#?&#?\\end{Vmatrix}']
	]) },
	{ id: 'numbers', nameZh: '數系', nameEn: 'Number sets', items: symbols([
		['naturals', '自然數 ℕ', '\\mathbb{N}'], ['integers', '整數 ℤ', '\\mathbb{Z}'], ['rationals', '有理數 ℚ', '\\mathbb{Q}'], ['reals', '實數 ℝ', '\\mathbb{R}'], ['complex', '複數 ℂ', '\\mathbb{C}']
	]) },
	{ id: 'operators', nameZh: '運算子', nameEn: 'Operators', items: symbols([
		['sum-symbol', '求和符號 ∑', '\\sum'], ['prod-symbol', '乘積符號 ∏', '\\prod'], ['int-symbol', '積分符號 ∫', '\\int'], ['region-integral', '區域二重積分', '\\iint_D #?\\,\\mathrm{d}x\\,\\mathrm{d}y'], ['sin-angle', 'sin θ', '\\sin\\theta'], ['cos-angle', 'cos θ', '\\cos\\theta'], ['tan-angle', 'tan θ', '\\tan\\theta']
	]) },
	{ id: 'scientific-symbols', nameZh: '科學符號', nameEn: 'Scientific symbols', items: symbols([
		['alpha-decay', 'α 衰變', '{}^4_2\\alpha'], ['beta-decay', 'β 衰變', '\\beta^-'], ['gamma-ray', 'γ 射線', '\\gamma'], ['omega-frequency', '角頻率', '\\omega'], ['ohm', '歐姆 Ω', '\\Omega'], ['delta-variable', '變化量', '\\Delta #?'], ['reaction-forward', '正反應', '\\longrightarrow'], ['reaction-reverse', '逆反應', '\\longleftarrow'], ['equilibrium', '平衡反應', '\\rightleftharpoons'], ['reversible', '可逆反應', '\\leftrightarrow'], ['omicron', 'omicron', 'o']
	]) },
	{ id: 'relations', nameZh: '關係與箭頭', nameEn: 'Relations and arrows', items: symbols([
		['neq', '≠', '\\neq'], ['leq', '≤', '\\leq'], ['geq', '≥', '\\geq'], ['approx', '≈', '\\approx'], ['equiv', '≡', '\\equiv'], ['sim', '∼', '\\sim'], ['propto', '∝', '\\propto'], ['pm', '±', '\\pm'], ['times', '×', '\\times'], ['cdot', '·', '\\cdot'], ['infty', '∞', '\\infty'], ['to', '→', '\\to'], ['leftarrow', '←', '\\leftarrow'], ['leftrightarrow', '↔', '\\leftrightarrow'], ['implies', '⇒', '\\Rightarrow'], ['iff', '⇔', '\\Leftrightarrow'], ['mapsto', '↦', '\\mapsto'], ['perp', '⊥', '\\perp'], ['parallel', '∥', '\\parallel']
	]) },
	{ id: 'sets', nameZh: '集合與邏輯', nameEn: 'Sets and logic', items: symbols([
		['in', '∈', '\\in'], ['notin', '∉', '\\notin'], ['subset', '⊂', '\\subset'], ['subseteq', '⊆', '\\subseteq'], ['supset', '⊃', '\\supset'], ['supseteq', '⊇', '\\supseteq'], ['cup', '∪', '\\cup'], ['cap', '∩', '\\cap'], ['setminus', '集合差', '\\setminus'], ['emptyset', '∅', '\\emptyset'], ['forall', '∀', '\\forall'], ['exists', '∃', '\\exists'], ['neg', '¬', '\\neg'], ['land', '∧', '\\land'], ['lor', '∨', '\\lor']
	]) },
	{ id: 'trig', nameZh: '三角與對數', nameEn: 'Trigonometry and logarithms', items: symbols([
		['sin', 'sin', '\\sin #?'], ['cos', 'cos', '\\cos #?'], ['tan', 'tan', '\\tan #?'], ['cot', 'cot', '\\cot #?'], ['sec', 'sec', '\\sec #?'], ['csc', 'csc', '\\csc #?'], ['arcsin', 'arcsin', '\\arcsin #?'], ['arccos', 'arccos', '\\arccos #?'], ['arctan', 'arctan', '\\arctan #?'], ['sinh', 'sinh', '\\sinh #?'], ['cosh', 'cosh', '\\cosh #?'], ['tanh', 'tanh', '\\tanh #?'], ['ln', 'ln', '\\ln #?'], ['log', 'log', '\\log_{#?} #?'], ['exp', 'exp', '\\exp #?']
	]) },
	{ id: 'science', nameZh: '科學公式', nameEn: 'Scientific formulas', items: symbols([
		['energy', 'E = mc²', 'E=mc^2'], ['force', 'F = ma', 'F=ma'], ['gravity', '萬有引力', 'F=G\\frac{m_1m_2}{r^2}'], ['wave', '波速', 'v=f\\lambda'], ['ohm', '歐姆定律', 'V=IR'], ['schrodinger', '薛丁格方程', 'i\\hbar\\frac{\\partial\\Psi}{\\partial t}=\\hat{H}\\Psi'], ['hbar', 'ℏ', '\\hbar'], ['nabla', '∇', '\\nabla'], ['hat', '帽號', '\\hat{#@}'], ['vec', '向量', '\\vec{#@}'], ['dot', '一階時間導數', '\\dot{#@}'], ['ddot', '二階時間導數', '\\ddot{#@}'], ['bra', 'Bra', '\\left\\langle #?\\right|'], ['ket', 'Ket', '\\left|#?\\right\\rangle']
	]) },
	{
		id: 'greek-lower',
		nameZh: '希臘小寫',
		nameEn: 'Greek Lowercase',
		items: [
			{ id: 'alpha', labelZh: 'alpha', labelEn: 'alpha', latex: '\\alpha', display: 'α' },
			{ id: 'beta', labelZh: 'beta', labelEn: 'beta', latex: '\\beta', display: 'β' },
			{ id: 'gamma', labelZh: 'gamma', labelEn: 'gamma', latex: '\\gamma', display: 'γ' },
			{ id: 'delta', labelZh: 'delta', labelEn: 'delta', latex: '\\delta', display: 'δ' },
			{ id: 'epsilon', labelZh: 'epsilon', labelEn: 'epsilon', latex: '\\epsilon', display: 'ϵ' },
			{ id: 'varepsilon', labelZh: 'varepsilon', labelEn: 'varepsilon', latex: '\\varepsilon', display: 'ε' },
			{ id: 'zeta', labelZh: 'zeta', labelEn: 'zeta', latex: '\\zeta', display: 'ζ' },
			{ id: 'eta', labelZh: 'eta', labelEn: 'eta', latex: '\\eta', display: 'η' },
			{ id: 'theta', labelZh: 'theta', labelEn: 'theta', latex: '\\theta', display: 'θ' },
			{ id: 'vartheta', labelZh: 'vartheta', labelEn: 'vartheta', latex: '\\vartheta', display: 'ϑ' },
			{ id: 'iota', labelZh: 'iota', labelEn: 'iota', latex: '\\iota', display: 'ι' },
			{ id: 'kappa', labelZh: 'kappa', labelEn: 'kappa', latex: '\\kappa', display: 'κ' },
			{ id: 'lambda', labelZh: 'lambda', labelEn: 'lambda', latex: '\\lambda', display: 'λ' },
			{ id: 'mu', labelZh: 'mu', labelEn: 'mu', latex: '\\mu', display: 'μ' },
			{ id: 'nu', labelZh: 'nu', labelEn: 'nu', latex: '\\nu', display: 'ν' },
			{ id: 'xi', labelZh: 'xi', labelEn: 'xi', latex: '\\xi', display: 'ξ' },
			{ id: 'pi', labelZh: 'pi', labelEn: 'pi', latex: '\\pi', display: 'π' },
			{ id: 'varpi', labelZh: 'varpi', labelEn: 'varpi', latex: '\\varpi', display: 'ϖ' },
			{ id: 'rho', labelZh: 'rho', labelEn: 'rho', latex: '\\rho', display: 'ρ' },
			{ id: 'varrho', labelZh: 'varrho', labelEn: 'varrho', latex: '\\varrho', display: 'ϱ' },
			{ id: 'sigma', labelZh: 'sigma', labelEn: 'sigma', latex: '\\sigma', display: 'σ' },
			{ id: 'varsigma', labelZh: 'varsigma', labelEn: 'varsigma', latex: '\\varsigma', display: 'ς' },
			{ id: 'tau', labelZh: 'tau', labelEn: 'tau', latex: '\\tau', display: 'τ' },
			{ id: 'upsilon', labelZh: 'upsilon', labelEn: 'upsilon', latex: '\\upsilon', display: 'υ' },
			{ id: 'phi', labelZh: 'phi', labelEn: 'phi', latex: '\\phi', display: 'ϕ' },
			{ id: 'varphi', labelZh: 'varphi', labelEn: 'varphi', latex: '\\varphi', display: 'φ' },
			{ id: 'chi', labelZh: 'chi', labelEn: 'chi', latex: '\\chi', display: 'χ' },
			{ id: 'psi', labelZh: 'psi', labelEn: 'psi', latex: '\\psi', display: 'ψ' },
			{ id: 'omega', labelZh: 'omega', labelEn: 'omega', latex: '\\omega', display: 'ω' }
		]
	},
	{
		id: 'greek-upper',
		nameZh: '希臘大寫',
		nameEn: 'Greek Uppercase',
		items: [
			{ id: 'Gamma', labelZh: 'Gamma', labelEn: 'Gamma', latex: '\\Gamma', display: 'Γ' },
			{ id: 'Delta', labelZh: 'Delta', labelEn: 'Delta', latex: '\\Delta', display: 'Δ' },
			{ id: 'Theta', labelZh: 'Theta', labelEn: 'Theta', latex: '\\Theta', display: 'Θ' },
			{ id: 'Lambda', labelZh: 'Lambda', labelEn: 'Lambda', latex: '\\Lambda', display: 'Λ' },
			{ id: 'Xi', labelZh: 'Xi', labelEn: 'Xi', latex: '\\Xi', display: 'Ξ' },
			{ id: 'Pi', labelZh: 'Pi', labelEn: 'Pi', latex: '\\Pi', display: 'Π' },
			{ id: 'Sigma', labelZh: 'Sigma', labelEn: 'Sigma', latex: '\\Sigma', display: 'Σ' },
			{ id: 'Upsilon', labelZh: 'Upsilon', labelEn: 'Upsilon', latex: '\\Upsilon', display: 'Υ' },
			{ id: 'Phi', labelZh: 'Phi', labelEn: 'Phi', latex: '\\Phi', display: 'Φ' },
			{ id: 'Psi', labelZh: 'Psi', labelEn: 'Psi', latex: '\\Psi', display: 'Ψ' },
			{ id: 'Omega', labelZh: 'Omega', labelEn: 'Omega', latex: '\\Omega', display: 'Ω' }
		]
	},
	{
		id: 'lim-sum-prod',
		nameZh: '極限與級數',
		nameEn: 'Limits & Sums',
		items: [
			{ id: 'lim', labelZh: '極限', labelEn: 'Limit', latex: '\\lim_{#? \\to #?} #@', display: 'lim' },
			{ id: 'lim-inf', labelZh: '無窮極限', labelEn: 'Limit to infinity', latex: '\\lim_{#? \\to \\infty} #@', display: 'lim x→∞' },
			{ id: 'sum', labelZh: '求和', labelEn: 'Summation', latex: '\\sum_{#?}^{#?} #@', display: '∑' },
			{ id: 'sum-indexed', labelZh: '計數求和', labelEn: 'Indexed sum', latex: '\\sum_{i=1}^{n} #@', display: '∑ i=1..n' },
			{ id: 'prod', labelZh: '乘積', labelEn: 'Product', latex: '\\prod_{#?}^{#?} #@', display: '∏' },
			{ id: 'coprod', labelZh: '餘積', labelEn: 'Coproduct', latex: '\\coprod_{#?}^{#?} #@', display: '∐' },
			{ id: 'limsup', labelZh: '上極限', labelEn: 'Limsup', latex: '\\limsup_{#? \\to #?} #@', display: 'lim sup' },
			{ id: 'liminf', labelZh: '下極限', labelEn: 'Liminf', latex: '\\liminf_{#? \\to #?} #@', display: 'lim inf' }
		]
	},
	{
		id: 'calculus',
		nameZh: '微積分與導數',
		nameEn: 'Calculus',
		items: [
			{ id: 'int-def', labelZh: '定積分', labelEn: 'Definite integral', latex: '\\int_{#?}^{#?} #@ \\, \\mathrm{d}x', display: '∫_a^b dx' },
			{ id: 'int-indef', labelZh: '不定積分', labelEn: 'Indefinite integral', latex: '\\int #@ \\, \\mathrm{d}x', display: '∫ dx' },
			{ id: 'iint', labelZh: '二重積分', labelEn: 'Double integral', latex: '\\iint_{#?}^{#?} #@ \\, \\mathrm{d}x \\mathrm{d}y', display: '∬ dxdy' },
			{ id: 'iiint', labelZh: '三重積分', labelEn: 'Triple integral', latex: '\\iiint_{#?}^{#?} #@ \\, \\mathrm{d}V', display: '∭ dV' },
			{ id: 'oint', labelZh: '環路積分', labelEn: 'Contour integral', latex: '\\oint_{#?}^{#?} #@ \\, \\mathrm{d}s', display: '∮ ds' },
			{ id: 'diff-dx', labelZh: '微分元 dx', labelEn: 'Differential dx', latex: '\\, \\mathrm{d}x', display: 'dx' },
			{ id: 'diff-dt', labelZh: '微分元 dt', labelEn: 'Differential dt', latex: '\\, \\mathrm{d}t', display: 'dt' },
			{ id: 'deriv-1', labelZh: '一階導數', labelEn: 'First derivative', latex: '\\frac{\\mathrm{d}#?}{\\mathrm{d}x}', display: 'd/dx' },
			{ id: 'deriv-2', labelZh: '二階導數', labelEn: 'Second derivative', latex: '\\frac{\\mathrm{d}^2 #?}{\\mathrm{d}x^2}', display: 'd²/dx²' },
			{ id: 'partial-1', labelZh: '偏導數', labelEn: 'Partial derivative', latex: '\\frac{\\partial #?}{\\partial x}', display: '∂/∂x' },
			{ id: 'partial-2', labelZh: '二階偏導', labelEn: 'Second partial derivative', latex: '\\frac{\\partial^2 #?}{\\partial x^2}', display: '∂²/∂x²' },
			{ id: 'partial-xy', labelZh: '混合偏導', labelEn: 'Mixed partial derivative', latex: '\\frac{\\partial^2 #?}{\\partial x \\partial y}', display: '∂²/∂x∂y' },
			{ id: 'diff-partial', labelZh: '偏微分元', labelEn: 'Partial dx', latex: '\\partial x', display: '∂x' }
		]
	},
	{
		id: 'formulas',
		nameZh: '常用公式',
		nameEn: 'Common Formulas',
		items: [
			{ id: 'quadratic', labelZh: '二次方程根公式', labelEn: 'Quadratic formula', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', display: 'x = (-b±√Δ)/2a' },
			{ id: 'pythagoras', labelZh: '畢氏定理', labelEn: 'Pythagorean theorem', latex: 'a^2 + b^2 = c^2', display: 'a²+b²=c²' },
			{ id: 'euler-id', labelZh: '歐拉恆等式', labelEn: 'Euler identity', latex: 'e^{i\\pi} + 1 = 0', display: 'e^(iπ)+1=0' },
			{ id: 'euler-formula', labelZh: '歐拉公式', labelEn: 'Euler formula', latex: 'e^{ix} = \\cos x + i\\sin x', display: 'e^(ix)=cos+isin' },
			{ id: 'binomial', labelZh: '二項式定理', labelEn: 'Binomial theorem', latex: '(x + y)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{n-k} y^k', display: '(x+y)ⁿ' },
			{ id: 'taylor', labelZh: '泰勒展開式', labelEn: 'Taylor series', latex: 'f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!} (x-a)^n', display: 'Taylor' },
			{ id: 'gaussian-int', labelZh: '高斯積分', labelEn: 'Gaussian integral', latex: '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, \\mathrm{d}x = \\sqrt{\\pi}', display: '∫e^(-x²)dx' },
			{ id: 'trig-id', labelZh: '三角恆等式', labelEn: 'Trig identity', latex: '\\sin^2\\theta + \\cos^2\\theta = 1', display: 'sin²+cos²=1' }
		]
	},
	{
		id: 'multiline',
		nameZh: '多行環境',
		nameEn: 'Multiline',
		items: [
			{ id: 'aligned', labelZh: '等號對齊', labelEn: 'Aligned equations', latex: '\\begin{aligned}\n#@ &= #? \\\\\n&= #?\n\\end{aligned}', display: 'aligned' },
			{ id: 'split', labelZh: '多行函數', labelEn: 'Multiline function', latex: '\\begin{aligned}\nf(x)&=#?\\\\\n&=#?\n\\end{aligned}', display: 'f(x)' },
			{ id: 'dcases', labelZh: '展示型分段函數', labelEn: 'Display cases', latex: '\\left\\{\\begin{array}{ll}\\displaystyle #? & #?\\\\\\displaystyle #? & #?\\end{array}\\right.', display: 'dcases' },
			{ id: 'rcases', labelZh: '右括號分段函數', labelEn: 'Right cases', latex: '\\left.\\begin{array}{ll}#? & #?\\\\#? & #?\\end{array}\\right\\}', display: 'rcases' },
			{ id: 'cases', labelZh: '分段函數', labelEn: 'Cases environment', latex: '\\begin{cases}\n#@, & \\text{if } #? \\\\\n#?, & \\text{otherwise}\n\\end{cases}', display: 'cases' },
			{ id: 'gathered', labelZh: '置中聚集', labelEn: 'Gathered equations', latex: '\\begin{gathered}\n#@ \\\\\n#?\n\\end{gathered}', display: 'gathered' },
			{ id: 'matrix2', labelZh: '2x2 矩陣', labelEn: '2x2 Matrix', latex: '\\begin{matrix}\n#@ & #? \\\\\n#? & #?\n\\end{matrix}', display: '2×2' }
		]
	}
];
