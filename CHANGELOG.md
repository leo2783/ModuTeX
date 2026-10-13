# Changelog

## [0.2.0] — Unreleased

### Added

- Rebuilt Svelte document workspace with source, visual, and split editing modes sharing one lossless source model and undo history.
- Inline bold, italic, emphasis, and underline projection, including nested formatting and cross-format text replacement without rewriting TeX wrappers.
- Source section and environment folding, document outline navigation, and background parsing with recovery after worker failure.
- Editable generated tables with row and column controls, proportional widths, header rows, and optional captions; equation and matrix source insertion.
- Persistent appearance and source-editor preferences, plus an in-app version history.
- Opt-in built frontend loading in Electron, with narrow file/watch/compiler IPC and cancellation preserving the last successful PDF.

### Changed

- Load the source editor and PDF renderer only when needed.
- Serialize PDF canvas rendering and protect source transactions and file operations against stale results.

### Compatibility

- The frontend rewrite is in development. The Windows workbench main path has real browser and Electron acceptance; input-method, cross-platform, packaging, and full dependency-origin acceptance remain pending.
- The existing Electron host and legacy components retain their current licensing. This update does not relicense the complete application.

## [0.1.0] — 2026-10-06

### Added

- Document-focused desktop workspace with visual editing, LaTeX source editing, and PDF preview.
- Equation and matrix insertion in the visual editor.
- Table controls for rows, columns, column widths, and caption placement, with three-line, full-grid, and horizontal-rule presets.
- Bundled Managed Tectonic compiler with automatic resource downloads from a fixed source and a persistent local cache.
- English and Traditional Chinese interface options.
- Windows x64 desktop package launched through a local npm tarball.

### Fixed

- Missing `tabularx` declarations after editing supported tables: the required package is added to a safely editable preamble without duplicating existing declarations.
- Cached-only compilation failures when the Tectonic format or required resources are incomplete: the managed compiler can download missing resources automatically.

### Compatibility

- Requires Node.js 24.19.0 and npm 11.17.0.
- First compilation and uncached TeX resources require internet access.
- Draw.io, Mermaid, visual section folding, and signed installers are not included in this release scope.
- Additional limitations are documented in [Known limitations](docs/user/KNOWN_LIMITATIONS.md).
