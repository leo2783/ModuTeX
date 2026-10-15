<p align="center"><img src="build/icons/128x128.png" alt="ModuTeX" width="80" height="80"></p>
<h1 align="center">ModuTeX</h1>
<p align="center">Visual LaTeX editing with a built-in compiler.</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a></p>

ModuTeX combines visual editing, LaTeX source and PDF preview in one desktop workspace.
Write text, build equations and tables, and compile with the bundled Tectonic engine.

## Features

- **Visual and source editing:** edit supported content directly, with shared undo and access to the original LaTeX for custom commands.
- **Notebook cells:** drag cells with the mouse, insert at the current caret, and organize titles, abstracts and headings.
- **Equations and matrices:** choose graphical templates for fractions, limits, calculus and other structures; mix matrices with ordinary math.
- **Tables, code and images:** adjust table rows and widths, choose code languages with syntax highlighting, and insert or paste PNG/JPEG images.
- **PDF preview:** compile beside your document, inspect errors and keep the previous successful preview when compilation fails.
- **Two languages:** choose English or Traditional Chinese from the globe menu.

## Download and run

The desktop package targets **Windows x64**. Choose a format from the [0.2.1 release](https://github.com/leo2783/ModuTeX/releases/tag/v0.2.1):

| Format | File | Requirements |
|---|---|---|
| Windows installer | `ModuTeX-Setup-0.2.1.exe` | No separate Node.js, npm or TeX installation. |
| Local npx package | `modutex-desktop-0.2.1.tgz` | Node.js 24.19.0 and npm 11.17.0. |

Download the chosen file and its matching `.sha256`. For the installer, verify it with
`Get-FileHash .\ModuTeX-Setup-0.2.1.exe -Algorithm SHA256`, compare the result with the checksum file,
then double-click it and follow the installation wizard.

Download `modutex-desktop-0.2.1.tgz` and its matching `.tgz.sha256` from the
[0.2.1 release](https://github.com/leo2783/ModuTeX/releases/tag/v0.2.1).
Open PowerShell in the download folder, verify the checksum, then launch:

```powershell
$package = 'modutex-desktop-0.2.1.tgz'
$expected = (Get-Content ".\$package.sha256").Split(' ')[0].ToLowerInvariant()
$actual = (Get-FileHash ".\$package" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Checksum mismatch' }
npx --offline --yes --ignore-scripts --package ".\$package" -- modutex
```

This launches the app through a local package; it does not install a permanent Windows application.
Initial extraction can take several minutes. Tectonic may need internet access for the first compilation or uncached resources.
See [installation and troubleshooting](docs/user/INSTALLATION.md).
The [0.1.0 release](https://github.com/leo2783/ModuTeX/releases/tag/v0.1.0) remains available with the earlier editor.

### Windows blocks the download or launch

The installer is unsigned. Windows may show **Unknown publisher** or a SmartScreen reputation warning.
First confirm the download is from this repository's Release and its SHA-256 matches.
For an unrecognized-app SmartScreen warning, use **More info → Run anyway** only if Windows offers that option and you trust the verified file.
For a file marked as downloaded, its **Properties → Unblock** option may be available.
If antivirus reports malware, the checksum differs, or Smart App Control/organization policy prevents execution,
stop and report the message or contact your administrator; do not disable system-wide protection.
The `.tgz` format does not bypass Windows checks on the included executable.
See [Windows troubleshooting](docs/user/INSTALLATION.md#windows-blocking--windows-封鎖),
[Microsoft SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
and [file blocking guidance](https://support.microsoft.com/en-gb/windows/security/information-about-the-attachment-manager-in-microsoft-windows).

## Start a document

1. Choose **New document**, **Open file** or **Open folder**.
2. Edit in Visual mode, or switch to Source for LaTeX commands.
3. Choose **Compile PDF**. Unsaved changes are saved first; disk conflicts require attention.

See [editing](docs/user/EDITING.md) and [compilation](docs/user/COMPILATION.md) for shortcuts, insertion and error handling.

## Development

From the repository root, with the exact Node/npm versions above:

```powershell
npm ci
npm run electron:dev:frontend
```

This opens the new frontend in Electron using Vite on port 5174.
For a local static build, run `npm run electron:frontend`.
`npm run electron:dev` starts the earlier editor on port 5173.

Run `npm run verify:modutex` for shared packages, new frontend and retained host/editor checks.
See [development and packaging](docs/user/DEVELOPMENT.md) for individual commands.

## Scope and license

The installer is unsigned. Draw.io, Mermaid and a Tauri host are not provided by the new interface.
Custom System TeX configuration belongs to the earlier editor. See [known limitations](docs/user/KNOWN_LIMITATIONS.md).

The complete desktop application is derived from Texpile and licensed under [AGPL-3.0-only](LICENSE).
The original frontend and shared packages listed in [LICENSING.md](LICENSING.md) use Apache-2.0;
third-party components retain their own licenses and notices.

[Changelog](CHANGELOG.md) · [Installation](docs/user/INSTALLATION.md) · [Licensing](LICENSING.md)
