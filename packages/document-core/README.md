# Document core

Lossless UTF-8 source storage and LaTeX projections for the ModuTeX frontend.
`SourceDocument` owns its input bytes, preserves BOM and line endings, and applies
version-checked atomic patches. Parser nodes retain source spans; editor
projections map edits back to the source rather than regenerating the document.

This package does not read files, compile TeX, or implement an editor UI.

## Development

Run from the repository root with Node.js 24.19.0 and npm 11.17.0:

```sh
npm run build --workspace=@modutex/document-core
npm run check --workspace=@modutex/document-core
npm run test --workspace=@modutex/document-core
```

Tests exercise byte preservation, invalid UTF-8, stale versions, atomic edits,
source-span remapping, parsing limits, and editor/source conversions.

## License

Private workspace package. Its license remains `UNLICENSED` pending provenance
review; this is not a declaration that the desktop application is Apache-2.0.
