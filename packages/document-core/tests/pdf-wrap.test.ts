import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfWrappedText } from '../src/pdf-wrap.ts';
const encode = (value: string) => new TextEncoder().encode(value);
test('PDF wrapping adds breaks only in body text, preserving source bytes, lines, math, code, comments and unknown arguments', () => {
 const run = '1234567890'.repeat(30);
 const source = '\ufeff\\documentclass{article}\r\n\\begin{document}\r\n' + run + '\r\n$' + run + '$\r\n\\begin{verbatim}\r\n' + run + '\r\n\\end{verbatim}\r\n% ' + run + '\r\n\\opaque{' + run + '}\r\n\\end{document}';
 const bytes = encode(source), preserved = bytes.slice(), wrapped = new TextDecoder('utf-8', { ignoreBOM: true }).decode(pdfWrappedText(bytes));
 assert.deepEqual(bytes, preserved); assert.equal(wrapped.split('\n').length, source.split('\n').length);
 assert.match(wrapped, /\\allowbreak\{\}/); assert.ok(wrapped.includes('$' + run + '$')); assert.ok(wrapped.includes('verbatim}\r\n' + run)); assert.ok(wrapped.includes('% ' + run)); assert.ok(wrapped.includes('\\opaque{' + run + '}'));
 assert.equal(wrapped.replaceAll('\\allowbreak{}', ''), source);
 const untouched = encode('\\documentclass{article}\n\\begin{document}short $' + run + '$\\end{document}'); assert.strictEqual(pdfWrappedText(untouched), untouched);
});
