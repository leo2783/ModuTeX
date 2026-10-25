# ModuTeX Tauri host

Windows x64 的 Rust／Tauri 2 後端，前端使用 WebView2。自有程式碼採 Apache-2.0，第三方保留原授權。

## 目錄

| 路徑 | 責任 |
|---|---|
| `src/commands` | Tauri 命令與視窗入口 |
| `src/platform` | 原生系統與檔案操作 |
| `src/schemas` | DTO、識別碼及輸入驗證 |
| `src/services` | 檔案、Git、監看服務 |
| `src/shared` | 共用路徑工具 |
| `src/state` | 設定、工作階段、近期紀錄與能力狀態 |
| `tests/unit` | 集中單元及原生測試，保留私有模組存取 |
| `tests/tools` | 引擎與終端機 smoke 工具，僅在 `g1-prototypes` 啟用 |

## 啟動

在儲存庫根目錄執行，使用專案指定的 Node.js 24.22.1／npm 11.19.1：

```powershell
npm run tauri
```

此指令直接啟動已建置的 Rust release App。首次使用或修改原始碼後先執行 `npm run tauri:build`，日常啟動不重建。

## 驗證

在儲存庫根目錄執行：

```powershell
npm run frontend:build:tauri
cargo test --locked --release --manifest-path apps/desktop-tauri/Cargo.toml --lib
cargo build --locked --manifest-path apps/desktop-tauri/Cargo.toml --release
```

Node.js 用於建置、開發與測試。圖示來源與第三方聲明見 [NOTICE](NOTICE)。
