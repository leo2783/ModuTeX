# Licensing

## Application license

ModuTeX is derived from Texpile. The desktop application is licensed under **AGPL-3.0-only**; the full license text is in [LICENSE](LICENSE). Project files use this license unless an explicit license notice or the exceptions below state otherwise.

## Apache-2.0 exceptions

The following original utilities and frontend packages are licensed under **Apache-2.0**. The full license text is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

| File                                                                               | Description                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| [scripts/vendor/vendor-manifest.mjs](scripts/vendor/vendor-manifest.mjs)           | Vendor manifest schema and fixed-source validation |
| [scripts/vendor/vendor-manifest.test.mjs](scripts/vendor/vendor-manifest.test.mjs) | Tests for the manifest validator                   |
| [apps/frontend](apps/frontend/LICENSE) | Original frontend UI, image and editing functionality |
| [packages/document-core](packages/document-core/LICENSE) | Original source and projection core |
| [packages/frontend-contracts](packages/frontend-contracts/LICENSE) | Original platform contracts and validation |

These exceptions apply to the listed original code. Package exceptions cover original source, tests and build scripts, including the owner-authored matrix implementation. Third-party dependencies, generated third-party runtimes and imported license documents retain their original terms. See [frontend scope](docs/licensing/FRONTEND_APACHE_SCOPE_2026-10-12.md). They do not change the license of the desktop application, files outside the listed scopes or third-party components.

## Third-party components

Vendored components, dependencies, fonts, images, and other third-party assets retain their own licenses. Component license texts and attribution notices are included in their source directories and [vendor/notices](vendor/notices).

The application license and these file-specific exceptions do not replace third-party license requirements.
