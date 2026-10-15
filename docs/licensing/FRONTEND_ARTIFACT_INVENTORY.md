# Frontend artifact inventory

`scripts/licensing/frontend-artifacts.mjs` collects evidence from the existing production directory. It hashes every artifact, resolves file sources in V3 source maps, compares embedded content with current files, and collects the nearest package manifest and license/notice texts. It makes no license-clearance decision. Run from the repository root with Node.js 24.19.0 after building the frontend:

```powershell
node scripts/licensing/frontend-artifacts.mjs
node --test scripts/licensing/frontend-artifacts.test.mjs
```

The JSON output contains `artifacts`, `sources`, `packages`, and `unresolved`. Paths are repository-relative; source paths outside the repository and artifact symlinks are rejected. Missing files, transformed map references, stale embedded content, absent license documents, scripts without maps, and CSS/assets requiring origin review remain explicit. This is a trusted local-build audit tool, not an untrusted-source-map service or a complete build-graph verifier.

## Current evidence

The existing build contains 16 artifacts and 95 mapped source files across 15 third-party packages and three original workspaces. Third-party manifest declarations are MIT or Apache-2.0; the original workspaces remain UNLICENSED pending review. Full installed license texts and SHA-256 hashes are retained in the generated local report at `.verification-artifacts/frontend-origin/artifacts.json`. The three real-file tests cover exact text/hash collection, deterministic results, stale/missing sources, untraced worker/CSS reporting, and source traversal rejection.

| Evidence | Result | Remaining scope |
| --- | --- | --- |
| Installed PDF.js worker versus emitted `pdf.worker-CLesOks4.mjs` | Both SHA-256 `1a7607f28cfbc63f0e4e0a41927c89f991e353e4f3fb4565ecfd621ac5975089` | Package-internal third-party notices and worker closure |
| Worker `?url` source-map entry | Retained as unresolved transformed reference | Build transformation evidence; not an ordinary missing file |
| Generated CSS | Hashed, origin review required | Source CSS, font and asset closure |
| Three original workspaces | No module license files yet | Independent provenance review before Apache adoption |
| Help raw documents | Not implementation modules in source maps | Existing document inventory and redistribution review |

Source maps can omit transformed or generated inputs. Manifest license declarations and matching hashes establish identity, not legal independence or complete coverage. Review imports/aliases, build transformations, source assets, package-internal notices and the original-code inventory before generating final shipping notices. Root AGPL, Electron host, legacy applications and published 0.1.0 retain their existing boundaries.
