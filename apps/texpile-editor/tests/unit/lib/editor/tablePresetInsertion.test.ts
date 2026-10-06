import { describe, expect, it } from 'vitest';
import { schema } from '$lib/schema/schema';
import { tablePresetLatex } from '$lib/editor/comp/toolbar/tableLatex';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import { serializeToLatex } from '$lib/serializer/latexSerializer';

function latexStructure(source: string) {
	return {
		colspec: source.match(/\\begin\{tabular\}\{([^}]+)\}/)?.[1],
		rules: source.match(/\\(?:toprule|midrule|bottomrule|hdashline|hline)/g) ?? []
	};
}

describe('table preset insertion', () => {
	it.each(['booktabs', 'three-line', 'full-grid', 'horizontal-lines', 'arydshln'] as const)(
		'%s source and visual insertion serialize the same tabular layout',
		(preset) => {
			const visualTable = createTableNode(schema, 2, 2, false, preset);
			const visual = serializeToLatex(schema.nodes.doc.create(null, visualTable));
			const source = tablePresetLatex({ rows: 2, cols: 2, float: false, preset });
			expect(latexStructure(visual)).toEqual(latexStructure(source));
		}
	);

	it('emits three equal-weight rules even for a one-row header-only table', () => {
		const visualTable = createTableNode(schema, 1, 1, false, 'three-line');
		const visual = serializeToLatex(schema.nodes.doc.create(null, visualTable));
		const source = tablePresetLatex({ rows: 1, cols: 1, float: false, preset: 'three-line' });
		expect(visual.match(/\\hline/g)).toHaveLength(3);
		expect(source.match(/\\hline/g)).toHaveLength(3);
	});

	it('retains caption and label snippets for floated source tables', () => {
		const latex = tablePresetLatex({ rows: 2, cols: 2, float: true, preset: 'full-grid' });
		expect(latex).toContain('\\begin{tabular}{|c|c|}');
		expect(latex).toContain('\\begin{table}[htbp]');
		expect(latex).toContain('\\caption{${1:Caption}}');
		expect(latex).toContain('\\label{tab:${2:label}}');
	});
});
