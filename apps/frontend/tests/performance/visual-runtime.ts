import { SourceDocument, parseSource } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourcePatchTransaction, sourceState } from '../../src/features/source-editor/state.ts';
import { TextSelection } from 'prosemirror-state';
declare global { interface Window { measure: typeof measure } }

const percentile = (values: number[], ratio: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1]!;
export async function measure(cells: number) {
	const original = SourceDocument.open(new TextEncoder().encode(
		'\\documentclass{article}\n\\begin{document}\n' + Array.from({ length: cells }, (_, i) => `\\par\nCell ${i} body\n`).join('') + '\\end{document}\n'));
	let editor = createSourceState(original);
	const host = document.createElement('div'); document.body.append(host);
	let rejects = 0, refreshCount = 0, refreshMs = 0;
	const view = new VisualEditor(host, 'benchmark.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => {
			editor = sourcePatchTransaction(editor, identity, patches).state;
			return editor.field(sourceState).projection.document;
		},
		history: () => false, readOnly: () => false, status: () => {}, rejected: () => rejects++
	});
	const refresh = view.refresh.bind(view);
	view.refresh = () => { const start = performance.now(); refresh(); refreshCount++; refreshMs += performance.now() - start; };
	const observer = new MutationObserver(() => {});
	const longTasks: number[] = [];
	const tasks = new PerformanceObserver(entries => { for (const entry of entries.getEntries()) longTasks.push(entry.duration); });
	tasks.observe({ type: 'longtask', buffered: false });
	try {
		view.sync(parseSource(original));
		let at = -1;
		view.view.state.doc.forEach((node, offset) => { if (at < 0 && node.type.name === 'source_block' && node.textContent.includes('Cell 0')) at = offset + 1; });
		if (at < 0) throw new Error('BENCHMARK_TEXT_CELL_MISSING');
		observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
		const typing: number[] = [], selection: number[] = [];
		let mutations = 0;
		refreshCount = 0; refreshMs = 0;
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => requestAnimationFrame(resolve));
			const selectAt = performance.now();
			view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, at + i)));
			selection.push(performance.now() - selectAt);
			const start = performance.now();
			view.view.dispatch(view.view.state.tr.insertText(i % 2 ? '雪' : 'x'));
			view.refresh();
			typing.push(performance.now() - start);
			mutations += observer.takeRecords().length;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
		const source = editor.field(sourceState).projection.document;
		if (rejects || source.version !== 20 || !source.read().includes('x雪'.repeat(10))) throw new Error('BENCHMARK_EDIT_FAILED');
		return { requestedCells: cells, renderedCells: view.view.state.doc.childCount, samples: 20,
			typingP50Ms: percentile(typing, .5), typingP95Ms: percentile(typing, .95),
			selectionP50Ms: percentile(selection, .5), selectionP95Ms: percentile(selection, .95),
			refreshCount, refreshMs, mutations, longTasks, sourceVersion: source.version };
	} finally { observer.disconnect(); tasks.disconnect(); view.dispose(); host.remove(); }
}
