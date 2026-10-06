// Samples are the real output of each tool, captured on a TeX Live 2025 + git install.
import { describe, it, expect } from 'vitest';
import { firstInformativeLine } from '../../../../../electron/src/toolchain';
import { TOOLS, toolsInGroup, installHint } from '$lib/workspace/toolchainCatalog';

describe('firstInformativeLine', () => {
	it('skips latexmk’s code-page chatter to reach the version line', () => {
		// the real reason this function scans instead of taking line 1
		const out = [
			'Initial Win CP for (console input, console output, system): (CP437, CP437, CP1252)',
			'I changed them all to CP1252',
			'Latexmk, John Collins, 15 June 2025. Version 4.87',
			'Reverting Windows console CPs to (in,out) = (437,437)'
		].join('\n');
		expect(firstInformativeLine(out)).toBe('Latexmk, John Collins, 15 June 2025. Version 4.87');
	});

	it('takes the first line when it already carries the version', () => {
		expect(firstInformativeLine('pdfTeX 3.141592653-2.6-1.40.28 (TeX Live 2025)\n')).toBe('pdfTeX 3.141592653-2.6-1.40.28 (TeX Live 2025)');
		expect(firstInformativeLine('git version 2.49.0.windows.1\n')).toBe('git version 2.49.0.windows.1');
		expect(firstInformativeLine('biber version: 2.21\n')).toBe('biber version: 2.21');
		expect(firstInformativeLine('3.24.6, 2025-08-08\n')).toBe('3.24.6, 2025-08-08');
	});

	it('suppresses a usage error rather than showing it as a version', () => {
		// `synctex --version` is not a real flag; it complains and still exits 0
		expect(firstInformativeLine('SyncTeX ERROR: Missing options\n')).toBeUndefined();
	});

	it('returns nothing for empty output', () => {
		expect(firstInformativeLine('')).toBeUndefined();
		expect(firstInformativeLine('\n  \n')).toBeUndefined();
	});

	it('truncates a pathologically long line', () => {
		const line = firstInformativeLine('x'.repeat(400) + ' 1.0');
		expect(line!.length).toBeLessThanOrEqual(90);
		expect(line!.endsWith('…')).toBe(true);
	});
});

describe('toolchain catalog', () => {
	it('has a unique id per tool', () => {
		const ids = TOOLS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('partitions every tool into exactly one group', () => {
		const grouped = [...toolsInGroup('latex'), ...toolsInGroup('typst'), ...toolsInGroup('general')];
		expect(grouped).toHaveLength(TOOLS.length);
	});

	it('gives every tool a purpose and an install hint on all three platforms', () => {
		for (const t of TOOLS) {
			expect(t.purpose, t.id).not.toBe('');
			expect(t.install.win, t.id).not.toBe('');
			expect(t.install.mac, t.id).not.toBe('');
			expect(t.install.linux, t.id).not.toBe('');
		}
	});

	it('returns a non-empty hint for the running platform', () => {
		for (const t of TOOLS) expect(installHint(t), t.id).toBeTruthy();
	});

	it('lists tinymist under typst, and the TeX tools under latex', () => {
		expect(toolsInGroup('typst').map((t) => t.id)).toEqual(['tinymist']);
		expect(toolsInGroup('latex').map((t) => t.id)).toContain('latexmk');
		expect(toolsInGroup('latex').map((t) => t.id)).toContain('synctex');
		expect(toolsInGroup('general').map((t) => t.id)).toEqual(['git']);
	});
});
