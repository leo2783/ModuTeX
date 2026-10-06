# Changelog

## [0.1.0] — Unreleased

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
- Additional limitations are documented in [Known limitations](docs/KNOWN_LIMITATIONS.md).
