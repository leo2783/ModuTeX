// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { hasNextSnippetField, nextSnippetField, snippet } from '@codemirror/autocomplete';
import { SYMBOL_GROUPS, toCmSnippet, toSourceBlock, generateMatrixLatex } from '../../../../../src/lib/editor/comp/toolbar/mathSymbols';
import { tableLatex } from '../../../../../src/lib/editor/comp/toolbar/tableLatex';

/** run a template through CodeMirror the way the toolbars do, and read back what landed.
 *  destroy eagerly: a live view keeps measuring in rAF, which throws in a layout-less jsdom. */
function insert(template: string): string {
	const view = new EditorView({ state: EditorState.create({ doc: '' }), parent: document.body });
	try {
		snippet(template)(view, null, 0, 0);
		return view.state.doc.toString();
	} finally {
		view.destroy();
	}
}

describe('source toolbar insertion', () => {
	// the trap: CodeMirror reads "${" and "#{" as tab-stop syntax, and LaTeX is all braces.
	// every symbol must survive the round trip with its braces and backslashes intact.
	// Each insertion gets the same default timeout and a fresh real view. Aggregating the
	// entire palette under one timeout made the budget depend on palette size / CI load.
	const paletteCases = SYMBOL_GROUPS.flatMap((group) => group.symbols.map((sym, index) => ({ group: group.id, index, latex: sym.latex })));
	it.each(paletteCases)('inserts palette $group[$index]: $latex without mangling its LaTeX', ({ latex }) => {
		const expected = latex.replace(/#[?@0]/g, '');
		expect(insert(toCmSnippet(latex)), latex).toBe(expected);
	});

	it('turns mathlive holes into tab stops and leaves LaTeX braces alone', () => {
		expect(toCmSnippet('\\frac{#@}{#0}')).toBe('\\frac{${1}}{${2}}');
		expect(toCmSnippet('\\alpha')).toBe('\\alpha');
	});

	// a matrix on one line is unreadable in source, where that line IS the document
	it('breaks multi-row environments over lines, leaving inline symbols alone', () => {
		expect(toSourceBlock(generateMatrixLatex(2, 2, 'pmatrix'))).toBe('\\begin{pmatrix}\n\t#? & #? \\\\\n\t#? & #?\n\\end{pmatrix}');
		// rows go in verbatim, so aligned's &= survives
		expect(toSourceBlock('\\begin{aligned}#? &= #? \\\\ #? &= #?\\end{aligned}')).toBe(
			'\\begin{aligned}\n\t#? &= #? \\\\\n\t#? &= #?\n\\end{aligned}'
		);
		expect(toSourceBlock('\\alpha')).toBe('\\alpha');
		expect(toSourceBlock('\\frac{#@}{#0}')).toBe('\\frac{#@}{#0}');
	});

	it('places the cursor in the first matrix cell and advances through its cells with Tab', () => {
		const view = new EditorView({ state: EditorState.create({ doc: '' }), parent: document.body });
		try {
			snippet(toCmSnippet(toSourceBlock(generateMatrixLatex(1, 2, 'pmatrix'))))(view, null, 0, 0);
			const firstCell = view.state.selection.main;
			// CodeMirror consumes MathLive #? placeholders into empty snippet fields.
			expect(view.state.doc.toString()).toBe('\\begin{pmatrix} & \\end{pmatrix}');
			expect(firstCell.from).toBe('\\begin{pmatrix}'.length);
			expect(firstCell.empty).toBe(true);
			expect(hasNextSnippetField(view.state)).toBe(true);
			expect(nextSnippetField(view)).toBe(true);
			expect(view.state.selection.main.from).toBeGreaterThan(firstCell.from);
		} finally {
			view.destroy();
		}
	});

	it('builds a tabular, optionally floated with a caption', () => {
		expect(tableLatex({ rows: 2, cols: 2, float: false, rules: false, header: false })).toBe(
			'\\begin{tabular}{cc}\n\t & \\\\\n\t & \\\\\n\\end{tabular}'
		);
		const floated = insert(tableLatex({ rows: 1, cols: 2, float: true, rules: true, header: true }));
		expect(floated).toContain('\\begin{table}[htbp]');
		expect(floated).toContain('\\centering');
		expect(floated).toContain('\\begin{tabular}{cc}');
		expect(floated).toContain('\\hline');
		expect(floated).toContain('\\caption{Caption}');
		expect(floated).toContain('\\label{tab:label}');
	});
});
