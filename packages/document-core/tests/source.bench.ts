import assert from 'node:assert/strict';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SourceDocument } from '../src/index.ts';

const iterations = 1000;
const referenceIterations = 200;
const p95GateMs = 8;
const encoder = new TextEncoder();
const sample = '% original benchmark fixture\n\\unknown{raw}\n';
const percentile = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
const round = (value: number) => Number(value.toFixed(4));
const memory = () => { global.gc?.(); const m = process.memoryUsage(); return { heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers }; };
const records = [];
for (const size of [100 * 1024, 1024 * 1024, 5 * 1024 * 1024]) {
  const text = sample.repeat(Math.ceil(size / sample.length)).slice(0, size);
  const original = encoder.encode(text);
  const before = memory();
  const openedAt = performance.now();
  let document = SourceDocument.open(original);
  const openMs = performance.now() - openedAt;
  const timings = [];
  const at = Math.floor(document.length / 2);
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    document = document.apply({
      expectedVersion: document.version,
      patches: [{ from: at + i, to: at + i, insert: 'x' }]
    }).document;
    timings.push(performance.now() - started);
  }
  const serializedAt = performance.now();
  const saved = document.toBytes();
  const serializeMs = performance.now() - serializedAt;
  const expected = encoder.encode(text.slice(0, at) + 'x'.repeat(iterations) + text.slice(at));
  assert.deepEqual(saved, expected);
  const afterEdits = memory();
  const baseline = [];
  let comparatorText = text;
  for (let i = 0; i < referenceIterations; i++) {
    const started = performance.now();
    comparatorText = comparatorText.slice(0, at + i) + 'x' + comparatorText.slice(at + i);
    encoder.encode(comparatorText);
    baseline.push(performance.now() - started);
  }
  const p95 = percentile(timings);
  records.push({
    bytes: size, iterations, pieceCount: document.pieceCount,
    openMs: round(openMs), applyP95Ms: round(p95), serializeMs: round(serializeMs),
    fullSerializationComparatorP95Ms: round(percentile(baseline)),
    memoryDelta: { heapBytes: afterEdits.heapUsed - before.heapUsed, arrayBufferBytes: afterEdits.arrayBuffers - before.arrayBuffers },
    gatePassed: p95 < p95GateMs
  });
}
console.log(JSON.stringify({
  scope: 'Source buffer only; excludes renderer, parser workers and real GUI typing',
  machine: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  comparator: 'Full UTF-8 string serialization, not a measurement of the legacy application',
  gates: { sourceApplyP95Ms: p95GateMs },
  records
}, null, 2));
assert.ok(records.every(record => record.gatePassed), 'Source patch p95 exceeds the source-buffer budget');
