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
const fragmentation = [];
for (const pieces of [1, 128, 1024, 8192]) {
  let document = SourceDocument.open(encoder.encode('a'.repeat(32768)));
  if (pieces > 1) document = document.apply({ expectedVersion: 0,
    patches: Array.from({ length: pieces / 2 }, (_, i) => ({ from: i * 4, to: i * 4, insert: 'b' })) }).document;
  assert.equal(document.pieceCount, pieces);
  const readings: Record<string, { p50Ms: number; p95Ms: number }> = {};
  for (const [name, width] of [['oneUnit', 1], ['hundredUnits', 100], ['wholeDocument', document.length], ['boundary', 0]] as const) {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const at = width === document.length ? 0 : (i * 7919) % (document.length - width + 1);
      const start = performance.now();
      const result = document.read(at, at + width);
      times.push(performance.now() - start); assert.equal(result.length, width);
    }
    const sorted = [...times].sort((a, b) => a - b);
    readings[name] = { p50Ms: round(sorted[9]!), p95Ms: round(sorted[18]!) };
  }
  fragmentation.push({ pieces, readings, samplesPerRead: 20 });
}
console.log(JSON.stringify({
  scope: 'Source buffer only; excludes renderer, parser workers and real GUI typing',
  machine: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  comparator: 'Full UTF-8 string serialization, not a measurement of the legacy application',
  gates: { sourceApplyP95Ms: p95GateMs },
  records, fragmentation
}, null, 2));
assert.ok(records.every(record => record.gatePassed), 'Source patch p95 exceeds the source-buffer budget');
