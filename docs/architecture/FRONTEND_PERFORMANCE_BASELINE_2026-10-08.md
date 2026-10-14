# Frontend performance baseline

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

Command: `node --expose-gc apps/frontend/tests/performance/editor-benchmark.ts`.
Machine: Windows x64, Node.js 24.15.0, Ryzen 9 5900HX, 16 logical CPUs,
16,541,024,256 bytes RAM. This measures real library transactions in Node/JSDOM,
not Electron input latency. Targets remain provisional; no performance acceptance
is claimed.

## Fixed corpus

| Bytes | SHA-256 |
|---|---|
| 102400 | `10a2c096b222cb1b5686a363d44b4eb88a8c2f70c0dba4d2dbc6c75644a2e6c1` |
| 1048576 | `3634216e7aa9eb136543706fde906d5614fe730024ab8d455e2c9bd6281e4a0a` |
| 5242880 | `a59707505b3207a80e4888bad3fb503b221fd8299b545c1b7eb6a0c015188510` |

## Latest full baseline: separated presentation and source anchors

Run: 2026-10-07T17:13:12.162Z. Corpus hashes above and the original 100/50
visual iterations are unchanged. A preceding three-sample `--diagnostic` CPU
profile was for investigation only and is not this baseline.

| Corpus | Replacement / insertion / deletion p95 (ms) | Save (ms) |
|---|---|---|
| 100 KiB | 6.1478 / 5.1791 / 4.1911 | 0.0729 |
| 1 MiB | 53.4554 / 59.1389 / 52.1147 | 0.2592 |
| 5 MiB | Not exercised: parser budget Raw fallback | 0.9846 |

The length-changing CPU profile attributed about 4.213 seconds to ProseMirror
size calculation and 2.211 seconds to child-position lookup. Source coordinates
are now kept in the canonical projection, separate from its presentation snapshot;
only the actual text transaction reaches the view. Source-backed actions resolve
current anchors when invoked. The metadata Step described below was removed,
along with its newly added direct dependency; existing transitive dependencies remain.

Retained heap after disposal was about 3.06 / 0.718 / -0.020 MB; active heap about
112 / 438 / 115 MB. These are not peak-memory bounds or proof of no leaks.
Full frontend behavior tests: 248/248, zero skipped; strict check: zero errors or
warnings; production tests: 3/3. Native Electron latency and 5 MiB visual editing
remain unverified. Previous observations below are historical, not current gates.

## Two earlier measured runs

Before: 2026-10-07T16:13:53.475Z. After: 2026-10-07T16:17:15.509Z.
Change: reuse immutable UTF-16/source boundary maps when replacement geometry is
identical. Different escaped widths, line endings and insertions still remap.
Corpus and iteration counts were unchanged; timings also contain machine noise.

| Corpus | CM patch p95 before / after (ms) | Visual replacement p95 before / after (ms) | After save materialization (ms) |
|---|---|---|---|
| 100 KiB | 0.1811 / 0.1269 | 47.9792 / 24.0911 | 0.0420 |
| 1 MiB | 0.0760 / 0.0597 | 898.0445 / 630.8099 | 0.3331 |
| 5 MiB | 0.0783 / 0.0386 | Not exercised: parser budget Raw fallback | 1.2327 |

Actual source mutation and version increments were asserted. Both mapped visual
tiers had zero rejected edits. Workers were created, processed reset/patch/parse,
and explicitly terminated; termination returned 1, not a crash assertion.

## Reanchoring investigation

The native Node CPU profile (`.verification-artifacts/visual-20261008.cpuprofile`)
recorded about 22.26 seconds in the per-node reanchoring callback. Repeated
`nodeAt()` lookups scanned siblings from the beginning. A single traversal index
reduced 1 MiB replacement p95 to 182.20 ms; preserving unchanged immutable nodes
then measured 44.48 ms at 2026-10-07T16:40:44.616Z. These are replacements only.

Length-changing edits now have separate insertion/deletion measurements, using
the same fixed corpus and 100/50 iterations. Each pair restores document length;
version increments, actual visible insertion, zero rejected edits and final exact
source bytes are asserted. The old per-node attribute transactions exhausted the
default V8 heap at about 4 GiB. No memory limit was raised.

Derived coordinates now use one local, identity-bound ProseMirror Step with an
empty position map; it is not serialized, rebased or added to source history.
The actual text transaction remains unchanged. Source-block NodeViews also retain
their content DOM when only source coordinates change. Tests distinguish mounted
listeners from retired ones rather than requiring unnecessary destruction.

Latest completed run: 2026-10-07T16:52:29.284Z. A preceding slow benchmark competed
for CPU during part of this run before its verified process was terminated, so
these timings are not an isolated stable baseline.

| Corpus | Replacement / insertion / deletion p95 (ms) | Save (ms) |
|---|---|---|
| 100 KiB | 6.6033 / 28.7696 / 29.6943 | 0.0454 |
| 1 MiB | 65.2111 / 1346.6461 / 1374.8552 | 0.2620 |
| 5 MiB | Not exercised: parser budget Raw fallback | 0.9968 |

The completed run no longer exhausted the heap, but does not establish a peak
memory bound or prove absence of leaks. One-MiB insertion/deletion remains too slow.
Profile length-changing DOM and coordinate updates next; do not accept performance
using the better replacement-only numbers. Native Electron latency remains unmeasured.

## Earlier observations

1 MiB visual replacements still block far too long. Equal-width replacement is
not representative of insertion, deletion, IME or native layout. Profile the
remaining mapping, state reanchoring and DOM costs before setting acceptance gates.

After-disposal retained heap in the second run was about 80 MB / 396 MB / -465 MB
for the successive tiers. Later collection does not prove there is no leak;
fixed corpus buffers remain allocated. Repeat lifecycle measurement in Electron.

Real behavior regressions compare incremental maps with a fresh parser and verify
exact mixed-EOL/BOM bytes plus shared undo. Neither these tests nor the benchmark
prove the full desktop performance requirement.
