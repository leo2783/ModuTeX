# Repository reconciliation

Original frontend commits `93140c8` and `aac20e6` are included in release `v0.2.0`. The separate uncommitted migration was preserved as snapshot `78050c842fb30523780ae7ccd36f6551a4e9e9b8` and compared by Git blob.

## Accepted decision

The owner chose to **retain main's directory layout and integrate missing tools/documents only**. The `editor-legacy`/`site-legacy` rename proposal is closed, not deferred. Runtime paths, workspace discovery, dependency versions/integrity metadata and published 0.2.0 assets stay unchanged.

| Snapshot content | Resolution |
|---|---|
| 1,189 moved files identical to main after path mapping | Keep canonical main files; no duplicate copies. |
| 15 moved files differing from main | Keep later main fixes; reject older path/dependency/test assumptions. |
| 20 modified tracked files | Rename changes superseded by accepted layout; preserve production renderer and release/security fixes. Restore missing origin-tool commands separately. |
| Missing source/license tools and OFL text | Restore and verify real filesystem/asset tests. Tools collect evidence, without independent license clearance. |
| Missing architecture/design/source records and benchmark | Restore unique material, refresh current indexes/status, label historical records. |
| Local tool configuration | Preserve locally; exclude from application/source release. |
| Generated PDF test fixtures/output | Exclude from source integration; regenerate with current tests. |
| Generated comparison/oracles tied to obsolete line ranges | Preserve a labelled historical HTML document; exclude obsolete generators/oracles from active tooling. |
| Internal worker handoff/session logs | Preserve as local recovery evidence, rather than publishing stale collaboration notes as current architecture. |

Integration uses a `fix/` branch and a PR created in the owner's browser. No direct push to dev/main, tag rewrite or published asset replacement.

## Versions

Desktop product and active frontend are **0.2.0**. Private libraries `@modutex/document-core` and `@modutex/frontend-contracts` have independent **0.1.0** versions. `scripts/set-version.mjs` synchronizes the product/active frontend only. npm banners display the package being built.

[Repository layout](REPOSITORY_LAYOUT.md) · [Development](../user/DEVELOPMENT.md)
