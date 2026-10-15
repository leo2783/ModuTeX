# Changelog

## [0.2.1] — 2026-10-15

### Fixed

- Include file symlinks in frontend source-origin checks on Linux and reject directory aliases in file-only inputs.
- Separate cold offline npm extraction from application startup during packaged acceptance; preserve bounded deadlines, progress and failure diagnostics.

### Changed

- Restore missing source-audit tools and documentation while retaining the existing application directories.
- Document independent private-library versions and update Windows installer and local npx download instructions.

## [0.2.0] — 2026-10-14

### Added

- Rebuilt Svelte document workspace with source, visual, and split editing modes sharing one lossless source model and undo history.
- Inline bold, italic, emphasis, and underline projection, including nested formatting and cross-format text replacement without rewriting TeX wrappers.
- Source section and environment folding, document outline navigation, and background parsing with recovery after worker failure.
- Editable generated tables with row and column controls, proportional widths, header rows, and optional captions; equation and matrix source insertion.
- Persistent appearance and source-editor preferences, plus an in-app version history.
- Production frontend loading in Electron, with narrow file/watch/compiler IPC and cancellation preserving the last successful PDF.

- Windows installation wizard, local npx distribution and SHA-256 verification instructions.
- Graphical math templates, notebook cell dragging, code-language selection and PNG/JPEG clipboard images.

### Fixed

- Workspace startup resynchronization and batched filesystem events prevent stale source reads.
- Frontend regression gates now run on both CI platforms; launcher tests execute the real child process.
- Parser reset copies, CRLF projection lookup and repeated cell layout work are reduced; oversized code blocks avoid excessive highlighting work.

### Changed

- Load the source editor and PDF renderer only when needed.
- Serialize PDF canvas rendering and protect source transactions and file operations against stale results.

### Compatibility

- Windows x64 distribution includes an unsigned installer and a local npx tarball. Native IME variants and large-document responsiveness retain the limitations below.
- The existing Electron host and legacy components retain their current licensing. This update does not relicense the complete application.

## [0.2.0-dev.0] — 2026-10-13

### Added

- Windows x64 development package opens the new frontend without a Vite server, launched from a downloaded tarball with npx.
- Globe language menu, caret-preserving insertion and typesetting-only long body-text wrapping.
- PNG/JPEG clipboard images, save-as resources, source-safe editing and original frontend Apache-2.0 notices.

### Compatibility

- Development preview; the existing Electron desktop host remains AGPL-3.0-only. First uncached compilation can require internet access.
- Not an npm registry publication or a signed installer. Windows filesystem-watch regressions still have intermittent full-suite timing failures.

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
