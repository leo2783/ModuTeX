# Tauri 遷移實作狀態

日期：2026-10-17｜分支：`refactor/tauri-apache-migration`｜基準：`b1e1d25`

| 階段 | 狀態 | 證據／剩餘工作 |
|---|---|---|
| G0 規格／來源 | 六區回件整合 | 91 個 IPC 通道、12 個 MCP 工具、11 個 DesktopPort 方法與 app／texfile protocols；206 個記錄、8 處 Draw.io 排除。整合 [183 項能力／門檻](tauri/capability-inventory.json)，保留各區審查狀態及後續驗收。 |
| G1 骨架／原型 | release 骨架通過 | Tauri 2.12.4 host、strict DTO、RelativePath、視窗所屬工作區 registry、原創建置圖示與 Apache LICENSE／NOTICE 已加入。32 項 Rust 測試、fmt、Clippy、前端與 Windows release 建置通過；實際 WebView2 載入首頁、host_health 回應正確且無 page error。引擎／PTY／binary IPC／PDF／IME 原型待驗收。 |
| G2–G7 | 尚未執行 | 依[遷移計畫](TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)與[subagent 計畫](TAURI_SUBAGENT_PLAN_2026-10-17.md)推進。 |

## 已加入工具

- `scripts/agents/tauri-surface.mjs`：AST 擷取通道／MCP／protocol／DesktopPort，保留動態 wrapper 待辦；四項測試通過，`--check` 驗證基準未漂移。
- `scripts/agents/prepare-tauri-g0.mjs`：固定來源 hash，準備 AGY 3／Luna 3 唯讀任務與本機 runner。
- `scripts/agents/tauri-input.mjs`：共同前綴、模組快照、動態任務分層；保留 explicit cache 斷點。
- `scripts/agents/run-tauri-agy.ps1`：指定模型、lane 鎖、原 handle、stdout／stderr／exit 收據。

本機收據位於 `.verification-artifacts/tauri/`。使用者已授權來源傳送至 AGY／OpenAI Luna API。過期金鑰更新後，Luna 三槽皆成功交付，三份成功回件合計 cached 58,103／input 122,114 tokens。AGY 改用精確檔案讀取後正常交付；早期 401、未讀來源及輸出截斷收據均保留。

Release 執行檔、Cargo.lock、前端 index 的 SHA256 與實際啟動結果見 [G1 驗證](tauri/g1-verification.json)；截圖在本機收據目錄。測試行程已關閉。

共用介面見 [CONTRACT](tauri/CONTRACT.md)，已補搜尋、可復原刪除、格式化、SyncTeX、自訂編譯及十二個 MCP 工具；來源台帳見 [tauri-origin](../licensing/tauri-origin.json)，逐檔新實作與第三方閉包待補。

派送前核對 snapshot hash，來源變更即拒絕；兩項快取／過期來源測試加上四項 AST 測試共 6 項通過，AST 基準未漂移。來源台帳記錄 18 個新增檔案的 SHA256、原創／生成依據及測試範圍。骨架目前僅註冊真實 host_health，尚未接上 Tauri 檔案 adapter；首頁仍顯示瀏覽器模式，完整 runtime 驗收待完成。
