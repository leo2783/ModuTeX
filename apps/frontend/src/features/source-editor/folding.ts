import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { codeFolding, foldGutter, foldKeymap, foldService } from '@codemirror/language';
import { keymap, ViewPlugin } from '@codemirror/view';
import { projectionIsCurrent, SourceError, type SourceProjection, type SyntaxNode } from '@modutex/document-core';
import { sourceState } from './state.ts';

interface FoldRange { readonly line: number; readonly from: number; readonly to: number }
interface FoldIndex { readonly ranges: readonly FoldRange[] }
export const foldProjection = StateEffect.define<SourceProjection | null>();
/** Inverse coordinate mapping, including untouched CRLF; never read/normalize source text. */
function editorPosition(state: EditorState, sourcePosition: number): number {
	const projection = state.field(sourceState).projection;
	let low = 0, high = state.doc.length;
	while (low < high) { const middle = (low + high) >>> 1; if (projection.toSource(middle) < sourcePosition) low = middle + 1; else high = middle; }
	if (projection.toSource(low) !== sourcePosition) throw new Error('UNREPRESENTABLE_FOLD');
	return low;
}
function index(state: EditorState, parsed: SourceProjection): FoldIndex {
	const source = state.field(sourceState).projection.document;
	const byLine = new Map<number, FoldRange>();
	const add = (start: number, boundary: number, preserveBoundary: boolean) => {
		const line = state.doc.lineAt(editorPosition(state, start));
		const end = editorPosition(state, boundary);
		const to = preserveBoundary ? state.doc.lineAt(end).from - 1 : end;
		if (to <= line.to || state.doc.lineAt(to).number === line.number) return;
		const previous = byLine.get(line.from);
		if (!previous || previous.to < to) byLine.set(line.from, Object.freeze({ line: line.from, from: line.to, to }));
	};
	const body = parsed.nodes.find((node) => node.kind === 'environment' && node.name === 'document');
	const headings = (body?.children ?? parsed.nodes).filter((node) => node.kind === 'heading' && /^(?:section|subsection|subsubsection)\*?$/.test(node.name));
	const stack: { node: SyntaxNode; level: number }[] = [];
	const levels: Record<string, number> = { section: 0, subsection: 1, subsubsection: 2 };
	for (const node of headings) {
		const level = levels[node.name.replace(/\*$/, '')]!;
		while (stack.length && stack.at(-1)!.level >= level) add(stack.pop()!.node.span.from, node.span.from, true);
		stack.push({ node, level });
	}
	while (stack.length) add(stack.pop()!.node.span.from, body?.content?.to ?? source.length, Boolean(body?.content));
	const pending = [...parsed.nodes];
	while (pending.length) {
		const node = pending.pop()!;
		let environment = false;
		if (node.content) try { environment = source.read(node.span.from, Math.min(node.span.to, node.span.from + 6)) === '\\begin'; }
		catch (error) { if (!(error instanceof SourceError) || error.code !== 'RANGE') throw error; } // An unknown macro's prefix may cut a surrogate; it is not an environment.
		if (node.content && environment) {
			add(node.span.from, node.content.to, true);
		}
		for (const child of node.children) pending.push(child);
	}
	return Object.freeze({ ranges: Object.freeze([...byLine.values()].sort((a, b) => a.line - b.line)) });
}
/** Keep compact coordinates only, not a second source or the complete parser tree. */
export const foldIndex = StateField.define<FoldIndex | null>({
	create: () => null,
	update(previous, transaction) {
		let next = transaction.docChanged ? null : previous;
		for (const effect of transaction.effects) if (effect.is(foldProjection)) {
			if (effect.value === null) next = null;
			else if (projectionIsCurrent(transaction.state.field(sourceState).projection.document, effect.value)) next = index(transaction.state, effect.value);
		}
		return next;
	}
});
const service = foldService.of((state, lineStart) => {
	const ranges = state.field(foldIndex)?.ranges; if (!ranges) return null;
	let low = 0, high = ranges.length;
	while (low < high) { const middle = (low + high) >>> 1; if (ranges[middle]!.line < lineStart) low = middle + 1; else high = middle; }
	const range = ranges[low]; return range?.line === lineStart ? { from: range.from, to: range.to } : null;
});
export function sourceFolding(): Extension {
	const lifetime = ViewPlugin.define(() => ({ active: true, destroy() { this.active = false; } }));
	return [lifetime, foldIndex, service, keymap.of(foldKeymap), codeFolding({ placeholderDOM: (view, onclick) => {
		const button = document.createElement('button'); button.type = 'button'; button.className = 'cm-foldPlaceholder';
		button.textContent = '展開'; button.setAttribute('aria-label', '展開折疊內容');
		button.addEventListener('click', (event) => { if (view.plugin(lifetime)?.active && button.isConnected && view.dom.contains(button)) onclick(event); }); return button;
	} }), foldGutter({ foldingChanged: (update) => update.startState.field(foldIndex) !== update.state.field(foldIndex), markerDOM: (open) => {
		const marker = document.createElement('span'); marker.title = open ? '折疊區段' : '展開區段'; marker.setAttribute('aria-hidden', 'true');
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
		svg.append(path); marker.append(svg); return marker;
	} })];
}
