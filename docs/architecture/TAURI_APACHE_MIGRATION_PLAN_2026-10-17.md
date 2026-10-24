# Tauri 後端遷移計畫

日期：2026-10-17｜基準：main `b1e1d25`｜狀態：實作中，進度見本文「目前狀態」

## 目標與範圍

2026-10-24 決定：移除 Typst 全部模組與 parser 套件，保留 LaTeX／Draft。Typst 不列入驗收。官方 updater 已接入下載、儲存並更新及等待編譯流程，正式更新產物仍待驗收。以下歷史紀錄保留當時狀態。

目前驗證：前端 357 項測試通過。原生關閉的取消與捨棄流程通過真實 Windows E2E，儲存失敗及儲存期間再編輯也有回歸測試。多視窗正在整合。線上與離線安裝包的內容核對通過，乾淨 Windows 安裝、升級、卸載及回退仍待驗收。

Windows x64 全功能一次切換至 Tauri 2／Rust。自有程式碼採 Apache-2.0。第三方保留原授權及必要聲明。保留新版 Svelte 介面。文件核心改為 Rust，契約按正式前後端邊界整合，僅實際共用模組獨立保留。

包含檔案、編輯、編譯、PDF、終端機、Git、Draft、設定與多視窗。Draw.io 改為未來 plugin，排除本次實作、打包、驗收與工期。不實作 plugin 系統。macOS／Linux 後續處理。

MCP 延至後續版本。本版不提供 MCP 入口，不納入實作、打包、驗收與發布必要檢查。已完成候選保留供後續使用。

本版 Git 為選用整合：未安裝 Git 時，啟動、編輯、儲存及編譯仍須正常。版本控制入口顯示 Git 不可用與原因。自有內建版本控制系統不在本版範圍，列為後續待辦。

**遷移不得降低功能。** 本版範圍內的既有功能概念、操作能力與使用情境必須保留。因語言、框架或平台差異，改用等效方式實現。不得以刪除、停用、縮減功能或改成人工步驟作為遷移完成。Draw.io、MCP 與 Typst 依上述版本決策另行處理。

## 程式配置

| 位置                                                         | 處理方式                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `apps/frontend`、文件核心與契約                              | Svelte 保留介面／互動。原文、交易、AST、位置映射改為 Rust。共用模組按實際呼叫端獨立，核對來源與第三方閉包 |
| `apps/frontend/src/features/files/desktop.ts`                | 抽出 transport，新增 Tauri adapter，保留 DesktopPort 語意                                                 |
| `apps/desktop-tauri`                                         | Rust crate 根目錄。`src/` 按責任分類，測試集中於同層 `tests/`，Cargo／Tauri 設定位於 app 根目錄           |
| `electron/src`、`electron/lua`、`packages/modutex-contracts` | 依功能規格重新實作。直接重用須逐檔確認來源及改授權權限                                                    |
| 舊 Electron 打包腳本                                         | 新建 Tauri 專用流程，不搬移後換授權標頭                                                                   |
| Draw.io vendor／橋接／PDF 匯出                               | 排除新核心產物，不保留 Electron fallback                                                                  |

資料流：前端 → DesktopPort／功能契約 → Tauri adapter → Rust 權限與輸入驗證 → 工作區／服務 → 檔案或引擎。終端機、Git、Draft 各用窄契約，避免任意 IPC。

正式宿主由 Rust 執行，前端使用 Windows WebView2。Node.js 用於開發、前端建置及測試。外部引擎／MCP 工具的執行需求納入分發盤點，完整遷移前不宣稱所有外部工具已移除 Node 需求。

## 執行階段

| 階段            | 工作                                                                                                    | 完成條件                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| G0 規格與來源   | 固定 SHA。盤點 main／preload 請求、事件、UI 入口、錯誤及資料副作用。建立來源台帳                        | 每項功能都有契約、驗收案例及「既有能力 → 新實作 → 等效驗證」對照。Draw.io 明列排除           |
| G1 骨架與原型   | 鎖定 Rust／MSVC／Tauri／依賴。載入實際前端。驗證 binary IPC、PDF.js worker、中文 IME、ConPTY 與引擎啟停 | Windows release build 可執行，真實 Tectonic PDF 可顯示，依賴來源與授權可採用                 |
| G2 檔案與視窗   | 開啟、讀寫、另存、最近文件、監看、設定、關閉保存、新視窗、檔案關聯                                      | 存檔重開 bytes 一致。衝突不覆蓋。取消關窗保留內容。跨窗 ID 隔離                              |
| G3 編譯與 PDF   | Managed Tectonic／System TeX、輸入快照、診斷、快取、取消、程序樹及 PDF 發布                             | 真實成功、失敗、逾時、取消、輸入變更通過。舊結果不替換新 PDF。清理後才解鎖                   |
| G4 終端機與 Git | Rust ConPTY。Git status/show/init/stage/unstage/discard/commit/userName。補前端入口                     | 真實 Unicode shell、resize、exit。暫存 repo 操作完整通過，事件不跨窗                         |
| G5 Draft        | Draft daemon／Lua／PDF、工具探測                                                                        | 各功能從新版介面完成真實流程。停止、斷線、重啟、搶占、切換與關窗清理通過                     |
| G6 授權與打包   | 來源台帳、SBOM、LICENSE／NOTICE、獨立來源包、安裝器、CI、資料匯入                                       | 新 runtime 不含舊 AGPL host／legacy／Draw.io。自有碼有 Apache 權利依據。分發閉包無未解授權項 |
| G7 正式切換     | 乾淨 Windows VM 安裝、升級、功能驗收、卸載與回退。更新版本及發布文件                                    | G0–G6 證據對應同一 SHA／lockfile／產物 hash，逐項確認功能等效且無降級後切換                  |

## 實作約束

程式碼不含 emoji 字面值。Unicode 邊界測試使用跳脫表示並保留原字元覆蓋。只保留必要抽象及可採取行動的錯誤訊息，移除重複除錯輸出。以 2026-10-22（週四）前完成為優先時程，功能等效、原生 E2E 與發布門檻不縮減。

| 項目         | 必須保留或補足的行為                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 檔案         | Rust 配發 workspace ID 並綁定可信視窗。驗證相對路徑、junction／symlink 及實際檔案身分。新建不覆蓋。修改比對 revision，以檔案 handle／平台原語處理路徑替換競態。                                                |
| 監看         | subscription 綁 workspace／視窗／generation。切換後丟棄舊事件。深度、數量及解除訂閱競態有測試。                                                                                                                |
| 編譯         | 核對 runId、documentVersion、savedRevision 與全部輸入。相交工作區的保存／編譯互斥。取消等待程序樹及輸出清理。失敗保留前次 PDF。                                                                                |
| 引擎與前處理 | 固定 binary 來源／版本／SHA。System TeX 使用明確引擎及 argv，保留由使用者設定、獨立授權的自訂編譯 profile。一般 request 僅選 profile ID。G1 決定 `pdfWrappedText` 的前處理位置，保持 revision 綁定與診斷映射。 |
| IPC          | Rust 與 TS 共享契約案例。驗證 Uint8Array 傳輸與還原。先維持來源 5 MiB、PDF 32 MiB、list 4096 筆。其他上限於 G0 列明，配置／傳輸前限制。                                                                        |
| 權限         | owner 從可信呼叫環境取得。自訂 commands 明列 permission／AppManifest，handler 再查 owner。事件定向傳送。preview 不取得檔案／shell 權限。                                                                       |
| 終端機／Git  | PTY 有背壓及緩衝上限。互動 shell 獨立授權。Git 使用固定操作與 argv，檢查路徑／選項注入。discard 保留確認。                                                                                                     |
| Draft        | 驗證 daemon 協定及 Lua 來源。停止、搶占、錯誤 TeX 與孤兒程序有測試。                                                                                                                                           |
| MCP          | G0 列完整工具及 transport。驗證 session／來源／憑證，限制訊息、逾時及待處理請求。關窗撤銷 owner。                                                                                                              |
| 設定與資料   | schema 版本化、原子寫入。新 app 使用獨立資料目錄，驗證後匯入舊設定，保留原檔。不盲搬快取／執行檔。測試可重試匯入、升級及回退。                                                                                 |

Tauri 自訂已註冊 command 預設可供所有視窗呼叫，必須明確收斂權限並測試越權拒絕，不能只新增 capability JSON。[官方說明](https://v2.tauri.app/security/capabilities/)

## Apache-2.0 發布門檻

1. G0 新增 `docs/licensing/tauri-origin.json`，逐檔記錄來源 SHA／URL、原授權、權利依據、改作及驗收證據。舊 AGPL 程式換語言不構成授權轉換。來源未明項先解決再重用。
2. 自有 Rust、TS、Lua、測試、腳本、素材逐項確認並附 Apache LICENSE／SPDX／NOTICE。第三方維持自身條款，依實際連結、修改及分發方式履行義務。
3. SBOM 覆蓋 npm bundle、Cargo features／target 依賴、DLL、sidecar、TeX 資源、字型、WASM 與生成物。核對實際產物及授權全文。打包 Git 或其他外部 CLI 時另查其分發義務。
4. 新產物與來源包採正向檔案清單，排除舊 AGPL host、legacy、Draw.io 及未知 runtime。根儲存庫保留 legacy 時，授權說明按路徑區分。既有 AGPL 版本維持原條款。
5. 通過以上檢查後，才更新新發行範圍的 license metadata、安裝器文字與公開文件。

## 驗證與交付

CI 必須覆蓋 Tauri／Rust 的 rustfmt、Clippy、單元與原生整合測試、all-targets／all-features 檢查及 Windows x64 release 建置。前端執行 Svelte／TypeScript 檢查、共享契約／文件核心與前端測試及 Tauri 模式建置。同一產物再執行 E2E、真引擎、PTY、Git、LSP／Draft、安裝／解包 inventory 與 notices 檢查。MCP 專屬驗證延至後續版本。缺工具而 skip 的案例不算通過。舊 Electron workflow 不代替新 runtime 驗收，最後以全新 VM 安裝器驗收發布必要入口。

E2E 為必要放行條件：使用實際 Windows Tauri 程式與真實檔案／引擎，從介面完成開啟、編輯、儲存重開、編譯與 PDF、終端機、Git、Draft，並驗證切換工作區與關窗清理。單元測試、mock adapter 或啟動 smoke 不代替完整操作驗收。每份收據記錄來源 SHA、執行檔 hash、實際涵蓋範圍及結果。

選定並測試 WebView2 有／無 runtime 的安裝方式。TeX 冷快取下載與離線安裝分別驗收。sidecar 按 target triple 打包及核對 hash。G7 前保留 Electron 正式版回退途徑，卸載不刪使用者文件。[Windows 安裝](https://v2.tauri.app/distribute/windows-installer/)・[sidecar 打包](https://v2.tauri.app/develop/sidecar/)

### SignPath 審查與打包

| 項目           | 驗收條件                                                                                                                                                                                    | 責任／狀態                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 申請與核准     | SignPath 帳戶、專案核准、外部簽章許可                                                                                                                                                       | 使用者處理。外部待辦，不阻擋遷移、打包及其餘目標                                 |
| 開源申請條件   | 全部元件符合官方開源條件。維持公開發行與功能說明、Code signing policy、隱私說明、維護／審查／簽章核准角色及 MFA。提供卸載方式                                                               | 主代理核對官方條件、owner 補齊。帳戶申請由使用者處理                             |
| Windows 安裝包 | 真正產出 Windows x64 選定安裝器。驗證安裝／升級／卸載、WebView2、sidecar、版本資訊及乾淨 VM 全功能                                                                                          | G7 必做。不因未申請簽章而延後                                                    |
| 簽章流程       | 簽章前置工作全部使用 GitHub-hosted runner，先上傳 workflow artifact 再提交簽章。保留來源 SHA／產物對應、手動核准及 artifact configuration。未設定時回報 external-pending                    | G7 必做。不寫入機密、不假造簽章成功                                              |
| CI／CD         | PR／push 執行 Rust、Tauri、Svelte 與 E2E。CD 重用同一通過驗證的來源及產物，核對 tag／版本／EXE metadata，經受保護環境手動核准，再簽章、驗證及發布。缺少簽章設定仍可產出明確標示未簽章的候選 | G6–G7 必做。不可重建另一份 EXE 冒充已驗收產物                                    |
| 產物邊界       | 明列自有 EXE／DLL／安裝器的簽章範圍。第三方元件核對原簽章及政策，不任意重新簽署。包含適用的巢狀簽章與打包順序                                                                               | G6–G7 必做                                                                       |
| 發布驗證       | 最終產物 hash／SBOM／notices。簽章驗證腳本核對 Authenticode、發行者、時間戳與信任鏈。重新簽章後重算 hash，防止驗舊檔、發新檔                                                                | 工具與流程必做。真實簽章測試待外部核准後執行，獨立記錄待驗證，不當作遷移 blocker |

實作完成、未簽章安裝驗收、外部申請及真實簽章驗證分別記錄。不得因外部申請未完成停止其他工作，也不得把未簽章產物標為已簽章正式版。

來源：[SignPath 開源條件](https://signpath.org/terms.html)、[GitHub 整合](https://docs.signpath.io/trusted-build-systems/github)、[Artifact Configuration](https://docs.signpath.io/artifact-configuration/)。

估算一位熟悉 Rust／Windows 與現有前端的全職工程師：G0–G1 5–8 日、G2 5–8 日、G3 5–8 日、G4 4–6 日、G5 8–12 日、G6–G7 6–10 日，合計 **33–52 工程日，約 7–11 週**。包含必要前端入口、來源盤點與回歸。排除 Draw.io、其他平台及外部權利／憑證等待。G1 原型完成後重估。

## 派工與審查

主代理只負責派工、審查、寫測試、套用已審 patch 與驗收。production 實作交付給指定 owner，缺陷退回 owner。文件整併依使用者指示在本機處理。

| 槽位          | 模型                                      | 預設工作                                                         |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| AGY           | 停用                                      | 2026-10-24 使用者因條款更新禁止派工，不得傳送來源或續跑任務       |
| OpenCode 1／2 | `opencode/deepseek-v4.1-flash-free`，high | 完整模組實作、跨檔修復。不同檔案 owner，交付後由主代理審查及實測 |
| Luna 1        | `gpt-6-luna`，max                         | 契約、生命週期與邊界測試                                         |
| Luna 2        | 同上                                      | 功能等效、整合案例與獨立審查                                     |
| Luna 3        | 同上                                      | 來源／授權盤點、漏項檢查或明確小模組                             |

2026-10-24 起停用 AGY，工作池上限為 Luna 3＋OpenCode 2，共 5 個。有可執行、互不重疊的工作才補派。保留原任務規模、完整上下文與驗收品質。透過快取與精確派工減少成本，不拆碎任務、不降低推理設定。相同工作未終止不得重派。失敗先讀收據、找出具體原因再重試。所有模型禁止加入 emoji。Unicode 測試使用跳脫字元保留覆蓋。

實作從共用底層修正，沿用既有服務與介面。禁止過度耦合、過度包裝、重複狀態或生命週期管理。host／transport 僅負責必要的驗證、呼叫與資料轉換，不另建平行業務服務。正式程式碼不得依賴驗證目錄，測試不得以新增包裝層掩蓋底層缺陷。

專案整理依現行 monorepo 與工具鏈慣例：各 app／package 的程式碼留在 `src/`，測試集中到同層 `tests/`。schema／共用程式按實際責任歸位，跨套件共用沿用 `packages/`。Electron 與舊 `texpile-editor` 僅作歷史行為參考，保留原授權與來源，不重構它們的內部目錄、不將其程式當成新架構共用底層。

新版通過 G0–G7 Windows 全功能及 E2E 驗收後，刪除被取代的舊前後端、依賴與建置流程，更新工作區及 CI。歷史來源由 Git 保留，必要授權與來源聲明仍隨適用產物提供。

每個任務附基準 SHA／檔案 hash、目標、讀寫邊界、介面、等效行為、驗收與完整 patch。契約、manifest、lockfile、config 各只有一個 writer。主代理核對基準後審查、套用、實測。worker 僅讀固定封包、回傳 patch 時，主代理可依序執行單組本機建置／原生驗收。禁止 workers 自行啟動本機引擎／GUI 或直接改檔。沿用原 handle，429／503 退避，未完成 patch 不接受。分支為 `refactor/tauri-apache-migration`，遵守 CONTRIBUTING，禁止 `codex/`。

G0 固定契約及 owner → G1 真 release／引擎／PTY 原型 → G2 檔案能力 → G3 編譯 → G4／G5 分區服務與入口 → G6／G7 來源閉包、安裝與全功能驗收。最終證據對應同一 SHA／lockfile／產物。

### AGY 停用

不得派發、重試、續接既有 conversation 或傳送專案檔案。只可在本機審查已取得的結果。

### Luna prompt caching

`tauri-input.mjs` v2 依序放共用程式契約、排序後模組來源、參考文件、動態任務。前兩層 explicit breakpoint。全來源驗 hash，過期拒絕。常改計畫／inventory 放後方。共用程式 hash 作 cache key，不含 lane／task／時間。同模組沿用穩定前綴，不能為暖快取送空任務。

runner 使用 explicit／30m。max 推理、原有成本 reserve／lane guard 保留。記錄 model、lane、prefix hash、response ID、input／cached／write／output／reasoning、耗時與費用。命中率為總 cached／總 input，連續未命中先查斷點、TTL、路由及變動來源。

2026-10-18 本機累計 56 筆可量測 Luna 收據：input 2,821,535／cached 860,498（30.50%）／write 773,491。output 1,933,733，其中 reasoning 1,649,359。僅 layout v3 為 input 1,891,607／cached 733,889（38.80%），不能當成帳戶當日比例或實際費用。

待改善：部分候選原始碼位於不快取的動態 prompt。改為具有完整性雜湊、位於文件與任務前的明確來源區塊，供同模組工作重用。維持完整內容與現有來源檢查。只快取確實會重用的來源，不送暖快取請求。收據比較命中、寫入、推理及審查結果，避免只提高命中率卻增加總消耗。[官方快取規則](https://developers.openai.com/api/docs/guides/prompt-caching)

layout v4 已套入：來源及 SHA-256 置於動態內容前。相關工具共 18 項測試通過。已取得正常任務重用收據：終端機後續任務 input 178,081／cached 81,949（46.02%）。官方 SDK 修正任務 input 76,765／cached 39,324（51.23%）。這些是個別請求，帳戶比例及費用另依平台帳單。

入口：`scripts/agents/prepare-tauri-g0.mjs`、`prepare-tauri-runner.mjs`、`tauri-input.mjs`、`run-tauri-agy.ps1`、`audit-tauri-cache.mjs`。工作表保存 provider／model／lane／owner／baseline／handle／狀態／收據。來源傳送僅依已授權範圍。整批 docs 派工遭自動審查拒絕後改成本機整理。

MCP 採官方 Rust SDK `rmcp`，交付標準 stdio／Streamable HTTP。禁止自訂 wire protocol 或私有 client 握手。驗收包含官方 client、MCP Inspector、llama.cpp 真實 stdio 連接與按需重啟，既有手寫 transport 候選不作正式方案。

## 目前狀態

更新：2026-10-23。已推送 `ea72d9d`：SyncTeX WASM 綁定、PDF 定位元件與回歸測試。

當前驗收：Typst 接入前主程式 218 項原生測試通過。Typst 品質修正後嚴格 Clippy 與 18 項測試通過，包含真實 Tinymist。前端契約及 App 整合待完成。Git 目錄取消暫存修正後 13 項原生整合測試通過。Draft 候選的真實 LuaLaTeX 同程序雙回合與停止清理測試通過，正式後端整合待完成。完整 App 測試已重現引用檔變更後的過期 SyncTeX，修正前不得放行。

CI/CD 候選 actionlint 與 12 項流程測試通過，尚未正式實跑。Draft、授權來源鏈、最終安裝包及歷史程式刪除仍未完成。MCP 延後版本，不列本版阻擋。下表保留早期 checkpoint，不能替代上述現況及完整 E2E 驗收。

| 階段             | 已有證據                                                                                                                                                                                                                                                                                                                                                                                                                        | 尚待放行                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| G0               | 91 IPC、12 MCP、11 DesktopPort、206 surface 記錄、8 處 Draw.io 排除。[183 項能力](tauri/capability-inventory.json)與[審查](tauri/g0-review.json)                                                                                                                                                                                                                                                                                | 實作及等效驗收對照逐項補齊                                                                                                                    |
| G1 骨架          | Tauri 2.12.4、strict DTO、RelativePath、視窗工作區 registry、Apache LICENSE／NOTICE。checkpoint 32 Rust tests、fmt／Clippy、實際 release host_health 通過                                                                                                                                                                                                                                                                       | 新 patch 後重跑建置／測試／實際 WebView                                                                                                       |
| G1 引擎／PTY     | 真 Tectonic 冷編譯 4989-byte PDF。取消 6 ms 並回收。正常 ConPTY 中文／emoji、resize、退出與 reader join 通過                                                                                                                                                                                                                                                                                                                    | 正常／reader 後故障／live cancel 三模式與外部 PID 消失檢查均通過。portable-pty killer BOOL 反判已改用 owner 核對的原生 handle 終止            |
| G1 IPC／PDF／IME | binary 0／1／32767／5 MiB、超限與非可信視窗拒絕、中文 IME 曾通過                                                                                                                                                                                                                                                                                                                                                                | 修正後真 PDF worker／畫布、中文 IME、binary／ACL 均通過。5 MiB+1 與32 MiB PDF hash一致、超限／錯誤PDF拒絕通過。dev CSP另外修正並有7項前端測試 |
| G2               | 正式 host 檔案命令、權限、共用服務與視窗撤銷已接入。完成 commands／state／services／platform 責任拆分，測試集中於 tests/unit。108 項原生測試、release 及 all-targets／all-features 編譯檢查通過。2026-10-19 真實 Windows WebView2 E2E 通過新文件、中文／emoji 編輯、頁面往返與取消原生確認後保留未儲存內容。收據 `g2-workbench-e2e.json` 對應 release SHA256 `285af77734ac09e9f223e93561c6cdc390ef7d1d33bb068e5bc2865b1f490de6` | lint、完整工作區 CRUD／監看及其餘 UI 驗收待完成                                                                                               |
| G3               | 真實檔案快照、取消、依賴變更、未儲存 overlay、PDF／SyncTeX 結果消費與 panic 租約清理共 8 項回歸通過。3 項原生測試通過，包含真實 Tectonic 暖編譯、程序排空與暫存清理                                                                                                                                                                                                                                                             | 原始雙大串流 helper 逾時仍待根因修正。正式編譯服務／前端接線及完整引擎驗收待完成                                                              |
| G4               | ConPTY 後端先前 56 項組合通過。退出事件修正後前端 7 項及選定服務層原生回歸 13 項通過，涵蓋退出欄位、子程序樹及故障清理                                                                                                                                                                                                                                                                                                          | Git／終端機 host adapter 待接。Git 候選將 32 MiB 縮成 8 MiB 已退回修正，禁止降級                                                              |
| G5               | 官方 rmcp 3.5.1 typed-only 審查夾具 41 項測試通過，包含 SDK client、真 HTTP 共用狀態、Host／Origin／body limit 與取消清理。stdio 執行檔可編譯                                                                                                                                                                                                                                                                                   | 真實 stdio 子程序互通、正式 host／編輯器接線、Inspector／llama.cpp、Typst／Draft 待完成。stdio 的 0 項單元測試不作互通證據                    |
| G6–G7            | 規格與階段驗收已列明                                                                                                                                                                                                                                                                                                                                                                                                            | 尚未完成實作與驗收                                                                                                                            |

完整 API 見 [CONTRACT](FRONTEND_CONTRACTS.md)，包含搜尋、檔案復原、格式化、SyncTeX、自訂編譯與十二個 MCP 工具。前端依官方 `isTauri()` 選擇 adapter。檔案命令已註冊，編譯等其餘入口及完整端到端驗收尚未完成。

基線 release hash 與啟動證據見 [g1-verification](tauri/g1-verification.json)。後續收據在 `.verification-artifacts/tauri/` 的 engine-runtime、pty-runtime 與 owner correction 檔案。來源台帳 [tauri-origin](../licensing/tauri-origin.json) 需隨最終原型驗收更新，不能用舊 hash 代表新 patch。完整遷移尚未完成。

## 來源與依據

[授權範圍](../../LICENSING.md) · [來源審查](../licensing/SOURCE_REVIEW.md) · [前端台帳](../licensing/frontend-origin.json) · [前端狀態](FRONTEND_REWRITE_STATUS.md) · [使用限制](../user/KNOWN_LIMITATIONS.md)。

## 2026-10-21 整合補充

CI 分開回報 Markdown、Svelte／TypeScript、Rust format、Clippy、Rust tests、契約、授權／供應鏈、建置、原生 E2E 與安裝包驗證。CD 使用同一份已驗證 EXE，分開簽主程式、打包、簽安裝包及發布核准，不重建另一份 EXE。

| 範圍               | 獨立 CI 工作                                                         |
| ------------------ | -------------------------------------------------------------------- |
| Markdown           | 維護中文件的 Prettier 檢查。排除歷史封存、第三方與授權原文           |
| Svelte／TypeScript | 型別檢查、前端單元測試、前端建置各自回報                             |
| 共用契約           | 契約與文件核心的測試分開回報                                         |
| Rust               | rustfmt、Clippy、測試各自回報。desktop 與 document-core 分別顯示結果 |
| Windows App        | 建置一次 EXE。原生 E2E 與打包使用同一份已驗證產物                    |

Markdown 與 Rust 格式工作不建置 App。原生 E2E 必須等待必要品質檢查，不因拆分工作而漏掉驗收條件。

文件核心 Rust 遷移須保留原始 bytes、BOM／混合換行、UTF-16 座標、版本與交易原子性、Raw 語法保存及既有視覺編輯功能。同 bytes／預算的純解析比較已驗證節點種類、名稱、UTF-16 範圍、內容範圍、樹結構與問題一致。中位數：50 KiB TS 3.51 ms／Rust 1.89 ms。200 KiB 11.27 ms／7.18 ms。1 MiB 在擴大預算後完整解析為 58.14 ms／35.82 ms。預設預算的 1 MiB 會整份退回 Raw，不列為完整解析效能。UI、WASM 與 IPC 仍須另外量測。

文件核心遷移完成並通過整合與 E2E 後，先 commit／push Rust 遷移成果，再以獨立 commit 刪除 `packages/document-core` 並 push。遠端同步刪除。前端尚未改用 Rust 核心前保留現行 TS 模組。

歷史 codebase 刪除是獨立交付項：新版功能與原生 E2E、安裝流程驗收通過後，刪除 `history/texpile-editor`、`electron` 及僅供舊版使用的套件、測試、建置指令、CI 和依賴，commit／push 同步遠端。必要第三方授權與來源紀錄保留。搬入 `history` 不計入刪除完成。

發布時現行 codebase 與發行包須移除 AGPL-3.0 程式與依賴。舊碼刪除後，更新根目錄 `LICENSE`、`package.json`／鎖檔、`LICENSING.md`、介面說明、建置工具與授權台帳。自有碼統一 Apache-2.0。AGPL 第三方元件須替換或移除，其他第三方授權與 notices 保留。驗收以來源清單、依賴授權及實際安裝包內容為準。

## 2026-10-23 發布與資源驗收

目標時間為 2026-10-23 20:00（Asia/Taipei）。優先完成發布阻擋，既有功能與驗收條件不縮減。MCP 延至後續版本。

本版優先：LaTeX／Draft 正常流程、過期定位修正、授權確認、正式 CI/CD、安裝及主要功能 E2E、歷史程式清理。低頻長 Git 訊息的錯誤分類、未使用的 CSS 跳脫檔名、預發布標籤相容性及額外拆檔美化列後續版本。惡意輸入資源上限保留。建置來源對應不足須核實實際授權，不將工具的對應缺漏直接視為授權不相容。

正則與解析流程須避免 ReDoS、OOM、stack overflow：輸入與輸出有界，不將全部匹配結果展開成函式參數。測試涵蓋超長拒絕、重複未閉合前綴、大量匹配及深層巢狀。在獨立子程序設定時間、heap 與 stack 上限，失敗不能卡住 CI。逾時與記憶體上限用於測試隔離，實作仍須從掃描與配置方式修正。

資源回歸分別放在 `tests/scripts/licensing` 與 `crates/document-core/tests`，納入對應授權工具及 WASM CI 工作，不與安裝包 E2E 混成單一工作。
