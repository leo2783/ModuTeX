<p align="center">
  <img src="build/icons/128x128.png" alt="ModuTeX" width="80" height="80">
</p>

<h1 align="center">ModuTeX</h1>

<p align="center">Visual LaTeX editing with a built-in compiler.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-526B87?style=flat-square" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/Windows-x64-526B87?style=flat-square" alt="Windows x64">
  <img src="https://img.shields.io/badge/Node.js-24.19.0-4D7756?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.19.0">
  <img src="https://img.shields.io/badge/npm-11.17.0-AC5151?style=flat-square&amp;logo=npm&amp;logoColor=white" alt="npm 11.17.0">
  <a href="LICENSING.md"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-76638A?style=flat-square" alt="License: AGPL-3.0-only"></a>
</p>

ModuTeX brings document editing and PDF compilation into one desktop workspace. Switch between visual editing and LaTeX source, work with equations and tables, and preview the compiled document alongside your text.

## Features

- **Visual and source editing** — edit supported document structures visually, with direct access to LaTeX source for custom commands and layouts.
- **Equations and matrices** — insert mathematical content and edit matrices within the document.
- **Editable tables** — manage rows and columns, adjust column widths, choose caption placement, and apply common academic table styles.
- **Built-in PDF compilation** — use the bundled Tectonic engine without installing a separate TeX distribution. Missing resources are downloaded from a fixed source and cached locally.
- **English and Traditional Chinese** — switch the interface language in preferences.

## Getting started

The desktop build targets Windows x64 and uses the Node.js and npm versions shown above.

Download `modutex-desktop-0.1.0.tgz` from [GitHub Releases](https://github.com/leo2783/ModuTeX/releases), then run this command from the download folder:

```powershell
npx --offline --yes --ignore-scripts --package .\modutex-desktop-0.1.0.tgz -- modutex
```

This launches the desktop app. The npm `--offline` option applies to package resolution; Tectonic still needs internet access for the first compilation or when a document requires resources that are not cached.

Open a project folder, select a `.tex` document, and choose **Managed Tectonic** as the compiler. System TeX is also supported when a local toolchain is configured.

## Development

Run these commands from the repository root:

```powershell
npm ci
npm run electron:dev
```

Build the production app or run the verification suite:

```powershell
npm run app:build
npm run verify:modutex
```

The project uses Electron, Svelte, and TypeScript. Dependencies are pinned in `package-lock.json`.

## Documentation

- [Installation and compiler setup](docs/INSTALLATION.md)
- [Changelog](CHANGELOG.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [Licensing and third-party components](LICENSING.md)

Draw.io, Mermaid, visual section folding, and signed installers are outside the 0.1.0 feature scope. See the known limitations for current table behavior and platform constraints.

## License

ModuTeX is derived from Texpile and licensed under [AGPL-3.0-only](LICENSE). The original utilities explicitly listed in [LICENSING.md](LICENSING.md) use Apache-2.0. Third-party components retain their respective licenses and notices.
