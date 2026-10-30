<p align="center"><img src="apps/desktop-tauri/icons/icon.png" alt="ModuTeX" width="64" height="64"></p>
<h1 align="center">ModuTeX</h1>
<p align="center">Visual LaTeX editing with a built-in compiler.</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a></p>

ModuTeX 0.3.0 is an open-source LaTeX editor for Windows x64, built with Tauri 2 and Svelte.
Switch the editor between visual drafting and LaTeX source while keeping the compiled PDF in view on the right.

Your document stays in a plain-text `.tex` file. Use visual mode to write text, equations, and tables, then click **Compile PDF** to build with the bundled Tectonic engine.
Visual mode is a working draft; check the PDF for final fonts, spacing, and page breaks. The first compilation may need to download TeX resources.

![Visual editing and compiled PDF side by side](docs/images/workbench-en.png)

## Screenshots

Switch to LaTeX source while keeping the PDF in view.

![LaTeX source editor and PDF preview](docs/images/source-editor-en.png)

Choose the main document and compiler profile, and set whether the document title includes a date.

![Workspace compile settings](docs/images/compile-settings-en.png)

## Features

- **Two editing modes:** Switch between visual drafting and LaTeX source, with a shared undo/redo history.
- **Notebook cells:** Organize text and headings into cells that you can insert, move, and edit.
- **Equations, tables, and code:** Build formulas and matrices from templates, edit table rows and columns, and insert code blocks or images.
- **Local compilation:** Click **Compile PDF** to run the bundled Tectonic engine. Missing TeX resources may require an internet connection.
- **PDF preview and diagnostics:** Review the compiled output beside the editor. Failed builds show diagnostics and retain the last successful PDF.
- **Templates, dates, and language:** Save a template as `.tex`, choose a title-date format, and use the interface in English or Traditional Chinese.

## Usage

ModuTeX 0.3.0 targets **Windows x64**.
Downloads are published on [GitHub Releases](https://github.com/leo2783/ModuTeX/releases).

1. Launch ModuTeX and choose **New document**, **Open file**, or **Open folder**.
2. Edit visually or switch to Source mode.
3. Click **Compile PDF** to build the document using the integrated engine.

## Development with fork

### Prerequisites

- Windows x64
- Node.js `24.22.1` and npm `11.19.1`
- Rust (stable MSVC) with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)

### Build and Run

Install dependencies and compile the desktop application:

```powershell
npm ci

# Build the frontend and release Tauri desktop executable
npm run build

# Launch the compiled Tauri executable directly
npm run tauri
```

### Verification and Tests

```powershell
npm run frontend:check
npm run frontend:test
```

## Code signing policy

SignPath Foundation application preparation is in progress. See the [Code signing policy](docs/distribution/SIGNPATH_ELIGIBILITY.md) for signing scope, team roles and release approvals, and the [Privacy policy](docs/user/PRIVACY.md) for local data and network activity.

## License

Original code in the current Tauri application is licensed under [Apache-2.0](LICENSE).
See [LICENSING.md](LICENSING.md) for details on source scopes.
