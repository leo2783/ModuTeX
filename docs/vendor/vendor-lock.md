# Vendor artifact manifest

`vendor/vendor-lock.json` is the reviewed metadata source for the two vendor archives used by ModuTeX:

- Draw.io `31.1.8` source archive, licensed under `Apache-2.0`.
- Tectonic `0.17.0` Windows x64 release archive, licensed under `MIT`.

Each entry has a deterministic local archive filename, exact version, immutable GitHub HTTPS URL, lowercase SHA-256, SPDX license identifier, repository-relative notice path, and immutable release page used as provenance. Notice files are delivered by their owning vendor issues under `vendor/notices/`; the manifest cannot point outside that directory.

## Validation boundary

Run the focused schema tests with:

```powershell
node --test scripts/vendor/vendor-manifest.test.mjs
```

The validator rejects unknown fields, unexpected artifact identifiers, duplicate or traversing archive names, mutable URLs, malformed hashes, invalid license identifiers, and notice paths outside `vendor/notices/`.

Schema validity proves only that reviewed metadata has the expected shape and pinned values. It does not download an archive, hash bytes, verify an offline cache, extract content, or authorize packaging. Issue #40 owns byte-level verification against these hashes before any extraction or packaging step.

## Byte verification and offline cache

Verification is explicit and never extracts or packages content:

```powershell
node scripts/verify-vendor.mjs --archive-dir <archive-directory>
node scripts/verify-vendor.mjs --cache-dir <cache-directory> --download
node scripts/verify-vendor.mjs --cache-dir <cache-directory>
```

`--archive-dir` requires the exact archive filenames in the manifest and hashes their bytes. Supplying both `--archive-dir` and `--cache-dir` imports only successfully hashed archives into the cache. `--artifact <id>` limits that operation to one reviewed artifact.

`--cache-dir --download` reuses complete verified-cache entries and downloads only missing artifacts from their immutable manifest URLs. A partial or tampered cache fails without automatic replacement. The offline `--cache-dir` form requires provenance metadata matching the manifest and rehashes archive bytes on every run.

Successful output contains only the artifact identifier, version, archive filename, SHA-256, verification source, and official provenance URL. Errors identify the artifact and boundary without printing local absolute paths. A nonzero exit occurs on any mismatch before downstream extraction or packaging may start.

## Tectonic extraction gate

`install --archive` accepts only the exact Tectonic archive inside an Issue #40 verified cache. It validates the adjacent `<archive>.provenance.json` against the reviewed artifact, URL, version, hash, and provenance, then hashes the bytes again before ZIP inspection or extraction. A standalone archive without its verified-cache sidecar is rejected.

To prepare a cache from an acquired archive and install from it:

```powershell
node scripts/verify-vendor.mjs --archive-dir <archive-directory> --cache-dir <cache-directory> --artifact tectonic-windows-x64
node scripts/vendor/tectonic-vendor.mjs install --archive <cache-directory>/tectonic-0.17.0-x86_64-pc-windows-msvc.zip
```

## Evidence

On 2026-09-30, the exact Tectonic release URL above was fetched once (21,060,223 bytes). The Issue #40 archive-import path wrote its provenance sidecar, and a separate offline-cache verification accepted it. The archive SHA-256 was `f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f`.

The production installer then extracted the archive in a scratch resource root; the executable SHA-256, `99ffcfdbf1ebf8bdda9e791942e3d06aedb12463fddc33f07de6f5211c8bf08d`, matched the retained binary. The packaged-resource verifier also passed against `release/win-unpacked/resources`. The downloaded archive and generated sidecar remained in task temp and were not committed. Any version, URL, or hash change requires a new review; validators must never accept a changed digest automatically.
