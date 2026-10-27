# 開發與打包

在儲存庫根目錄執行。使用 Node.js 24.22.1、npm 11.19.1、Rust 1.97.1 MSVC 與 wasm-bindgen-cli 0.2.126。

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
npm ci
npm run build
npm run tauri
```

`npm run tauri` 啟動已建置的執行檔。修改程式後先重新建置。

| 命令                            | 用途                                 |
| ------------------------------- | ------------------------------------ |
| `npm run frontend:check`        | Svelte 與 TypeScript 檢查            |
| `npm run frontend:test`         | 前端功能測試                         |
| `npm run frontend:build:tauri`  | 建置 Rust WASM 與 Tauri 前端         |
| `npm run tauri:build`           | 建置前端與 Rust 桌面程式             |
| `npm run tauri:package`         | 建置標準 Windows 安裝包              |
| `npm run tauri:package:offline` | 建置含離線 WebView2 安裝資源的安裝包 |

桌面、前端、共用契約及 Rust 核心使用 0.3.0。版本更新使用 `npm run set-version -- 0.3.0`。

[CI](../../.github/workflows/tauri-ci.yml) 按 Markdown、前端、Rust、安全、原生 E2E 與打包驗證拆分。[發布流程](../../.github/workflows/tauri-release.yml) 使用 CI 驗證過的執行檔處理簽章與更新產物。

[儲存格結構切換修復與測試報告（2026-10-27）](../reports/cell-transitions-2026-10-27.md)
