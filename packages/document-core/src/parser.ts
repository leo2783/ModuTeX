// Original ModuTeX implementation. License pending provenance review.
// A conservative source projection, not a TeX interpreter. Every byte stays in SourceDocument.
import type { SourceSpan } from './changes.ts';
import { SourceDocument } from './source.ts';

export type SyntaxKind = 'text' | 'comment' | 'heading' | 'format' | 'math' | 'environment' | 'raw';
export interface SyntaxNode {
	readonly kind: SyntaxKind;
	readonly span: SourceSpan;
	readonly name: string;
	readonly content: SourceSpan | null;
	readonly children: readonly SyntaxNode[];
}
export interface ParseIssue {
	readonly code: 'UNCLOSED' | 'MISMATCH' | 'DEPTH' | 'DYNAMIC_SYNTAX' | 'BUDGET';
	readonly offset: number;
}
export interface SourceProjection {
	readonly documentId: string;
	readonly version: number;
	readonly nodes: readonly SyntaxNode[];
	readonly issues: readonly ParseIssue[];
}

const headings = new Set(['title', 'section', 'subsection', 'subsubsection']);
const formatting = new Set(['textbf', 'textit', 'emph', 'underline']);
const containers = new Set(['document', 'table', 'table*']);
const literalEnvironments = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted']);
const dynamic = new Set(['catcode', 'def', 'gdef', 'edef', 'xdef', 'let', 'futurelet', 'csname', 'ExplSyntaxOn']);

export interface ParseLimits { readonly maxNodes: number; readonly maxSteps: number }
export function parseSource(document: Pick<SourceDocument, 'read' | 'documentId' | 'version'>,
	limits: ParseLimits = { maxNodes: 32768, maxSteps: 8_000_000 }): SourceProjection {
	if (![limits.maxNodes, limits.maxSteps].every((value) => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid parse budget');
	const text = document.read();
	const exhausted = Symbol('parse-budget');
	let steps = 0;
	let count = 0;
	const tick = () => { if (++steps > limits.maxSteps) throw exhausted; };
	const issues: ParseIssue[] = [];
	const span = (from: number, to: number): SourceSpan =>
		Object.freeze({
			documentId: document.documentId,
			version: document.version,
			from,
			to
		});
	const node = (
		kind: SyntaxKind,
		from: number,
		to: number,
		name = '',
		content: SourceSpan | null = null,
		children: readonly SyntaxNode[] = []
	): SyntaxNode => {
		if (++count > limits.maxNodes) throw exhausted;
		return Object.freeze({
			kind,
			span: span(from, to),
			name,
			content,
			children: Object.freeze([...children])
		});
	};
	const command = (at: number) => {
		let end = at + 1;
		if (/[A-Za-z]/.test(text[end] ?? '')) {
			while (/[A-Za-z]/.test(text[end] ?? '')) { tick(); end++; }
		} else if (end < text.length) end += text.codePointAt(end)! > 0xffff ? 2 : 1;
		return { name: text.slice(at + 1, end), end };
	};
	const commentEnd = (at: number, limit: number) => {
		while (at < limit && text[at] !== '\n' && text[at] !== '\r') { tick(); at++; }
		return at;
	};
	const whitespace = (at: number, limit: number) => {
		while (at < limit) {
			tick();
			if (/\s/.test(text[at]!)) at++;
			else if (text[at] === '%') at = commentEnd(at, limit);
			else break;
		}
		return at;
	};
	// Returns the exclusive delimiter end. Escaped punctuation and comments do not balance groups.
	const balanced = (at: number, limit: number, open = '{', close = '}'): number | null => {
		if (text[at] !== open) return null;
		let depth = 1;
		for (let i = at + 1; i < limit; i++) {
			tick();
			if (text[i] === '\\') {
				i = command(i).end - 1;
				continue;
			}
			if (text[i] === '%') {
				i = commentEnd(i, limit) - 1;
				continue;
			}
			if (text[i] === open) depth++;
			else if (text[i] === close && --depth === 0) return i + 1;
		}
		return null;
	};
	const environmentName = (at: number, limit: number) => {
		const start = whitespace(at, limit);
		const end = balanced(start, limit);
		if (!end) return null;
		const name = text.slice(start + 1, end - 1);
		return /^[A-Za-z][A-Za-z0-9*_-]*$/.test(name) ? { name, end } : null;
	};
	const closeEnvironment = (name: string, at: number, limit: number) => {
		const stack = [name];
		for (let i = at; i < limit; i++) {
			tick();
			if (text[i] === '%') {
				i = commentEnd(i, limit) - 1;
				continue;
			}
			if (text[i] !== '\\') continue;
			const cmd = command(i);
			i = cmd.end - 1;
			if (cmd.name === 'verb') {
				const start = text[cmd.end] === '*' ? cmd.end + 1 : cmd.end;
				const delimiter = start < text.length ? String.fromCodePoint(text.codePointAt(start)!) : undefined;
				if (delimiter && !/\s/.test(delimiter)) {
					const end = text.indexOf(delimiter, start + delimiter.length);
					if (end < 0 || end >= commentEnd(start, limit)) return null;
					i = end + delimiter.length - 1;
				}
				continue;
			}
			if (cmd.name !== 'begin' && cmd.name !== 'end') continue;
			const env = environmentName(cmd.end, limit);
			if (!env) continue;
			if (cmd.name === 'begin' && literalEnvironments.has(env.name)) {
				const marker = '\\end{' + env.name + '}';
				const end = text.indexOf(marker, env.end);
				if (end < 0 || end + marker.length > limit) return null;
				i = end + marker.length - 1;
				continue;
			}
			if (cmd.name === 'begin') stack.push(env.name);
			else {
				if (stack.at(-1) !== env.name) {
					issues.push(Object.freeze({ code: 'MISMATCH', offset: cmd.end - cmd.name.length - 1 }));
					return null;
				}
				stack.pop();
				if (!stack.length) return { from: cmd.end - cmd.name.length - 1, to: env.end };
			}
			i = env.end - 1;
		}
		return null;
	};
	const mathEnd = (at: number, limit: number, delimiter: string): number | null => {
		for (let i = at; i < limit; i++) {
			tick();
			if (text[i] === '%') {
				i = commentEnd(i, limit) - 1;
				continue;
			}
			if (text.startsWith(delimiter, i)) return i + delimiter.length;
			if (text[i] === '\\') i = command(i).end - 1;
		}
		return null;
	};
	const parse = (from: number, to: number, depth: number): readonly SyntaxNode[] => {
		if (depth > 64) {
			issues.push(Object.freeze({ code: 'DEPTH', offset: from }));
			return [node('raw', from, to, 'depth-limit')];
		}
		const nodes: SyntaxNode[] = [];
		let i = from;
		while (i < to) {
			tick();
			const start = i;
			if (text[i] === '%') {
				i = commentEnd(i, to);
				nodes.push(node('comment', start, i));
			} else if (text[i] === '$') {
				const delimiter = text[i + 1] === '$' ? '$$' : '$';
				const end = mathEnd(i + delimiter.length, to, delimiter);
				if (end === null) {
					issues.push(Object.freeze({ code: 'UNCLOSED', offset: i }));
					nodes.push(node('raw', i, to, delimiter));
					i = to;
				} else {
					nodes.push(node('math', i, end, delimiter, span(i + delimiter.length, end - delimiter.length)));
					i = end;
				}
			} else if (text[i] === '\\') {
				const cmd = command(i);
				i = cmd.end;
				if (dynamic.has(cmd.name)) {
					issues.push(Object.freeze({ code: 'DYNAMIC_SYNTAX', offset: start }));
					nodes.push(node('raw', start, to, cmd.name));
					i = to;
				} else if (cmd.name === '(' || cmd.name === '[') {
					const delimiter = cmd.name === '(' ? '\\)' : '\\]';
					const end = mathEnd(i, to, delimiter);
					if (end === null) {
						issues.push(Object.freeze({ code: 'UNCLOSED', offset: start }));
						nodes.push(node('raw', start, to, cmd.name));
						i = to;
					} else {
						nodes.push(node('math', start, end, cmd.name, span(i, end - 2)));
						i = end;
					}
				} else if (cmd.name === 'verb') {
					const contentStart = text[i] === '*' ? i + 1 : i;
					const delimiter = contentStart < text.length ? String.fromCodePoint(text.codePointAt(contentStart)!) : undefined;
					const end = delimiter && !/\s/.test(delimiter) ? text.indexOf(delimiter, contentStart + delimiter.length) : -1;
					const eol = commentEnd(contentStart, to);
					if (end < 0 || end >= eol) {
						issues.push(Object.freeze({ code: 'UNCLOSED', offset: start }));
						i = eol;
						nodes.push(node('raw', start, i, 'verb'));
					} else {
						i = end + delimiter!.length;
						nodes.push(node('raw', start, i, 'verb'));
					}
				} else if (cmd.name === 'begin') {
					const env = environmentName(i, to);
					if (!env) {
						nodes.push(node('raw', start, i, 'begin'));
						continue;
					}
					let closing: { from: number; to: number } | null;
					if (literalEnvironments.has(env.name)) {
						const marker = '\\end{' + env.name + '}';
						const end = text.indexOf(marker, env.end);
						closing = end < 0 || end + marker.length > to ? null : { from: end, to: end + marker.length };
					} else closing = closeEnvironment(env.name, env.end, to);
					if (!closing) {
						issues.push(Object.freeze({ code: 'UNCLOSED', offset: start }));
						nodes.push(node('raw', start, to, env.name));
						i = to;
					} else {
						i = closing.to;
						const content = span(env.end, closing.from);
						if (containers.has(env.name))
							nodes.push(node('environment', start, i, env.name, content, parse(content.from, content.to, depth + 1)));
						else if (env.name === 'equation' || env.name === 'equation*') {
							nodes.push(node('math', start, i, env.name, content));
						} else nodes.push(node('raw', start, i, env.name, content));
					}
				} else {
					const starred = text[i] === '*';
					if (starred) i++;
					let argument = whitespace(i, to);
					// Unknown commands consume complete adjacent arguments, never guess their semantics.
					let content: SourceSpan | null = null;
					let malformed = false;
					while (text[argument] === '{' || text[argument] === '[') {
						tick();
						const bracket = text[argument] === '[';
						const end = balanced(argument, to, bracket ? '[' : '{', bracket ? ']' : '}');
						if (end === null) {
							malformed = true;
							break;
						}
						if (!bracket && content === null) content = span(argument + 1, end - 1);
						i = end;
						if (!bracket && (headings.has(cmd.name) || formatting.has(cmd.name))) break;
						argument = whitespace(i, to);
					}
					if (malformed) {
						issues.push(Object.freeze({ code: 'UNCLOSED', offset: start }));
						i = to;
						nodes.push(node('raw', start, i, cmd.name));
					} else if (content && headings.has(cmd.name))
						nodes.push(node('heading', start, i, cmd.name + (starred ? '*' : ''), content, parse(content.from, content.to, depth + 1)));
					else if (content && formatting.has(cmd.name) && !starred)
						nodes.push(node('format', start, i, cmd.name, content, parse(content.from, content.to, depth + 1)));
					else nodes.push(node('raw', start, i, cmd.name));
				}
			} else if (text[i] === '{') {
				const end = balanced(i, to);
				if (end === null) issues.push(Object.freeze({ code: 'UNCLOSED', offset: i }));
				i = end ?? to;
				nodes.push(node('raw', start, i, 'group'));
			} else if (text[i] === '}') {
				issues.push(Object.freeze({ code: 'MISMATCH', offset: i }));
				nodes.push(node('raw', i, ++i, 'unmatched-group'));
			} else {
				while (i < to && !['%', '$', '\\', '{', '}'].includes(text[i]!)) { tick(); i++; }
				nodes.push(node('text', start, i));
			}
		}
		return Object.freeze(nodes);
	};
	let nodes: readonly SyntaxNode[];
	try { nodes = parse(0, text.length, 0); }
	catch (error) {
		if (error !== exhausted) throw error;
		count = 0;
		issues.splice(0);
		issues.push(Object.freeze({ code: 'BUDGET', offset: 0 }));
		nodes = Object.freeze([node('raw', 0, text.length, 'parse-budget')]);
	}
	// Syntax-changing primitives make any projection unsafe. Preserve the whole source as Raw LaTeX.
	if (issues.some((issue) => issue.code === 'DYNAMIC_SYNTAX')) nodes = Object.freeze([node('raw', 0, text.length, 'dynamic-syntax')]);
	return Object.freeze({ documentId: document.documentId, version: document.version, nodes, issues: Object.freeze(issues) });
}

export { projectionIsCurrent } from './projection.ts';
