import { describe, it, expect } from 'vitest';
import { frontendDiagnostics } from '../src/frontend-diagnostics';

describe('conservative Tectonic diagnostics', () => {
	it('keeps explicit entry and included locations without guessing unqualified TeX lines', () => {
		const values = frontendDiagnostics('error: main.tex:2: Undefined control sequence\r\nerror: include.tex:7: Other error\n! Unknown error\nl.9 text\nerror: ../main.tex:8: Outside\nerror: ./main.tex:10: Another entry error', 'main.tex');
		expect(values.map((value) => value.line)).toEqual([2, 7, 8, 10]);
		expect(values.map((value) => value.path)).toEqual(['main.tex', 'include.tex', null, 'main.tex']);
		expect(values.every((value) => value.column === null)).toBe(true);
		expect(Object.isFrozen(values)).toBe(true);
	});
	it('preserves quoted nested Unicode paths and explicit columns', () => {
		const values = frontendDiagnostics('error: "./chapters/章節/β file.tex":12:9: Undefined control sequence', 'main.tex');
		expect(values).toEqual([{
			severity: 'error', message: 'Undefined control sequence', path: 'chapters/章節/β file.tex', line: 12, column: 9
		}]);
	});
	it('signals escaped locations without exposing their paths', () => {
		const values = frontendDiagnostics([
			'error: /tmp/private/main.tex:3: Outside POSIX path',
			'error: C:\\Users\\modutex\\private.tex:4: Outside Windows path',
			'error: ..\\..\\private.tex:5: Traversal path',
			'error: chapter.tex:secret:6: Alternate data stream'
		].join('\n'), 'main.tex');
		expect(values.map((value) => ({ path: value.path, line: value.line }))).toEqual([
			{ path: null, line: 3 }, { path: null, line: 4 }, { path: null, line: 5 }, { path: null, line: 6 }
		]);
		expect(values.map((value) => value.message)).toEqual(['Outside POSIX path', 'Outside Windows path', 'Traversal path', 'Alternate data stream']);
	});
	it('bounds count/message and rejects invalid line numbers', () => {
		expect(frontendDiagnostics('error: main.tex:0: No\nerror: main.tex:9007199254740992: No', 'main.tex')).toEqual([]);
		const repeated = Array.from({ length: 300 }, () => 'error: main.tex:2: ' + 'x'.repeat(600)).join('\n');
		const values = frontendDiagnostics(repeated, 'main.tex');
		expect(values).toHaveLength(256); expect(values[0]!.message).toHaveLength(512);
	});
	it('ignores malformed, truncated, and unknown error records', () => {
		const log = [
			'error: included.tex:0: Invalid line',
			'error: included.tex:9007199254740992: Out-of-range line',
			'error: included.tex:not-a-line: Malformed location',
			'error: included.tex:4:',
			'error: included.tex:4:   ',
			'error: "unterminated/included.tex:4: Malformed quoted path',
			'error: Tectonic stopped without a source location',
			'warning: included.tex:4: This is not an error',
			'! Undefined control sequence.',
			'l.4 \\unknowncommand'
		].join('\n');
		expect(frontendDiagnostics(log, 'main.tex')).toEqual([]);
	});
});
