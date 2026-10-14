import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource, projectionIsCurrent } from '../src/index.ts';
import type { SyntaxNode } from '../src/index.ts';

const open = (text: string) => SourceDocument.open(new TextEncoder().encode(text));
function partition(document: SourceDocument, nodes: readonly SyntaxNode[], from = 0, to = document.length): void {
	let at = from;
	for (const node of nodes) {
		assert.equal(node.span.from, at);
		assert.ok(node.span.to > at);
		assert.equal(node.span.documentId, document.documentId);
		assert.equal(node.span.version, document.version);
		at = node.span.to;
		if (node.children.length && node.content) partition(document, node.children, node.content.from, node.content.to);
	}
	assert.equal(at, to);
}
const corpus = [
	'',
	'中文 😀 e\u0301\r\nNext.',
	'% comment $ { \\begin{opaque}\n\\section{A}',
	'\\section*{A {nested} \\textbf{B}}\ntext $x+1$ and $$x^2$$.',
	'\\begin{document}\n\\title{Title}\n\\section{Section}\n\\textit{A}\n\\end{document}',
	'\\begin{unknown}[a] {preserve} \\begin{nested}x\\end{nested}\\end{unknown}',
	'\\begin{equation}a+\\frac{1}{2}\\end{equation}',
	'\\verb|% { \\ | and \\verb*+x+$a$',
	'\\begin{verbatim}\\begin{document}% $ { \\end{verbatim}',
	'\\begin{document}\\begin{verbatim}\\end{document}\\end{verbatim}x\\end{document}',
	'\\newcommand{\\user}[2]{#2#1}\n\\user{a}{b}',
	'\\begin{tabular}{lr}\nA & B \\\\ \\hline\n\\end{tabular}',
	'\\% literal percent \\{ brace \\$ dollar',
	'\\(x+1\\) \\[x^2\\]',
	'\\section{brace\\}escaped} % final comment',
	'\\unknown[option]{a}{b}',
	'\\section{unfinished',
	'$unfinished',
	'\\begin{document}\\end{wrong}',
	'\\catcode`\\%=12\n% literal',
	'\\def\\x{hello}\n\\x',
	'text}tail'
];
for (const [i, text] of corpus.entries())
	test(`parser partitions original fixture ${i} without rewriting bytes`, () => {
		const document = open(text);
		const before = document.toBytes();
		const result = parseSource(document);
		partition(document, result.nodes);
		assert.deepEqual(document.toBytes(), before);
		assert.equal(result.nodes.map((n) => document.read(n.span.from, n.span.to)).join(''), text);
		assert.ok(Object.isFrozen(result));
	});
test('headings and formatting retain separate exact argument spans', () => {
	const document = open('prefix\\section*{A \\textbf{B}}suffix');
	const heading = parseSource(document).nodes[1]!;
	assert.equal(heading.kind, 'heading');
	assert.equal(heading.name, 'section*');
	assert.equal(document.read(heading.content!.from, heading.content!.to), 'A \\textbf{B}');
	assert.equal(heading.children[1]!.kind, 'format');
});
test('short heading option is preserved separately from the editable full title', () => {
	const document = open('\\section[Short]{Long title}');
	const heading = parseSource(document).nodes[0]!;
	assert.equal(heading.kind, 'heading');
	assert.equal(document.read(heading.content!.from, heading.content!.to), 'Long title');
	partition(document, parseSource(document).nodes);
});
test('non-BMP control symbols and verb delimiters never split Unicode scalars', () => {
	for (const text of ['\\😀 tail', '\\verb😀% { literal😀 after']) {
		const document = open(text);
		const result = parseSource(document);
		partition(document, result.nodes);
		assert.equal(result.nodes.map((n) => document.read(n.span.from, n.span.to)).join(''), text);
	}
});
test('unsupported starred formatting stays raw instead of silently changing semantics', () => {
	assert.equal(parseSource(open('\\textbf*{A}')).nodes[0]!.kind, 'raw');
});
test('an invalid verb cannot consume a following line to misidentify the document boundary', () => {
	const document = open('\\begin{document}\\verb|unterminated\n\\end{document}|');
	const result = parseSource(document);
	assert.equal(result.nodes[0]!.kind, 'raw');
	assert.ok(result.issues.some((i) => i.code === 'UNCLOSED'));
});
test('unknown environments stay opaque; comments cannot close them', () => {
	const document = open('\\begin{opaque}%\\end{opaque}\n\\section{not editable}\\end{opaque}');
	const result = parseSource(document);
	assert.equal(result.nodes.length, 1);
	assert.equal(result.nodes[0]!.kind, 'raw');
	assert.equal(result.nodes[0]!.children.length, 0);
	assert.deepEqual(result.issues, []);
});
test('verbatim end markers inside a document never terminate the outer environment', () => {
	const document = open('\\begin{document}\\begin{verbatim}\\end{document}\\end{verbatim}tail\\end{document}');
	const result = parseSource(document);
	assert.equal(result.nodes.length, 1);
	assert.equal(result.nodes[0]!.kind, 'environment');
	assert.equal(result.nodes[0]!.children.at(-1)!.kind, 'text');
	assert.equal(document.read(result.nodes[0]!.children.at(-1)!.span.from, result.nodes[0]!.children.at(-1)!.span.to), 'tail');
});
test('dynamic TeX syntax disables editable projection instead of guessing expansion', () => {
	const document = open('Before \\def\\x{value} after');
	const result = parseSource(document);
	assert.equal(result.nodes[0]!.name, 'dynamic-syntax');
	assert.equal(result.nodes.length, 1);
	assert.ok(result.issues.some((i) => i.code === 'DYNAMIC_SYNTAX'));
});
test('commented primitives do not change parsing rules', () => {
	assert.deepEqual(parseSource(open('%\\catcode\n\\section{A}')).issues, []);
});
test('unclosed and mismatched inputs retain source with actionable offsets', () => {
	for (const text of ['\\section{open', '$open', '\\begin{document}\\end{other}']) {
		const document = open(text);
		const result = parseSource(document);
		assert.ok(result.issues.some((i) => i.code === 'UNCLOSED'));
		assert.equal(result.nodes.at(-1)!.kind, 'raw');
		partition(document, result.nodes);
	}
});
test('recursive formatting is bounded and retains the unparsed suffix', () => {
	const document = open('\\textbf{'.repeat(100) + 'x' + '}'.repeat(100));
	const result = parseSource(document);
	assert.ok(result.issues.some((i) => i.code === 'DEPTH'));
	partition(document, result.nodes);
});
test('async results must match document identity and exact version', () => {
	const document = open('A');
	const result = parseSource(document);
	assert.equal(projectionIsCurrent(document, result), true);
	assert.equal(projectionIsCurrent(open('A'), result), false);
	const next = document.apply({ expectedVersion: 0, patches: [{ from: 0, to: 1, insert: 'B' }] }).document;
	assert.equal(projectionIsCurrent(next, result), false);
});
test('one parsed argument can be patched without changing unrelated comments or unknown macros', () => {
	const document = open('% keep\r\n\\section{Old}\r\n\\opaque{a}{b}\r\n');
	const heading = parseSource(document).nodes.find((n) => n.kind === 'heading')!;
	const next = document.apply({
		expectedVersion: document.version,
		patches: [{ from: heading.content!.from, to: heading.content!.to, insert: 'New 😀', expected: 'Old' }]
	}).document;
	assert.equal(next.read(), '% keep\r\n\\section{New 😀}\r\n\\opaque{a}{b}\r\n');
});

test('node and scanning budgets preserve the complete source as Raw without rewriting', () => {
	const document = open('\\section{A}\n\\textbf{B}\nplain');
	const original = document.toBytes();
	for (const limits of [{ maxNodes: 1, maxSteps: 10000 }, { maxNodes: 100, maxSteps: 2 }]) {
		const result = parseSource(document, limits);
		assert.deepEqual(result.issues, [{ code: 'BUDGET', offset: 0 }]);
		assert.equal(result.nodes.length, 1);
		assert.equal(result.nodes[0]!.kind, 'raw');
		partition(document, result.nodes);
		assert.deepEqual(document.toBytes(), original);
	}
	assert.throws(() => parseSource(document, { maxNodes: 0, maxSteps: 10 }), RangeError);
});
