# Offline retained-vendor verification

The no-argument production verifier validates `vendor/vendor-lock.json` before inspecting retained Draw.io and Tectonic installations. It does not download or extract an archive, alter vendor bytes, or use an archive cache.

```powershell
node scripts/verify-vendor.mjs
node --test scripts/tests/verify-vendor-retained.test.mjs
node --test scripts/vendor/vendor-manifest.test.mjs scripts/vendor/vendor-artifact.test.mjs scripts/vendor/tectonic-vendor.test.mjs
```

| Input    | Required evidence                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest | Reviewed versions, archive names, URLs, digests, licenses and exact notice paths                                                                      |
| Draw.io  | VERSION, exact nested license paths, static-webapp boundary, 3,378-file inventory, raw-byte tree SHA-256, fixture inventory and notice/license hashes |
| Tectonic | VERSION, exact two-file inventory, Windows x64 PE identity, executable size/hash and notice/license hashes from the accepted #19 validator            |

Regular directories/files are required; symbolic links and unexpected retained paths fail closed. Output distinguishes `source: retained-installation` byte verification from `archiveEvidence: reviewed-manifest` metadata. A retained check does not assert that a local archive was downloaded or verified in that invocation.

The existing explicit `--archive-dir`, `--cache-dir` and `--cache-dir --download` modes retain #40's original archive/provenance validation. An option such as `--artifact` without a verification directory remains invalid. `--download` is never implied by the default command.

Integration prerequisite: accepted #19 commits must supply `scripts/vendor/tectonic-vendor.mjs` and the retained executable before the default gate can pass. Root npm `verify:vendor` registration is a separate script-only change; no package lock or vendor manifest value change is required.
