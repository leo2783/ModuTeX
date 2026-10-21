# Licensing

## Current Tauri application

The original code in the Tauri desktop host, frontend and shared packages is licensed under **Apache-2.0**. The host license is [apps/desktop-tauri/LICENSE](apps/desktop-tauri/LICENSE); each package includes its own LICENSE and NOTICE. Third-party components retain their own licenses.

## Apache-2.0 source scopes

The following scopes cover original source, tests and build scripts. The full license text is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

| File                                                                               | Description                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| [apps/desktop-tauri](apps/desktop-tauri/LICENSE) | Original Rust desktop host |
| [scripts/vendor/vendor-manifest.mjs](scripts/vendor/vendor-manifest.mjs)           | Vendor manifest schema and fixed-source validation |
| [scripts/tests/vendor/vendor-manifest.test.mjs](scripts/tests/vendor/vendor-manifest.test.mjs) | Tests for the manifest validator                   |
| [apps/frontend](apps/frontend/LICENSE) | Original frontend UI, image and editing functionality |
| [packages/document-core](packages/document-core/LICENSE) | Original source and projection core |
| [packages/frontend-contracts](packages/frontend-contracts/LICENSE) | Original platform contracts and validation |

The frontend scope includes the owner-authored matrix implementation. Source records are in [SOURCE_REVIEW](docs/licensing/SOURCE_REVIEW.md) and [tauri-origin.json](docs/licensing/tauri-origin.json).

## Historical application

The Electron host, legacy Texpile-derived frontend and previously released application retain **AGPL-3.0-only**. The repository [LICENSE](LICENSE) applies to historical code and files without a separate license notice; it does not replace the explicit Apache-2.0 licenses above.

## Third-party components

Vendored components, dependencies, fonts, images, and other third-party assets retain their own licenses. Component license texts and attribution notices are included in their source directories and [vendor/notices](vendor/notices).
