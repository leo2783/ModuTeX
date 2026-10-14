# Known limitations / 已知限制

## Platform and distribution

- The packaged desktop targets Windows x64. The installer is unsigned; Windows reputation or organization policies may block it. See [installation](INSTALLATION.md).
- The TGZ requires Node.js 24.19.0 and npm 11.17.0. It is a local npx package, not an npm registry publication.
- The complete Electron application remains AGPL-3.0-only. Separately listed original frontend/shared modules use Apache-2.0; this does not relicense the entire application.

## Editing

- Visual editing covers supported LaTeX structures. Use Source mode for custom commands or unsupported structures; original source is preserved.
- Draw.io, Mermaid and visual section folding are not exposed in the new interface. Source section/environment folding is available.
- Code blocks over 100,000 UTF-16 units remain readable and editable as plain text without syntax highlighting.
- Very large documents can still produce noticeable visual-editing delays. Performance measurements are recorded; no universal latency guarantee is made.
- Windows Chinese input behavior depends on the installed IME. Browser tests do not cover every native input method.

## Compilation

Managed Tectonic requires internet access when generating its initial format or downloading uncached TeX resources. Cached resources are reused locally; adding a package can require another download.

The new interface uses Managed Tectonic. Custom System TeX configuration belongs to the earlier editor and is not exposed here. TeX documents needing external programs or shell escape may require another workflow.

## Integration

MCP remains disabled by default and experimental in the retained host. Tauri migration is outside this release.

## 繁體中文

- 桌面套件支援 Windows x64；EXE 尚未簽署，Windows 或組織政策可能封鎖執行。
- 視覺編輯只涵蓋支援的 LaTeX 結構；自訂指令請使用原始碼模式。
- 新介面未提供 Draw.io、Mermaid、視覺章節摺疊及自訂 System TeX 設定。
- 超過 100,000 UTF-16 單位的程式碼以純文字呈現，保留完整內容但停用語法上色。
- 大型文件仍可能有操作延遲；原生中文輸入法需依實際 Windows 環境驗證。
- 首次編譯與未快取套件需要網路；整個 Electron 應用程式仍為 AGPL-3.0-only。