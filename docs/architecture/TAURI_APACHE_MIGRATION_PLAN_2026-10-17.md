# Tauri 後端遷移計畫

日期：2026-10-17｜基準：main `b1e1d25`｜狀態：實作中，進度見[狀態表](TAURI_IMPLEMENTATION_STATUS.md)

## 目標與範圍

Windows x64 全功能一次切換至 Tauri 2／Rust。自有程式碼採 Apache-2.0；第三方保留原授權及必要聲明。保留新版 Svelte 前端、document-core 與 frontend-contracts。

包含檔案、編輯、編譯、PDF、終端機、Git、Typst／Draft、MCP、設定與多視窗。Draw.io 改為未來 plugin，排除本次實作、打包、驗收與工期；不實作 plugin 系統。macOS／Linux 後續處理。

**遷移不得降低功能。** 既有功能概念、操作能力與使用情境必須保留；因語言、框架或平台差異，改用等效方式實現。不得以刪除、停用、縮減功能或改成人工步驟作為遷移完成；Draw.io 依上述決策另行處理。

## 程式配置

| 位置 | 處理方式 |
|---|---|
| `apps/frontend`、`packages/document-core`、`packages/frontend-contracts` | 沿用現有 Apache 原創碼，核對來源待查項與第三方閉包 |
| `apps/frontend/src/features/files/desktop.ts` | 抽出 transport，新增 Tauri adapter，保留 DesktopPort 語意 |
| `apps/desktop-tauri/src-tauri`（新增） | Rust commands、工作區、檔案、監看、程序管理、編譯與各項服務 |
| `electron/src`、`electron/lua`、`packages/modutex-contracts` | 依功能規格重新實作；直接重用須逐檔確認來源及改授權權限 |
| 舊 Electron 打包腳本 | 新建 Tauri 專用流程，不搬移後換授權標頭 |
| Draw.io vendor／橋接／PDF 匯出 | 排除新核心產物，不保留 Electron fallback |

資料流：前端 → DesktopPort／功能契約 → Tauri adapter → Rust 權限與輸入驗證 → 工作區／服務 → 檔案或引擎。終端機、Git、Typst、Draft、MCP 各用窄契約，避免任意 IPC。

## 執行階段

| 階段 | 工作 | 完成條件 |
|---|---|---|
| G0 規格與來源 | 固定 SHA；盤點 main／preload 請求、事件、UI 入口、錯誤及資料副作用；建立來源台帳 | 每項功能都有契約、驗收案例及「既有能力 → 新實作 → 等效驗證」對照；Draw.io 明列排除 |
| G1 骨架與原型 | 鎖定 Rust／MSVC／Tauri／依賴；載入實際前端；驗證 binary IPC、PDF.js worker、中文 IME、ConPTY 與引擎啟停 | Windows release build 可執行，真實 Tectonic PDF 可顯示，依賴來源與授權可採用 |
| G2 檔案與視窗 | 開啟、讀寫、另存、最近文件、監看、設定、關閉保存、新視窗、檔案關聯 | 存檔重開 bytes 一致；衝突不覆蓋；取消關窗保留內容；跨窗 ID 隔離 |
| G3 編譯與 PDF | Managed Tectonic／System TeX、輸入快照、診斷、快取、取消、程序樹及 PDF 發布 | 真實成功、失敗、逾時、取消、輸入變更通過；舊結果不替換新 PDF；清理後才解鎖 |
| G4 終端機與 Git | Rust ConPTY；Git status/show/init/stage/unstage/discard/commit/userName；補前端入口 | 真實 Unicode shell、resize、exit；暫存 repo 操作完整通過，事件不跨窗 |
| G5 Typst／Draft／MCP | LSP／preview、Draft daemon／Lua／PDF、工具探測、MCP transport／工具與操作入口 | 各功能從新版介面完成真實流程；停止、斷線、重啟、搶占、切換與關窗清理通過；MCP 預設關閉 |
| G6 授權與打包 | 來源台帳、SBOM、LICENSE／NOTICE、獨立來源包、安裝器、CI、資料匯入 | 新 runtime 不含舊 AGPL host／legacy／Draw.io；自有碼有 Apache 權利依據；分發閉包無未解授權項 |
| G7 正式切換 | 乾淨 Windows VM 安裝、升級、功能驗收、卸載與回退；更新版本及發布文件 | G0–G6 證據對應同一 SHA／lockfile／產物 hash，逐項確認功能等效且無降級後切換 |

## 實作約束

| 項目 | 必須保留或補足的行為 |
|---|---|
| 檔案 | Rust 配發 workspace ID 並綁定可信視窗；驗證相對路徑、junction／symlink 及實際檔案身分。新建不覆蓋；修改比對 revision，以檔案 handle／平台原語處理路徑替換競態。 |
| 監看 | subscription 綁 workspace／視窗／generation；切換後丟棄舊事件；深度、數量及解除訂閱競態有測試。 |
| 編譯 | 核對 runId、documentVersion、savedRevision 與全部輸入；相交工作區的保存／編譯互斥；取消等待程序樹及輸出清理。失敗保留前次 PDF。 |
| 引擎與前處理 | 固定 binary 來源／版本／SHA；System TeX 使用明確引擎及 argv，保留由使用者設定、獨立授權的自訂編譯 profile；一般 request 僅選 profile ID。G1 決定 `pdfWrappedText` 的前處理位置，保持 revision 綁定與診斷映射。 |
| IPC | Rust 與 TS 共享契約案例；驗證 Uint8Array 傳輸與還原。先維持來源 5 MiB、PDF 32 MiB、list 4096 筆；其他上限於 G0 列明，配置／傳輸前限制。 |
| 權限 | owner 從可信呼叫環境取得；自訂 commands 明列 permission／AppManifest，handler 再查 owner；事件定向傳送。preview 不取得檔案／shell 權限。 |
| 終端機／Git | PTY 有背壓及緩衝上限；互動 shell 獨立授權。Git 使用固定操作與 argv，檢查路徑／選項注入；discard 保留確認。 |
| Typst／Draft | 驗證 LSP framing、loopback preview 來源、daemon 協定及 Lua 來源；停止、搶占、錯誤 TeX 與孤兒程序有測試。 |
| MCP | G0 列完整工具及 transport；驗證 session／來源／憑證，限制訊息、逾時及待處理請求；關窗撤銷 owner。 |
| 設定與資料 | schema 版本化、原子寫入；新 app 使用獨立資料目錄，驗證後匯入舊設定，保留原檔；不盲搬快取／執行檔。測試可重試匯入、升級及回退。 |

Tauri 自訂已註冊 command 預設可供所有視窗呼叫，必須明確收斂權限並測試越權拒絕，不能只新增 capability JSON。[官方說明](https://v2.tauri.app/security/capabilities/)

## Apache-2.0 發布門檻

1. G0 新增 `docs/licensing/tauri-origin.json`，逐檔記錄來源 SHA／URL、原授權、權利依據、改作及驗收證據。舊 AGPL 程式換語言不構成授權轉換；來源未明項先解決再重用。
2. 自有 Rust、TS、Lua、測試、腳本、素材逐項確認並附 Apache LICENSE／SPDX／NOTICE。第三方維持自身條款，依實際連結、修改及分發方式履行義務。
3. SBOM 覆蓋 npm bundle、Cargo features／target 依賴、DLL、sidecar、TeX 資源、字型、WASM 與生成物；核對實際產物及授權全文。打包 Git 或其他外部 CLI 時另查其分發義務。
4. 新產物與來源包採正向檔案清單，排除舊 AGPL host、legacy、Draw.io 及未知 runtime。根儲存庫保留 legacy 時，授權說明按路徑區分；既有 AGPL 版本維持原條款。
5. 通過以上檢查後，才更新新發行範圍的 license metadata、安裝器文字與公開文件。

## 驗證與交付

CI 依序加入 Rust format／lint／unit、契約、真檔案、真引擎、PTY、Git、LSP／Draft／MCP、解包 inventory 與 notices 檢查。缺工具而 skip 的案例不算通過；最後以全新 VM 的實際安裝器驗收全部操作入口。

選定並測試 WebView2 有／無 runtime 的安裝方式；TeX 冷快取下載與離線安裝分別驗收。sidecar 按 target triple 打包及核對 hash。G7 前保留 Electron 正式版回退途徑，卸載不刪使用者文件。[Windows 安裝](https://v2.tauri.app/distribute/windows-installer/)・[sidecar 打包](https://v2.tauri.app/develop/sidecar/)

估算一位熟悉 Rust／Windows 與現有前端的全職工程師：G0–G1 5–8 日、G2 5–8 日、G3 5–8 日、G4 4–6 日、G5 8–12 日、G6–G7 6–10 日，合計 **33–52 工程日，約 7–11 週**。包含必要前端入口、來源盤點與回歸；排除 Draw.io、其他平台及外部權利／憑證等待。G1 原型完成後重估。

執行順序：G0 → G1 → G2 → G3 → G4／G5 → G6 → G7。功能盤點與 G1 基礎模組已交付，按[狀態表](TAURI_IMPLEMENTATION_STATUS.md)推進原型及驗收。

人力調度依 [subagent 使用計畫](TAURI_SUBAGENT_PLAN_2026-10-17.md)：AGY 3＋Luna API 3，最多六個 worker；保留主代理獨立整合與驗收。

共用介面與完整功能對照依 [Tauri 契約](tauri/CONTRACT.md)，包含搜尋、檔案復原、格式化、SyncTeX、自訂編譯與十二個 MCP 工具。

## 依據

專案：[授權範圍](../../LICENSING.md)、[Apache 前端範圍](../licensing/FRONTEND_APACHE_SCOPE_2026-10-12.md)、[來源盤點](../licensing/AGPL_APACHE_INVENTORY_2026-10-04.md)、[來源紀錄](../licensing/frontend-origin.json)、[現行功能](FRONTEND_REWRITE_STATUS.md)、[已知限制](../user/KNOWN_LIMITATIONS.md)。授權操作依 [Apache 官方指引](https://apache.org/legal/apply-license.html)。
