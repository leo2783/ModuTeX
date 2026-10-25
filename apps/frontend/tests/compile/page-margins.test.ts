import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { readPageMargins, planPageMarginPatches } from '../../src/features/compile/page-margins.ts';
import type { PageMarginsCm } from '../../src/features/compile/page-margins.ts';

const target: PageMarginsCm = { top: 1.5, bottom: 2.5, left: 3, right: 4 };
const document = (preamble: string, body = 'Body') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
function apply(source: string, margins = target): string {
 const patches = planPageMarginPatches(source, margins);
 for (const patch of [...patches].reverse()) {
  assert.equal(source.slice(patch.from, patch.to), patch.expected);
  source = source.slice(0, patch.from) + patch.insert + source.slice(patch.to);
 }
 return source;
}

test('page margins read physical dimensions and distinguish partial defaults', () => {
 assert.deepEqual(readPageMargins(document('\\usepackage[margin=20mm]{geometry}')).margins, {top:2,bottom:2,left:2,right:2});
 assert.equal(readPageMargins(document('\\usepackage[margin=20mm]{geometry}')).explicit, true);
 const partial = readPageMargins(document('\\usepackage[left=3cm]{geometry}'));
 assert.equal(partial.explicit, false);
 assert.deepEqual(partial.explicitSides, {top:false,bottom:false,left:true,right:false});
 assert.equal(readPageMargins(document('')).explicit, false);
});

test('page margins replace existing options once, preserve paper and body, and are idempotent', () => {
 const input = document('\\usepackage[a4paper,landscape,margin=2cm]{geometry}', 'Unicode 漢字 𠀀.');
 const output = apply(input);
 assert.deepEqual(readPageMargins(output).margins, target);
 assert.match(output, /a4paper,landscape/);
 assert.match(output, /Unicode 漢字 𠀀\./);
 assert.equal((output.match(/\\usepackage/g) ?? []).length, 1);
 assert.equal(apply(output), output);
 assert.equal(planPageMarginPatches(output, target).length, 0);
});

test('page margins preserve comments and resolve preamble overrides without editing body commands', () => {
 const body = '\\geometry{margin=9cm}\nBody';
 const input = document('% \\usepackage[margin=99cm]{geometry}\n\\usepackage[margin=2cm,a4paper]{geometry}\n\\geometry{top=3cm,bottom=4cm}',body);
 const output = apply(input);
 assert.deepEqual(readPageMargins(output).margins, target);
 assert(output.endsWith(`${body}\n\\end{document}\n`));
 assert.match(output, /% \\usepackage\[margin=99cm\]\{geometry\}/);
 assert.equal(apply(output), output);
});

test('page margins add one package when absent and retain CRLF', () => {
 const input = document('').replaceAll('\n','\r\n');
 const output = apply(input);
 assert.deepEqual(readPageMargins(output).margins, target);
 assert.equal((output.match(/\\usepackage/g) ?? []).length, 1);
 assert.equal(output.replaceAll('\r\n','').includes('\n'),false);
});

test('page margins reject dynamic values and invalid dimensions without rewriting', () => {
 for(const value of ['\\mymargin','NaNcm','-1cm','0cm']) {
  assert.throws(()=>readPageMargins(document(`\\usepackage[margin=${value}]{geometry}`)));
 }
 for(const value of [0,-1,Infinity,NaN,51]) {
  assert.throws(()=>apply(document(''),{...target,top:value}), /INVALID_PAGE_MARGIN/);
 }
 assert.throws(()=>apply(document('\\usepackage[textwidth=10cm]{geometry}')),/GEOMETRY_UNSUPPORTED/);
});

test('page margin parsing bounds oversized and deeply malformed input without recursive growth', {timeout:10000}, () => {
 const oversized='x'.repeat(5*1024*1024+1);
 assert.throws(()=>readPageMargins(oversized),/SOURCE_TOO_LARGE/);
 assert.throws(()=>planPageMarginPatches(oversized,target),/SOURCE_TOO_LARGE/);
 const malformed=document('\\usepackage['+'{'.repeat(250000)+'margin=2cm]{geometry}');
 const started=performance.now();
 assert.throws(()=>readPageMargins(malformed),/GEOMETRY_UNSUPPORTED/);
 assert(performance.now()-started<5000,'Malformed nesting must finish within a bounded pass');
});
