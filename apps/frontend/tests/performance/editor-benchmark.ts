import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import {
	SourceDocument,
	parseSource,
	type SourceProjection
} from '../../src/features/document-core/core.ts';
import {
	createSourceState,
	sourceState,
	sourcePatchTransaction,
	historyTransaction
} from '../../src/features/source-editor/state.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import {
	ParserEngine,
	type ParserRequest,
	type ParserReply
} from '../../src/features/parser/engine.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (
		html?: string,
		options?: { url?: string; pretendToBeVisual?: boolean }
	) => {
		window: Window & typeof globalThis & { close(): void };
	};
};

export interface TimingStats {
	readonly iterations: number;
	readonly minMs: number;
	readonly maxMs: number;
	readonly meanMs: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly p99Ms: number;
}

export interface CorpusMetadata {
	readonly tier: '100KB' | '1MB' | '5MB';
	readonly targetBytes: number;
	readonly actualBytes: number;
	readonly sha256: string;
	readonly sectionCount: number;
}

export interface MemorySnapshot {
	readonly heapBeforeBytes: number;
	readonly heapActiveBytes: number;
	readonly heapAfterDisposalBytes: number;
	readonly heapDeltaBytes: number;
	readonly retainedAfterDisposalBytes: number;
	readonly arrayBuffersActiveBytes: number;
}

export interface TierBaselineRecord {
	readonly tier: '100KB' | '1MB' | '5MB';
	readonly bytes: number;
	readonly openMs: number;
	readonly codeMirrorPatchStats: TimingStats;
	readonly proseMirrorTypingStats: TimingStats | null;
	readonly proseMirrorInsertionStats: TimingStats | null;
	readonly proseMirrorDeletionStats: TimingStats | null;
	readonly proseMirrorStatus: 'mapped_typing_success' | 'raw_block_budget_fallback';
	readonly visualRejectedCount: number;
	readonly parserBudgetStatus: 'structured_ast' | 'raw_bounded_refusal';
	readonly parseMs: number;
	readonly parserNodeCount: number;
	readonly parserIssues: readonly string[];
	readonly engineOnlyResetMs: number;
	readonly engineOnlyParseMs: number;
	readonly workerOriginalSourceResetMs: number;
	readonly workerOriginalSourcePatchMs: number;
	readonly workerOriginalSourceParseMs: number;
	readonly workerDisposeMs: number;
	readonly workerExitCode: number;
	readonly projectVisualMs: number;
	readonly saveMaterializeMs: number;
	readonly saveBytesCount: number;
	readonly memory: MemorySnapshot;
}

export interface BenchmarkReport {
	readonly metadata: {
		readonly timestamp: string;
		readonly nodeVersion: string;
		readonly platform: string;
		readonly arch: string;
		readonly cpuModel: string;
		readonly logicalCpus: number;
		readonly totalMemoryBytes: number;
		readonly gcExposed: boolean;
		readonly benchmarkType: string;
		readonly mode: 'baseline' | 'diagnostic';
		readonly memoryNote: string;
	};
	readonly corpus: readonly CorpusMetadata[];
	readonly measuredBaselines: readonly TierBaselineRecord[];
	readonly provisionalTargetsForReview: {
		readonly description: string;
		readonly note: string;
		readonly provisionalTargets: Record<
			'100KB' | '1MB' | '5MB',
			{
				readonly codeMirrorPatchP95MsTarget: number;
				readonly saveMaterializeMsTarget: number;
				readonly parseMsTarget?: number;
			}
		>;
	};
}

function computeStats(samples: readonly number[]): TimingStats {
	if (samples.length === 0) {
		return { iterations: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const count = sorted.length;
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	const round = (v: number): number => Number(v.toFixed(4));
	const percentile = (pct: number): number =>
		sorted[Math.min(count - 1, Math.max(0, Math.ceil(count * pct) - 1))]!;

	return {
		iterations: count,
		minMs: round(sorted[0]!),
		maxMs: round(sorted[count - 1]!),
		meanMs: round(sum / count),
		p50Ms: round(percentile(0.5)),
		p95Ms: round(percentile(0.95)),
		p99Ms: round(percentile(0.99))
	};
}

function createSectionBlock(sectionIndex: number): Uint8Array {
	const text = `
\\section{Section ${sectionIndex}: Computational Scalability and Numerical Convergence}
This section evaluates the efficiency of incremental piece-table editing algorithms at scale ${sectionIndex}.
Preserving valid macro boundaries is strictly enforced throughout document lifetime.

\\subsection{Mathematical Invariants}
The steady-state dissipation satisfies the variational inequality:
\\[
\\int_{\\Omega} \\nabla u \\cdot \\nabla v \\, dx + \\sum_{k=1}^{3} \\lambda_k \\frac{\\partial u}{\\partial x_k} = \\langle f, v \\rangle
\\]
where the numerical approximation error is bounded by $\\|u - u_h\\| \\le C h^2$.

\\subsection{Empirical Measurements}
\\begin{table}[h]
\\centering
\\begin{tabular}{llr}
\\toprule
Iteration & Metric & Value \\\\
\\midrule
Batch-${sectionIndex} & Throughput & 85.${sectionIndex % 10} \\\\
Batch-${sectionIndex} & Overhead & 1.${sectionIndex % 5} \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\textbf{Verification}: Section ${sectionIndex} maintains structural invariants under mutation.
\\textit{Note}: All syntax blocks remain unsevered.
% Checkpoint marker for section ${sectionIndex}
`;
	return new TextEncoder().encode(text);
}

function createFixedCorpus(targetBytes: number): { bytes: Uint8Array; sectionCount: number } {
	const encoder = new TextEncoder();
	const preamble = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{booktabs}
\\title{ModuTeX Scalability Benchmark Corpus}
\\author{ModuTeX Test Suite}
\\begin{document}
\\maketitle
`;
	const postamble = `
\\section{Benchmark Summary}
Comprehensive scalability benchmark corpus concluding marker.
\\end{document}
`;

	const preambleBytes = encoder.encode(preamble);
	const postambleBytes = encoder.encode(postamble);

	const chunks: Uint8Array[] = [preambleBytes];
	let currentChunksBytes = preambleBytes.byteLength;
	let sectionIndex = 1;

	// Build whole blocks without cutting mid-macro/environment; track byte count incrementally
	while (true) {
		const blockBytes = createSectionBlock(sectionIndex);
		if (currentChunksBytes + blockBytes.byteLength + postambleBytes.byteLength + 4 <= targetBytes) {
			chunks.push(blockBytes);
			currentChunksBytes += blockBytes.byteLength;
			sectionIndex++;
		} else {
			break;
		}
	}

	// Exact deficit before adding postamble: pad with valid LaTeX comment
	const deficit = targetBytes - (currentChunksBytes + postambleBytes.byteLength);
	assert.ok(deficit >= 0, 'Corpus deficit must be non-negative');

	if (deficit > 0) {
		let padText: string;
		if (deficit === 1) {
			padText = '\n';
		} else if (deficit === 2) {
			padText = '%\n';
		} else {
			padText = '% ' + '='.repeat(deficit - 3) + '\n';
		}
		const padBytes = encoder.encode(padText);
		assert.equal(padBytes.byteLength, deficit, 'Padding comment byte calculation error');
		chunks.push(padBytes);
		currentChunksBytes += padBytes.byteLength;
	}

	chunks.push(postambleBytes);
	currentChunksBytes += postambleBytes.byteLength;
	assert.equal(currentChunksBytes, targetBytes, 'Total corpus byte count mismatch');

	const result = new Uint8Array(targetBytes);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	assert.equal(offset, targetBytes, 'Final offset must equal targetBytes exactly');

	return { bytes: result, sectionCount: sectionIndex - 1 };
}

function setupDOM(): {
	dom: { window: Window & typeof globalThis & { close(): void } };
	restore: () => void;
} {
	const dom = new JSDOM('<!DOCTYPE html><html><body><div id="visual-target"></div></body></html>', {
		url: 'https://modutex.benchmark.test',
		pretendToBeVisual: true
	});
	const win = dom.window;
	const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
	const domKeys = [
		'window',
		'document',
		'navigator',
		'location',
		'Node',
		'Element',
		'HTMLElement',
		'DocumentFragment',
		'Text',
		'Comment',
		'Event',
		'EventTarget',
		'CustomEvent',
		'MutationObserver'
	] as const;

	for (const key of domKeys) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		if (key in win) {
			Object.defineProperty(globalThis, key, {
				value: win[key as keyof typeof win],
				writable: true,
				configurable: true
			});
		}
	}

	previousDescriptors.set(
		'requestAnimationFrame',
		Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
	);
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		value: (cb: FrameRequestCallback) => setTimeout(cb, 0),
		writable: true,
		configurable: true
	});

	previousDescriptors.set(
		'cancelAnimationFrame',
		Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
	);
	Object.defineProperty(globalThis, 'cancelAnimationFrame', {
		value: (id: number) => clearTimeout(id),
		writable: true,
		configurable: true
	});

	return {
		dom,
		restore: () => {
			for (const [key, desc] of previousDescriptors) {
				try {
					if (desc === undefined) {
						Reflect.deleteProperty(globalThis, key);
					} else {
						Object.defineProperty(globalThis, key, desc);
					}
				} catch {
					// Ignore non-configurable globals
				}
			}
			previousDescriptors.clear();
			try {
				dom.window.close();
			} catch {
				// Ignore
			}
		}
	};
}

interface WorkerHandle {
	post(msg: ParserRequest, timeoutMs?: number): Promise<ParserReply>;
	terminate(): Promise<number>;
}

function spawnParserWorker(): Promise<WorkerHandle> {
	return new Promise((resolveReady, rejectReady) => {
		const worker = new Worker(new URL('../helpers/parser-worker.ts', import.meta.url));
		const pending = new Map<
			number,
			{ resolve: (val: ParserReply) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
		>();
		let terminated = false;
		let exitCode = 0;
		let readyFired = false;

		const cleanupPending = (err: Error) => {
			for (const [, { reject, timer }] of pending) {
				clearTimeout(timer);
				reject(err);
			}
			pending.clear();
		};

		worker.on('message', (msg: ParserReply) => {
			if (msg && typeof msg.seq === 'number' && pending.has(msg.seq)) {
				const { resolve, timer } = pending.get(msg.seq)!;
				clearTimeout(timer);
				pending.delete(msg.seq);
				resolve(msg);
			}
		});

		worker.on('error', (err) => {
			cleanupPending(err);
			if (!readyFired) {
				rejectReady(err);
			}
		});

		worker.on('exit', (code) => {
			exitCode = code;
			cleanupPending(new Error(`Worker exited prematurely with code ${code}`));
			if (!readyFired) {
				rejectReady(new Error(`Worker exited prematurely with code ${code}`));
			}
		});

		worker.once('online', () => {
			readyFired = true;
			resolveReady({
				post: (request: ParserRequest, timeoutMs = 15_000) => {
					if (terminated) return Promise.reject(new Error('Worker already terminated'));
					return new Promise<ParserReply>((resolve, reject) => {
						const timer = setTimeout(() => {
							pending.delete(request.seq);
							reject(
								new Error(`Worker request timed out after ${timeoutMs}ms (seq=${request.seq})`)
							);
						}, timeoutMs);
						pending.set(request.seq, { resolve, reject, timer });
						worker.postMessage(request);
					});
				},
				terminate: async () => {
					if (terminated) return exitCode;
					terminated = true;
					cleanupPending(new Error('Worker terminated'));
					const code = await worker.terminate();
					exitCode = code;
					return code;
				}
			});
		});
	});
}

interface TierScalarResult {
	readonly tier: '100KB' | '1MB' | '5MB';
	readonly bytes: number;
	readonly openMs: number;
	readonly codeMirrorPatchStats: TimingStats;
	readonly proseMirrorTypingStats: TimingStats | null;
	readonly proseMirrorInsertionStats: TimingStats | null;
	readonly proseMirrorDeletionStats: TimingStats | null;
	readonly proseMirrorStatus: 'mapped_typing_success' | 'raw_block_budget_fallback';
	readonly visualRejectedCount: number;
	readonly parserBudgetStatus: 'structured_ast' | 'raw_bounded_refusal';
	readonly parseMs: number;
	readonly parserNodeCount: number;
	readonly parserIssues: readonly string[];
	readonly engineOnlyResetMs: number;
	readonly engineOnlyParseMs: number;
	readonly workerOriginalSourceResetMs: number;
	readonly workerOriginalSourcePatchMs: number;
	readonly workerOriginalSourceParseMs: number;
	readonly workerDisposeMs: number;
	readonly workerExitCode: number;
	readonly projectVisualMs: number;
	readonly saveMaterializeMs: number;
	readonly saveBytesCount: number;
	readonly heapActiveBytes: number;
	readonly arrayBuffersActiveBytes: number;
}

/**
 * Isolated per-tier execution scope.
 * Allocates document, state, and visual editor, performs measurements,
 * cleans up via finally, and returns only scalar metadata.
 * GC is invoked outside this function to measure true non-retained heap.
 */
async function benchmarkTier(
	tier: '100KB' | '1MB' | '5MB',
	bytes: number,
	corpusBytes: Uint8Array,
	targetElem: HTMLElement,
	diagnostic: boolean
): Promise<TierScalarResult> {
	let visualEditor: VisualEditor | null = null;
	let workerHandle: WorkerHandle | null = null;

	try {
		// 1. Open SourceDocument
		const openT0 = performance.now();
		const sourceDoc = SourceDocument.open(corpusBytes);
		const openMs = Number((performance.now() - openT0).toFixed(4));

		// 2. Real CodeMirror transactions with fixed-length replacements (safe for 5MiB limit)
		const cmIterations = diagnostic ? 3 : tier === '100KB' ? 200 : tier === '1MB' ? 100 : 50;
		const patchTimings: number[] = [];
		let cmState = createSourceState(sourceDoc);
		const editPos = Math.max(0, Math.floor(sourceDoc.length / 2));
		let previousVersion = sourceDoc.version;

		for (let i = 0; i < cmIterations; i++) {
			const pos = editPos + (i % 20);
			const replacementChar = String.fromCharCode(65 + (i % 26)); // A-Z
			const t0 = performance.now();
			// Fixed-length replacement: 1 character replaced with 1 character preserves total bytes <= 5MiB
			const tr = cmState.update({
				changes: { from: pos, to: pos + 1, insert: replacementChar }
			});
			assert.ok(tr.docChanged, 'CodeMirror transaction must change document');
			cmState = tr.state;
			const patchElapsed = performance.now() - t0;
			patchTimings.push(patchElapsed);

			const currentDoc = cmState.field(sourceState).projection.document;
			assert.equal(
				currentDoc.version,
				previousVersion + 1,
				'SourceDocument version must increment on successful CodeMirror edit'
			);
			assert.equal(
				currentDoc.read(pos, pos + 1),
				replacementChar,
				'Authoritative SourceDocument must reflect updated replacement character'
			);
			previousVersion = currentDoc.version;
		}

		assert.equal(
			cmState.field(sourceState).projection.document.byteLength,
			bytes,
			'Document byte length must be preserved under fixed-length edits'
		);
		const codeMirrorPatchStats = computeStats(patchTimings);

		// 3. Parser execution on authoritative current CodeMirror document (after all CM edits)
		const currentCmDoc = cmState.field(sourceState).projection.document;
		const parseT0 = performance.now();
		const projection: SourceProjection = parseSource(currentCmDoc);
		const parseMs = Number((performance.now() - parseT0).toFixed(4));

		const budgetExhausted = projection.issues.some((issue) => issue.code === 'BUDGET');
		const parserBudgetStatus = budgetExhausted ? 'raw_bounded_refusal' : 'structured_ast';
		const parserIssues = projection.issues.map((i) => i.code);
		const parserNodeCount = projection.nodes.length;

		// 4. In-thread ParserEngine (labeled engine-only)
		const engine = new ParserEngine();
		const engineResetT0 = performance.now();
		const engineResetReply = engine.handle({
			kind: 'reset',
			seq: 1,
			documentId: currentCmDoc.documentId,
			version: currentCmDoc.version,
			bytes: new Uint8Array(currentCmDoc.toBytes())
		});
		const engineOnlyResetMs = Number((performance.now() - engineResetT0).toFixed(4));
		assert.equal(engineResetReply.kind, 'ack');

		const engineParseT0 = performance.now();
		const engineParseReply = engine.handle({
			kind: 'parse',
			seq: 2,
			documentId: currentCmDoc.documentId,
			version: currentCmDoc.version
		});
		const engineOnlyParseMs = Number((performance.now() - engineParseT0).toFixed(4));
		assert.equal(engineParseReply.kind, 'projection');

		// 5. True Worker thread lifecycle (independent workload on original source bytes)
		workerHandle = await spawnParserWorker();

		const workerResetT0 = performance.now();
		const workerResetReply = await workerHandle.post({
			kind: 'reset',
			seq: 10,
			documentId: sourceDoc.documentId,
			version: sourceDoc.version,
			bytes: new Uint8Array(sourceDoc.toBytes())
		});
		const workerOriginalSourceResetMs = Number((performance.now() - workerResetT0).toFixed(4));
		assert.equal(workerResetReply.kind, 'ack');

		const workerPatchT0 = performance.now();
		const workerPatchReply = await workerHandle.post({
			kind: 'patch',
			seq: 11,
			documentId: sourceDoc.documentId,
			expectedVersion: sourceDoc.version,
			version: sourceDoc.version + 1,
			patches: [{ from: 0, to: 1, insert: '%' }]
		});
		const workerOriginalSourcePatchMs = Number((performance.now() - workerPatchT0).toFixed(4));
		assert.equal(workerPatchReply.kind, 'ack');

		const workerParseT0 = performance.now();
		const workerParseReply = await workerHandle.post({
			kind: 'parse',
			seq: 12,
			documentId: sourceDoc.documentId,
			version: sourceDoc.version + 1
		});
		const workerOriginalSourceParseMs = Number((performance.now() - workerParseT0).toFixed(4));
		assert.equal(workerParseReply.kind, 'projection');

		const workerDisposeT0 = performance.now();
		const workerExitCode = await workerHandle.terminate();
		const workerDisposeMs = Number((performance.now() - workerDisposeT0).toFixed(4));
		workerHandle = null;

		// 6. Visual projection (mode switch) from current CodeMirror document projection
		const projectT0 = performance.now();
		const visualProj = projectVisual(currentCmDoc, projection);
		const projectVisualMs = Number((performance.now() - projectT0).toFixed(4));

		// 7. True ProseMirror mapped typing using shared CM sourcePatchTransaction and historyTransaction
		let visualRejectedCount = 0;
		visualEditor = new VisualEditor(targetElem, `Benchmark-${tier}`, {
			source: () => cmState.field(sourceState).projection.document,
			apply: (identity, patches) => {
				const tr = sourcePatchTransaction(cmState, identity, patches);
				cmState = tr.state;
				return cmState.field(sourceState).projection.document;
			},
			applyValidated: (identity, patches, validateNextSource) => {
				const tr = sourcePatchTransaction(cmState, identity, patches);
				validateNextSource(tr.state.field(sourceState).projection.document);
				cmState = tr.state;
				return cmState.field(sourceState).projection.document;
			},
			history: (direction) => {
				const tr = historyTransaction(cmState, direction);
				if (tr) {
					cmState = tr.state;
					return true;
				}
				return false;
			},
			readOnly: () => false,
			rejected: () => {
				visualRejectedCount++;
			},
			status: () => {}
		});

		visualEditor.sync(projection);

		let typingStats: TimingStats | null = null;
		let insertionStats: TimingStats | null = null;
		let deletionStats: TimingStats | null = null;
		let proseMirrorStatus: 'mapped_typing_success' | 'raw_block_budget_fallback' =
			'raw_block_budget_fallback';

		// Target actual text within source_block children (not raw_block atom)
		if (!budgetExhausted && visualProj.document.content.size > 0) {
			let targetSourceBlockPos = -1;
			visualEditor.view.state.doc.forEach((node, offset) => {
				if (targetSourceBlockPos < 0 && node.type.name === 'source_block' && node.childCount > 0) {
					let childOffset = 0;
					for (let i = 0; i < node.childCount; i++) {
						const child = node.child(i);
						if (child.isText && (child.text?.length ?? 0) > 20) {
							targetSourceBlockPos = offset + 1 + childOffset;
							break;
						}
						childOffset += child.nodeSize;
					}
				}
			});

			if (targetSourceBlockPos >= 0) {
				const pmIterations = diagnostic ? 3 : tier === '100KB' ? 100 : tier === '1MB' ? 50 : 20;
				const pmTimings: number[] = [];

				for (let i = 0; i < pmIterations; i++) {
					const charPos = targetSourceBlockPos + (i % 12);
					const currentChar: string = visualEditor.view.state.doc.textBetween(charPos, charPos + 1);
					// Alternate replacement character to ensure every iteration causes real content mutation
					const replacementChar: string = currentChar === 'X' ? 'Y' : 'X';
					const beforeVersion = cmState.field(sourceState).projection.document.version;

					const t0 = performance.now();
					const tr = visualEditor.view.state.tr.insertText(replacementChar, charPos, charPos + 1);
					assert.ok(tr.docChanged, 'ProseMirror transaction must change document');
					visualEditor.view.dispatch(tr);
					const elapsed = performance.now() - t0;
					pmTimings.push(elapsed);

					assert.equal(
						visualRejectedCount,
						0,
						'VisualEditor rejected callback must not trigger during mapped typing'
					);
					const postEditCmDoc = cmState.field(sourceState).projection.document;
					assert.equal(
						postEditCmDoc.version,
						beforeVersion + 1,
						`Authoritative CM document version must increment on PM edit ${i}`
					);
					assert.equal(
						visualEditor.view.state.doc.textBetween(charPos, charPos + 1),
						replacementChar,
						'ProseMirror view must reflect exact replacement character'
					);
				}

				typingStats = computeStats(pmTimings);
				// Length-changing edits exercise reanchoring; fixed-width replacements
				// alone cannot represent actual typing or deletion. Restore the corpus
				// after each pair so the tier's byte budget remains unchanged.
				const beforePairs = cmState.field(sourceState).projection.document.toBytes();
				const insertionTimings: number[] = [], deletionTimings: number[] = [];
				for (let index = 0; index < pmIterations; index++) {
					const position = targetSourceBlockPos + (index % 12);
					const before = cmState.field(sourceState).projection.document;
					let started = performance.now();
					visualEditor.view.dispatch(visualEditor.view.state.tr.insertText('Z', position, position));
					insertionTimings.push(performance.now() - started);
					const inserted = cmState.field(sourceState).projection.document;
					assert.equal(visualRejectedCount, 0);
					assert.equal(inserted.version, before.version + 1);
					assert.equal(inserted.length, before.length + 1);
					assert.equal(visualEditor.view.state.doc.textBetween(position, position + 1), 'Z');
					started = performance.now();
					visualEditor.view.dispatch(visualEditor.view.state.tr.delete(position, position + 1));
					deletionTimings.push(performance.now() - started);
					const deleted = cmState.field(sourceState).projection.document;
					assert.equal(visualRejectedCount, 0);
					assert.equal(deleted.version, inserted.version + 1);
					assert.equal(deleted.length, before.length);
				}
				assert.deepEqual(cmState.field(sourceState).projection.document.toBytes(), beforePairs);
				insertionStats = computeStats(insertionTimings);
				deletionStats = computeStats(deletionTimings);
				proseMirrorStatus = 'mapped_typing_success';
			}
		}

		visualEditor.dispose();
		visualEditor = null;

		// 8. Save materialization of authoritative current edited document
		const authoritativeCurrentDoc = cmState.field(sourceState).projection.document;
		const saveT0 = performance.now();
		const savedBytes = authoritativeCurrentDoc.toBytes();
		const saveMaterializeMs = Number((performance.now() - saveT0).toFixed(4));
		const saveBytesCount = savedBytes.byteLength;
		assert.equal(saveBytesCount, bytes, 'Saved byte count must match corpus tier size');
		assert.ok(
			authoritativeCurrentDoc.version > sourceDoc.version,
			'Authoritative saved document must contain all CodeMirror and ProseMirror edits'
		);

		const memActive = process.memoryUsage();

		return {
			tier,
			bytes,
			openMs,
			codeMirrorPatchStats,
			proseMirrorTypingStats: typingStats,
			proseMirrorInsertionStats: insertionStats,
			proseMirrorDeletionStats: deletionStats,
			proseMirrorStatus,
			visualRejectedCount,
			parserBudgetStatus,
			parseMs,
			parserNodeCount,
			parserIssues,
			engineOnlyResetMs,
			engineOnlyParseMs,
			workerOriginalSourceResetMs,
			workerOriginalSourcePatchMs,
			workerOriginalSourceParseMs,
			workerDisposeMs,
			workerExitCode,
			projectVisualMs,
			saveMaterializeMs,
			saveBytesCount,
			heapActiveBytes: memActive.heapUsed,
			arrayBuffersActiveBytes: memActive.arrayBuffers
		};
	} finally {
		const cleanupErrors: unknown[] = [];
		if (visualEditor) {
			try {
				visualEditor.dispose();
			} catch (error) {
				cleanupErrors.push(error);
			}
			visualEditor = null;
		}
		if (workerHandle) {
			try {
				await workerHandle.terminate();
			} catch (error) {
				cleanupErrors.push(error);
			}
			workerHandle = null;
		}
		if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Benchmark cleanup failed');
	}
}

async function runBenchmark(): Promise<BenchmarkReport> {
	const diagnostic = process.argv.includes('--diagnostic');
	const tiers: Array<{ tier: '100KB' | '1MB' | '5MB'; bytes: number }> = [
		{ tier: '100KB', bytes: 100 * 1024 },
		{ tier: '1MB', bytes: 1024 * 1024 },
		{ tier: '5MB', bytes: 5 * 1024 * 1024 }
	];

	const corpusMetadata: CorpusMetadata[] = [];
	const corpusData = new Map<'100KB' | '1MB' | '5MB', Uint8Array>();
	let totalCorpusBytes = 0;

	for (const { tier, bytes } of tiers) {
		const { bytes: raw, sectionCount } = createFixedCorpus(bytes);
		assert.equal(raw.byteLength, bytes, `Corpus ${tier} size mismatch`);
		const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
		corpusMetadata.push({
			tier,
			targetBytes: bytes,
			actualBytes: raw.byteLength,
			sha256,
			sectionCount
		});
		corpusData.set(tier, raw);
		totalCorpusBytes += raw.byteLength;
	}

	const gcExposed = typeof global.gc === 'function';
	const domContext = setupDOM();
	const measuredBaselines: TierBaselineRecord[] = [];

	try {
		const targetElem = domContext.dom.window.document.getElementById('visual-target')!;

		for (const { tier, bytes } of tiers) {
			const corpusBytes = corpusData.get(tier)!;

			if (gcExposed && global.gc) global.gc();
			const heapBeforeBytes = process.memoryUsage().heapUsed;

			// Call isolated per-tier function scope
			const scalarResult = await benchmarkTier(tier, bytes, corpusBytes, targetElem, diagnostic);

			// GC runs AFTER per-tier function frame has unwound, measuring real non-retained heap
			if (gcExposed && global.gc) global.gc();
			const heapAfterBytes = process.memoryUsage().heapUsed;

			const memory: MemorySnapshot = {
				heapBeforeBytes,
				heapActiveBytes: scalarResult.heapActiveBytes,
				heapAfterDisposalBytes: heapAfterBytes,
				heapDeltaBytes: scalarResult.heapActiveBytes - heapBeforeBytes,
				retainedAfterDisposalBytes: heapAfterBytes - heapBeforeBytes,
				arrayBuffersActiveBytes: scalarResult.arrayBuffersActiveBytes
			};

			measuredBaselines.push({
				tier: scalarResult.tier,
				bytes: scalarResult.bytes,
				openMs: scalarResult.openMs,
				codeMirrorPatchStats: scalarResult.codeMirrorPatchStats,
				proseMirrorTypingStats: scalarResult.proseMirrorTypingStats,
				proseMirrorInsertionStats: scalarResult.proseMirrorInsertionStats,
				proseMirrorDeletionStats: scalarResult.proseMirrorDeletionStats,
				proseMirrorStatus: scalarResult.proseMirrorStatus,
				visualRejectedCount: scalarResult.visualRejectedCount,
				parserBudgetStatus: scalarResult.parserBudgetStatus,
				parseMs: scalarResult.parseMs,
				parserNodeCount: scalarResult.parserNodeCount,
				parserIssues: scalarResult.parserIssues,
				engineOnlyResetMs: scalarResult.engineOnlyResetMs,
				engineOnlyParseMs: scalarResult.engineOnlyParseMs,
				workerOriginalSourceResetMs: scalarResult.workerOriginalSourceResetMs,
				workerOriginalSourcePatchMs: scalarResult.workerOriginalSourcePatchMs,
				workerOriginalSourceParseMs: scalarResult.workerOriginalSourceParseMs,
				workerDisposeMs: scalarResult.workerDisposeMs,
				workerExitCode: scalarResult.workerExitCode,
				projectVisualMs: scalarResult.projectVisualMs,
				saveMaterializeMs: scalarResult.saveMaterializeMs,
				saveBytesCount: scalarResult.saveBytesCount,
				memory
			});
		}
	} finally {
		domContext.restore();
	}

	const cpus = os.cpus();
	const report: BenchmarkReport = {
		metadata: {
			timestamp: new Date().toISOString(),
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			cpuModel: cpus[0]?.model ?? 'unknown',
			logicalCpus: cpus.length,
			totalMemoryBytes: os.totalmem(),
			gcExposed,
			benchmarkType: 'Node.js / JSDOM Editor Runtime Benchmark (not native GUI latency)',
			mode: diagnostic ? 'diagnostic' : 'baseline',
			memoryNote: `Corpus data buffers (totaling ${totalCorpusBytes} bytes across 100KB, 1MB, 5MB) are retained in-memory as fixed benchmark inputs; heap measurements record active allocations and post-disposal retention without claiming zero heap.`
		},
		corpus: corpusMetadata,
		measuredBaselines,
		provisionalTargetsForReview: {
			description:
				'Provisional non-gating target thresholds for Root audit and review. Measures Node.js/JSDOM API execution, not native GUI latency.',
			note: 'No claimed gates until real root run. Thresholds are unapproved provisional targets for review only; actual gates will be established by root after baseline evaluation.',
			provisionalTargets: {
				'100KB': {
					codeMirrorPatchP95MsTarget: 8.0,
					saveMaterializeMsTarget: 20.0,
					parseMsTarget: 150.0
				},
				'1MB': {
					codeMirrorPatchP95MsTarget: 20.0,
					saveMaterializeMsTarget: 60.0
				},
				'5MB': {
					codeMirrorPatchP95MsTarget: 40.0,
					saveMaterializeMsTarget: 180.0
				}
			}
		}
	};

	return report;
}

const report = await runBenchmark();
console.log(JSON.stringify(report, null, 2));
