# ModuTeX Tauri host

Windows x64；Rust／Tauri 2 後端，前端使用 WebView2。自有程式碼採 Apache-2.0，第三方保留原授權。

## 目錄

| 路徑 | 責任 |
|---|---|
| `src/commands` | Tauri 命令與視窗入口 |
| `src/platform` | 原生系統與檔案操作 |
| `src/schemas` | DTO、識別碼及輸入驗證 |
| `src/services` | 檔案、Git、監看服務 |
| `src/shared` | 共用路徑工具 |
| `src/state` | 設定、工作階段、近期紀錄與能力狀態 |
| `tests/unit` | 集中單元及原生測試；保留私有模組存取 |
| `examples` | 引擎與 ConPTY 原型 |

## 驗證

在儲存庫根目錄執行：

```powershell
npm run frontend:build:tauri
cargo test --locked --manifest-path apps/desktop-tauri/Cargo.toml --lib
cargo build --locked --manifest-path apps/desktop-tauri/Cargo.toml --release
```

目錄整理後，實際 crate 107 項測試通過；完整遷移仍依[計畫](../../docs/architecture/TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)驗收。Electron 與舊 texpile-editor 僅為歷史參考。

Node.js 用於建置、開發與測試。圖示來源與第三方聲明見 [NOTICE](NOTICE)；原型說明見 [G1_PROBES.md](G1_PROBES.md)。
