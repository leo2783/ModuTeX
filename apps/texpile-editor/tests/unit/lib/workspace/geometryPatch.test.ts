import { describe, expect, it } from 'vitest';
import { inspectPageMargins, patchPageMargins, validatePageMargins, type PageMargins } from '$lib/workspace/geometryPatch';

const sourceWithoutGeometry = '\\documentclass{article}\n\\begin{document}\nKeep body bytes.\n\\end{document}\n';
const sourceWithGeometry = '\\documentclass{article}\n\\usepackage{geometry}\n\\begin{document}\nKeep body bytes.\n\\end{document}\n';
const values: PageMargins = { top: '1.25', right: '2.5', bottom: '3.75', left: '4.125' };

describe('geometry-backed page margins', () => {
	it('validates finite decimal centimeters independently for all four sides', () => {
		expect(validatePageMargins(values)).toEqual(values);
		for (const invalid of ['-1', 'NaN', 'Infinity', '1e2', '101', '']) {
			expect(validatePageMargins({ ...values, left: invalid })).toBeNull();
		}
	});

	it('asks before adding geometry, then writes the four distinct real LaTeX lengths', () => {
		expect(patchPageMargins(sourceWithoutGeometry, values)).toEqual({ kind: 'needs-package' });
		const patch = patchPageMargins(sourceWithoutGeometry, values, true);
		expect(patch.kind).toBe('ready');
		if (patch.kind !== 'ready') return;
		expect(patch.addedGeometryPackage).toBe(true);
		expect(patch.source).toContain('\\usepackage{geometry}\n');
		expect(patch.source).toContain('\\geometry{top=1.25cm,right=2.5cm,bottom=3.75cm,left=4.125cm}');
		expect(patch.source.endsWith('Keep body bytes.\n\\end{document}\n')).toBe(true);
		expect(patch.source.slice(patch.preamble.length)).toBe(sourceWithoutGeometry.slice(sourceWithoutGeometry.indexOf('\\begin{document}')));
	});

	it('updates only its canonical owned block and leaves the remaining source byte-identical', () => {
		const initial = patchPageMargins(sourceWithGeometry, values);
		expect(initial.kind).toBe('ready');
		if (initial.kind !== 'ready') return;
		const next = patchPageMargins(initial.source, { ...values, left: '5.5' });
		expect(next.kind).toBe('ready');
		if (next.kind !== 'ready') return;
		expect(next.source).toContain('left=5.5cm');
		expect(next.source.match(/ModuTeX page margins begin/g)).toHaveLength(1);
		expect(
			next.source.replace(
				next.source.slice(
					next.source.indexOf('% ModuTeX page margins begin'),
					next.source.indexOf('% ModuTeX page margins end') + '% ModuTeX page margins end\n'.length
				),
				''
			)
		).toBe(
			initial.source.replace(
				initial.source.slice(
					initial.source.indexOf('% ModuTeX page margins begin'),
					initial.source.indexOf('% ModuTeX page margins end') + '% ModuTeX page margins end\n'.length
				),
				''
			)
		);
		expect(inspectPageMargins(next.source)).toEqual({ kind: 'ready', values: { ...values, left: '5.5' }, needsGeometryPackage: false });
	});

	it('preserves CRLF and the untouched document body', () => {
		const crlf = sourceWithGeometry.replaceAll('\n', '\r\n');
		const patch = patchPageMargins(crlf, values);
		expect(patch.kind).toBe('ready');
		if (patch.kind !== 'ready') return;
		expect(patch.source.replaceAll('\r\n', '')).not.toContain('\n');
		expect(patch.source.slice(patch.preamble.length)).toBe(crlf.slice(crlf.indexOf('\\begin{document}')));
	});

	it('fails closed for custom options, unknown geometry commands, malformed managed blocks, and unsafe preambles', () => {
		expect(
			inspectPageMargins('\\documentclass{article}\n\\usepackage[margin=2cm]{geometry}\n\\begin{document}\nBody\n\\end{document}\n')
		).toEqual({
			kind: 'blocked',
			reason: 'geometry-package-options'
		});
		expect(inspectPageMargins(sourceWithGeometry.replace('\\begin{document}', '\\geometry{left=2cm}\n\\begin{document}'))).toEqual({
			kind: 'blocked',
			reason: 'unknown-geometry-settings'
		});
		const malformed = sourceWithGeometry.replace(
			'\\begin{document}',
			'% ModuTeX page margins begin\n\\geometry{margin=2cm}\n% ModuTeX page margins end\n\\begin{document}'
		);
		expect(inspectPageMargins(malformed)).toEqual({ kind: 'blocked', reason: 'malformed-managed-settings' });
		expect(inspectPageMargins(sourceWithGeometry.replace('\\begin{document}', '\\input{setup}\n\\begin{document}'))).toEqual({
			kind: 'blocked',
			reason: 'invalid-preamble'
		});
	});

	it('does not treat a marked geometry block in the document body as ModuTeX-owned preamble settings', () => {
		const body = `${sourceWithGeometry}% ModuTeX page margins begin\n\\geometry{margin=2cm}\n% ModuTeX page margins end\n`;
		expect(inspectPageMargins(body)).toEqual({ kind: 'blocked', reason: 'unknown-geometry-settings' });
	});
});
