# Folding dependency evidence

The new source editor directly uses pinned `@codemirror/language` 6.12.3 public folding APIs. Its installed manifest and full LICENSE declare MIT, copyright 2018–2021 Marijn Haverbeke and others. No legacy application adapter was copied.

| Package | Version | Local evidence | Production SourceView source map |
| --- | --- | --- | --- |
| @codemirror/language | 6.12.3 | node_modules/@codemirror/language/package.json and LICENSE | Present |
| @lezer/common | 1.5.2 | node_modules/@lezer/common/package.json and LICENSE, MIT | Present |
| @lezer/highlight | 1.2.3 | node_modules/@lezer/highlight/package.json and LICENSE, MIT | Present |
| @lezer/lr | 1.4.10 | Existing lock dependency; installed LICENSE, MIT | Not present in this chunk's source map |

The workspace manifest and lock workspace entry add one dependency edge; existing package versions and integrity records were not changed. `verify:install-policy` passed with 8 manifests and 981 lock entries.

This is adoption evidence, not the complete frontend closure or shipping notices. Existing CodeMirror state/view and their dependencies remain part of the broader review. Full notice collection and independent provenance review are still required; root AGPL and new workspace UNLICENSED remain unchanged.
