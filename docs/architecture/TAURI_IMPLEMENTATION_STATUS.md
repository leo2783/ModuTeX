# Tauri 遷移實作狀態

日期：2026-10-17｜分支：`codex/tauri-apache-migration`｜基準：`b1e1d25`

| 階段 | 狀態 | 證據／剩餘工作 |
|---|---|---|
| G0 規格／來源 | 進行中 | 固定基準含 91 個 IPC 通道、12 個 MCP 工具、11 個 DesktopPort 方法與 app／texfile protocols；共 206 個記錄、8 處 Draw.io 排除。六份分區任務共 53 個來源檔已準備，待來源傳送授權及 worker 交付。 |
| G1 骨架／原型 | 環境檢查完成 | Rust 1.97.1／MSVC 連結執行成功；公開 crate metadata 已核對 Tauri 2.12.4、tauri-build 2.7.3、dialog 2.8.3（Apache-2.0 OR MIT、Rust 最低 1.90）。host／Cargo.lock 尚待實作。 |
| G2–G7 | 尚未執行 | 依[遷移計畫](TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)與[subagent 計畫](TAURI_SUBAGENT_PLAN_2026-10-17.md)推進。 |

## 已加入工具

- `scripts/agents/tauri-surface.mjs`：AST 擷取通道／MCP／protocol／DesktopPort，保留動態 wrapper 待辦；四項測試通過，`--check` 驗證基準未漂移。
- `scripts/agents/prepare-tauri-g0.mjs`：固定來源 hash，準備 AGY 3／Luna 3 唯讀任務與本機 runner。
- `scripts/agents/tauri-input.mjs`：共同前綴、模組快照、動態任務分層；保留 explicit cache 斷點。
- `scripts/agents/run-tauri-agy.ps1`：指定模型、lane 鎖、原 handle、stdout／stderr／exit 收據。

本機收據位於 `.verification-artifacts/tauri/`。外部兩次啟動均被自動審核拒絕，沒有 worker 開始執行或 API 生成回件；來源傳送授權已另行提出。

共用介面見 [CONTRACT](tauri/CONTRACT.md)，已補搜尋、可復原刪除、格式化、SyncTeX、自訂編譯及十二個 MCP 工具；來源台帳見 [tauri-origin](../licensing/tauri-origin.json)，逐檔新實作與第三方閉包待補。

派送前核對 snapshot hash，來源變更即拒絕；兩項快取／過期來源測試加上四項 AST 測試共 6 項通過。未執行 Tauri runtime 測試。
