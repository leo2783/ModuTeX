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


The new workbench opens in Visual mode, with icons for Source mode and equation, matrix and table cells. Edit text and equations in the document, finish or cancel, insert above/below, move or delete cells with shared undo. The sidebar shows files above the outline. Compilation shows progress and success or failure; successful results automatically display the latest PDF. Closing unsaved documents offers Save, Discard or Cancel. See the [inline editing validation and limits](docs/architecture/FRONTEND_INLINE_ACCEPTANCE_2026-10-11.md).

## Features

Right-click files to open, compile to PDF or copy their relative path. Compilation failures automatically show details; the compilation status also provides a log toggle. See [failure handling and validation](docs/architecture/FRONTEND_COMPILE_ERRORS_2026-10-11.md).

- **Visual and source editing** — edit supported document structures visually, with direct access to LaTeX source for custom commands and layouts.
- **Equations and matrices** — use one math menu for inline equations and cells, with Greek letters, limits, calculus, common formulas, multiline functions, and editable matrix grids.
- **Code and color** — insert literal code cells and apply preset or custom colors to selected text.
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
npm run electron:dev:frontend
```

This opens the new workbench in Electron with the frontend development server on port 5174. To build and open the new workbench from local static files:

```powershell
npm run electron:frontend
```

The new workbench is under development and is not the published 0.1.0 package. `npm run electron:dev` opens the legacy editor on port 5173. Stop the current development process with `Ctrl+C` before switching launch modes. See [Frontend and Electron integration](docs/architecture/FRONTEND_ELECTRON_INTEGRATION.md) for validation details and limitations.

Frontend development, builds and tests first rebuild the shared document core and contracts. The unified math menu includes inline equations, matrix cells, Greek letters, limits, calculus and multiline templates; code cells and text colors share document undo. See [Math and content acceptance](docs/architecture/FRONTEND_MATH_PARITY_2026-10-11.md).

Build the legacy production app or run its verification suite:

```powershell
npm run app:build
npm run verify:modutex
```

The project uses Electron, Svelte, and TypeScript. Dependencies are pinned in `package-lock.json`.

## Documentation

- [Installation and compiler setup](docs/user/INSTALLATION.md)
- [Changelog](CHANGELOG.md)
- [Known limitations](docs/user/KNOWN_LIMITATIONS.md)
- [Licensing and third-party components](LICENSING.md)

Draw.io, Mermaid, visual section folding, and signed installers are outside the 0.1.0 feature scope. See the known limitations for current table behavior and platform constraints.

## License

ModuTeX is derived from Texpile and licensed under [AGPL-3.0-only](LICENSE). The original utilities explicitly listed in [LICENSING.md](LICENSING.md) use Apache-2.0. Third-party components retain their respective licenses and notices.
