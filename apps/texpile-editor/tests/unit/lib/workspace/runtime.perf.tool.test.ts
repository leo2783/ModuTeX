// Opt-in diagnostic: real DocumentBuffer hot path, not a timing-based CI gate.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { DocumentBuffer } from '$lib/workspace/documentBuffer.svelte';
import { schema } from '$lib/schema/schema';
import { serializeLatexFile } from '$lib/workspace/latexRoundtrip';

const enabled = process.env.MODUTEX_RUNTIME_BENCH === '1';
const meta = { preamble: '\\documentclass{article}\n\\begin{document}', postamble: '\\end{document}\n', hadDocumentEnv: true };
const paragraphText = 'Measured prose with unchanged neighbouring blocks. '.repeat(40);
function prose(bytes: number, oneBlock = false): PMNode {
	const text = oneBlock ? 'x'.repeat(bytes) : paragraphText;
	const count = oneBlock ? 1 : Math.ceil(bytes / text.length);
	return schema.nodes.doc.create(
		null,
		Array.from({ length: count }, () => schema.nodes.paragraph.create(null, schema.text(text)))
	);
}
function table(): PMNode {
	const rows = Array.from({ length: 100 }, () =>
		schema.nodes.table_row.create(
			null,
			Array.from({ length: 10 }, () =>
				schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text('Table cell text '.repeat(6))))
			)
		)
	);
	return schema.nodes.doc.create(null, schema.nodes.table.create(null, rows));
}
function percentile(values: number[], fraction: number): number {
	return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}
describe.skipIf(!enabled)('bounded production visual edit measurements', () => {
	it('reports full onVisualChange p50/p95 for large, long-block and table documents', () => {
		expect(process.versions.node).toBe('24.19.0');
		console.log(JSON.stringify({ benchmark: 'runtime', node: process.versions.node, platform: process.platform }));
		for (const [name, initial] of [
			['prose-1MiB', prose(1024 * 1024)],
			['prose-5MiB', prose(5 * 1024 * 1024)],
			['prose-10MiB', prose(10 * 1024 * 1024)],
			['paragraph-1MiB', prose(1024 * 1024, true)],
			['table-100x10', table()]
		] as const) {
			let saved = '';
			const buffer = new DocumentBuffer({
				scheduleSave: (_path, content) => {
					saved = content;
				},
				discardQueuedSave() {},
				writeNow() {},
				rebuildVisual() {},
				isVisualMode: () => true,
				clearPendingAnchor() {}
			});
			const baseline = serializeLatexFile(meta, initial);
			buffer.openTex('/benchmark/main.tex', baseline, '\n');
			buffer.adoptParsed({ ...meta, doc: initial, warnings: [] });
			let state = EditorState.create({ doc: initial });
			let edit = -1;
			state.doc.descendants((node, pos) => {
				if (edit < 0 && node.isText && (name.startsWith('table') || pos > state.doc.content.size / 2)) edit = pos + 1;
				return edit < 0;
			});
			if (edit < 0) edit = 1; // a single long paragraph has its text at position 1
			const samples: number[] = [];
			for (let iteration = 0; iteration < 25; iteration++) {
				state = state.apply(state.tr.insertText('x', edit));
				const start = performance.now();
				buffer.onVisualChange(state.doc);
				const elapsed = performance.now() - start;
				if (iteration >= 5) samples.push(elapsed);
			}
			expect(saved).toBe(buffer.texSource);
			expect(saved).toBe(serializeLatexFile(meta, state.doc));
			expect(saved).not.toBe(baseline);
			console.log(
				JSON.stringify({
					benchmark: 'DocumentBuffer.onVisualChange',
					name,
					bytes: Buffer.byteLength(baseline),
					blocks: initial.childCount,
					samples: samples.length,
					samplesMs: samples,
					p50Ms: percentile(samples, 0.5),
					p95Ms: percentile(samples, 0.95),
					maxMs: Math.max(...samples),
					fixture: 'real schema nodes; serialization/save scheduling included; parser, browser layout and disk I/O excluded'
				})
			);
			buffer.close();
		}
	}, 120_000);
});
