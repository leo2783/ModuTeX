# Known limitations

## Editing

- Draw.io editing is experimental. Saving while diagram text is still being edited may omit the latest text changes.
- The dashed horizontal-rule table style has a known issue with first-row header formatting.
- Mermaid editing and visual section folding are unavailable. Section folding is supported in source mode.

## Compilation

Managed Tectonic requires internet access when generating its initial format or downloading uncached TeX resources. Cached resources are reused locally; adding a package can require another download.

Documents that depend on a custom TeX installation or command may require the System TeX compiler instead.

## Integration and platform

MCP integration is experimental. It is disabled by default.

The packaged desktop build targets Windows x64.
