# Svelte 前端原創重寫計畫

> 歷史設計提案。0.2.0 已正式發布；原規劃的 `editor-legacy`／`site-legacy` 搬移已取消，main 保留 `apps/texpile-editor` 與 `landing`。現行狀態與目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)及[儲存庫目錄](../reference/REPOSITORY_LAYOUT.md)為準，以下日期與待辦反映當時規劃。

分支：`refactor/frontend`。基準：`1351c29b7bcf3ca445b0d2c9af2b209179bc6ddd`。使用者已核准實作，採先圖片稿、再程式流程；進度見 [實作清單](FRONTEND_REWRITE_STATUS.md)。保留既有授權邊界與已發布的 0.1.0。

版本歸屬：此計畫的前端重寫為 0.2.0（尚未發布）；0.1.0 已於 2026-10-06 發布。CHANGELOG 分開記錄，不回溯改寫既有版本功能。

## 1. 目標與授權邊界

建立以 Svelte 5、TypeScript、Vite 實作的原創文件工作台，逐步替換 Texpile 衍生的前端。新版原創模組以 Apache-2.0 為目標；使用者已確認持有 ModuTeX 原創碼的改授權權限，此權利不涵蓋上游與第三方。

完成「新版前端自身不含 AGPL 衍生實作」與完成「整個桌面 App 不受 AGPL 約束」是兩項驗收。現有 Electron 主程序、IPC、檔案服務與部分共用契約尚未替換；新版前端與它們整合時，整體分發物仍須依實際組合維持原有義務。目錄、檔名、行程或 UI 外觀不同，都不足以單獨證明授權切割。依據：[現有授權盤點](../licensing/AGPL_APACHE_INVENTORY_2026-10-04.md)、[GNU 授權 FAQ](https://www.gnu.org/licenses/gpl-faq.en.html)、[Apache-2.0 條款](https://www.apache.org/licenses/LICENSE-2.0)。這是工程方案，獨立作品與組合授權的最終判斷仍需專業審查。

| 範圍                                       | 本階段處理                                     | 不得採用的方法                                      |
| ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------- |
| 頁面、元件、樣式、狀態、語系               | 按使用需求重新設計與實作                       | 複製既有檔案，再改名稱、排版或標頭                  |
| LaTeX parser、schema、serializer、編輯指令 | 依獨立功能規格與允許的第三方 API 重建          | 把舊 converter 拆成小檔或逐行翻譯                   |
| PDF、公式、原始碼編輯                      | 直接使用經授權審查的第三方公開 API，重寫適配層 | 沿用 Texpile 的 viewer、MathLive 或 CodeMirror glue |
| assets、字型、圖示、模板、測試資料         | 逐項確認來源；自製或使用明確允許的素材         | 無標頭即視為原創；整批搬用舊 fixture                |
| 桌面後端、MCP、Typst、Draft、圖形服務      | 維持現有授權，另列後端替換階段                 | 因前端完成就改根 LICENSE 或 source offer            |
| 已發布 0.1.0                               | 保留對應來源與原授權                           | 回溯宣稱舊版已轉 Apache 或撤銷既有使用者權利        |

實作來源以功能規格、LaTeX 格式文件、第三方官方文件與自行建立的 fixture 為準。舊碼只供盤點與既有版本維護，不作新碼範本。審查者須記錄來源與相似性疑點；相似度工具只能提供線索。參與者曾接觸舊碼，本方案不冒稱具嚴格隔離證據的 clean-room；若需要該級別證據，另安排未讀舊碼的實作者與規格審查流程。

## 2. 本輪目錄整理

| 原路徑                      | 新路徑                            | 用途                                       |
| --------------------------- | --------------------------------- | ------------------------------------------ |
| `apps/texpile-editor/`      | `apps/editor-legacy/`             | 可運行的既有編輯器、測試與素材；保留原授權 |
| `landing/`                  | `apps/site-legacy/`               | 既有 SvelteKit 網站；保留原授權            |
| `docs/INSTALLATION.md`      | `docs/user/INSTALLATION.md`       | 安裝與啟動                                 |
| `docs/KNOWN_LIMITATIONS.md` | `docs/user/KNOWN_LIMITATIONS.md`  | 已發布功能限制                             |
| `docs/SOURCE_ORIGIN.md`     | `docs/reference/SOURCE_ORIGIN.md` | 0.1.0 對應來源                             |

根 workspaces 收斂為 `packages/*`、`apps/*`。既有 workspace 名稱 `modutex-editor`、`modutex-landing` 不變，避免更動使用者啟動命令。只修改 lock 的 workspace 路徑與連結，不升級任何第三方依賴。建置、Electron 測試、vendor fixture、語系插件、文件連結、Git attributes 與 formatter 路徑同步更新。

`electron/`、`build/`、`vendor/`、`packages/`、`scripts/` 保持原位置。它們已有打包與完整性邊界；本輪沒有透過改位置取得去授權效果，不為了目錄外觀同步重構主程序。原始素材、license、notice 與 fixture 不刪除。舊版編輯器內部也不重排，以免新增與新版無關的回歸。

### 整理後的現況

```text
ModuTex/
├─ apps/
│  ├─ editor-legacy/     # 目前桌面前端，仍是 AGPL 衍生程式
│  └─ site-legacy/       # 目前網站，來源與素材另行替換
├─ electron/            # 目前桌面後端，授權不變
├─ packages/            # 共用契約／Typst；不可直接假設都可重用
├─ build/               # Electron 打包圖示、安裝資源
├─ scripts/             # 建置、驗證、vendor、打包
├─ vendor/              # 固定第三方檔案與 notices
├─ docs/
│  ├─ architecture/     # 此計畫
│  ├─ licensing/        # 來源盤點
│  ├─ reference/        # 對應來源、專案結構
│  ├─ user/             # 安裝、限制
│  └─ vendor/           # 第三方完整性與離線驗證
└─ LICENSES/            # 個別授權全文
```

### 新版目錄：核准實作後建立

```text
apps/frontend/                  # 新 workspace：modutex-frontend
├─ src/
│  ├─ app/                      # App、hash routes、生命週期
│  ├─ pages/                    # Home、Workbench、Settings、Help
│  ├─ features/
│  │  ├─ files/                 # 文件清單、開啟／儲存／衝突
│  │  ├─ visual-editor/         # 原創 ProseMirror schema／commands
│  │  ├─ source-editor/         # 原創 CodeMirror 適配
│  │  ├─ tables/               # 視覺表格與行列工具
│  │  ├─ math/                 # 公式板塊、矩陣
│  │  ├─ pdf/                  # 原創 PDF.js 適配
│  │  └─ compile/              # 編譯狀態、診斷、取消
│  ├─ components/              # Button、Dialog、SplitPane 等共用 UI
│  ├─ platform/                # DesktopPort 與平台適配；不散落 raw IPC
│  ├─ state/                   # 每個工作區的狀態與資料版本
│  ├─ i18n/                    # 自行撰寫 en／zh-Hant 文案
│  └─ styles/                  # tokens、base、字型宣告
├─ tests/                      # 新 fixture、單元／元件／桌面整合
├─ LICENSE                     # 新模組審查通過後採 Apache-2.0
└─ THIRD_PARTY_NOTICES.md
packages/document-core/         # 純 TS：原創 lossless source model／patches
packages/frontend-contracts/    # 原創介面與 runtime schema；不複製舊 contracts
docs/licensing/frontend-origin.json  # 新碼與素材來源 manifest
```

不用空 workspace 或假 package 撐目錄；新增實作時才建立 manifest、lock entries 與指令。legacy 不得成為新 workspace 的 import、build alias、CSS、字型或 fixture 來源。

## 3. 架構與資料流

Svelte 負責 UI 與工作區狀態；document-core 負責保真來源與增量修改；平台介面處理檔案與編譯。頁面不得直接操作 shell、絕對路徑或任意 IPC。保留一層必要適配，不建立多層單一實作代理。

```text
Svelte pages ── features ── document-core（原創 TS）
                   │          ├─ source buffer + span anchors
                   │          ├─ 原創 parser／允許的第三方 parser API
                   │          └─ transaction → 最小 source patches
                   │
                   └─ DesktopPort（原創契約 + runtime validation）
                         ├─ 檔案：讀、寫、監看、衝突
                         └─ 編譯：run、cancel、診斷、PDF bytes

過渡桌面適配 → 現有 Electron host（仍 AGPL，單獨審查）
後續原創 host → 同一功能契約（不在本階段實作）
```

保真模型以原始 bytes、BOM、EOL、註解、空白與未知語法為基準。未修改的文件不經重新列印；可辨識節點只修改對應範圍；未知 macro／環境保留 Raw LaTeX。visual／source 共用單一文件版本，切換前完成 pending transaction；不得各存一份全文並互相覆蓋。

每次擊鍵只更新受影響節點與 dirty 範圍，儲存／編譯才產生所需來源。大範圍 parse 進 worker，舊結果帶文件版本、逾期即丟棄。這是必要的資料一致性檢查，不擴張成多層租約系統。PDF worker、editor view、監看訂閱與編譯行程在切文件／關工作區時釋放。

新前端可以用獨立瀏覽器建置驗證來源與編輯行為；桌面開檔／保存／編譯仍須接真實 host 驗證，不以測試 stub 代替功能。過渡適配與既有 host 的組合不列為「整個 App 已去 AGPL」。

## 4. 第三方依賴策略

保留 Svelte，先不遷移 Tauri，也不更換 package manager。候選版本來自本次已安裝 manifest；下表僅是來源線索，採用前仍需 LICENSE、NOTICE、transitive／bundle closure 審查。

| 候選                | 本機版本／授權線索    | 使用範圍                                  |
| ------------------- | --------------------- | ----------------------------------------- |
| Svelte              | `5.56.9`／MIT         | 元件與 runes                              |
| Vite                | `8.2.1`／MIT          | 前端 build／dev                           |
| ProseMirror model   | `1.25.9`／MIT         | 編輯器基礎，schema／plugins 全部新寫      |
| CodeMirror state    | `6.7.0`／MIT          | 原始碼編輯，extensions 全部新寫           |
| MathLive            | `0.110.0`／MIT        | 公式輸入，不沿用舊橋接或快捷鍵設定        |
| PDF.js              | `6.2.108`／Apache-2.0 | PDF 顯示，不沿用上游應用適配層            |
| unified-latex parse | `1.8.4`／MIT          | 解析候選；保真 patch model 另行實作與驗證 |

新版樣式採原創 CSS tokens 與 Svelte scoped CSS，不沿用舊 theme 或 component library 的應用設計。圖示採自製或經確認的 permissive icon；字型先使用系統 UI 字型。第三方套件不改標為本專案 Apache。新增 dependencies 固定版本、更新唯一 lockfile，維持 install policy、簽章與 High／Critical audit 門檻。

## 5. 視覺規格

方向沿用已確認的文件工作台：文件與 PDF 是主要內容，設定按需展開。以下是供確認的概念稿，不是已完成畫面；不複製 Texpile、Overleaf 或 Word 的元件、素材與細部布局。

| Token   | 淺色提案  | 深色提案  | 用途           |
| ------- | --------- | --------- | -------------- |
| canvas  | `#F4F3EF` | `#202428` | 工作台底色     |
| surface | `#FFFFFF` | `#292E33` | 工具列、面板   |
| text    | `#24292E` | `#E8EBED` | 正文           |
| muted   | `#5D6670` | `#AFB8C0` | 次要標籤       |
| border  | `#CDD2D7` | `#49525B` | 邊界           |
| accent  | `#3D617B` | `#9BBAD1` | 選取、焦點     |
| error   | `#A33232` | `#EF9696` | 失敗／危險操作 |

不使用螢光色、漸層大面積背景或裝飾性指標。間距採 4／8／12／16／24 px；工具列 40–44 px；一般操作目標至少 32 px，觸控至少 44 px。色值與頁面密度待概念稿確認，再做對比檢查；不能預先宣稱 a11y 已通過。

### A. 首頁 `#/`

```text
+-----------------------------------------------------------------------+
| ModuTeX                                         Language     Settings |
|-----------------------------------------------------------------------|
| Open folder     Open .tex     New document                             |
|                                                                       |
| Recent documents                                                      |
|  Thesis / main.tex            Yesterday                       Open     |
|  Paper / results.tex          3 days ago                      Open     |
|                                                                       |
| Start from a template                                                 |
|  Article       Report       Blank                                     |
|-----------------------------------------------------------------------|
| Help                                               Version / License  |
+-----------------------------------------------------------------------+
```

以文件任務為主，不顯示使用次數或完成百分比。沒有最近文件時顯示一行提示；失效路徑保留清單項目並提供移除，不默默建立新文件。模板內容自行撰寫與記錄來源。

### B. 文件工作台 `#/workspace`

```text
+-----------------------------------------------------------------------+
| Paper / main.tex      Saved                Visual  Source  Split       |
|-----------------------------------------------------------------------|
| Insert   Text   Equation   Table                  Compile    PDF       |
|-------------+------------------------------------+--------------------|
| Files       | Document                           | PDF                |
| main.tex    |                                    |  Page 1 / 8        |
| results.tex |  Methods                           |  [-] 100% [+]      |
| images/     |                                    |                    |
|-------------|  Editable text and content blocks  |  Compiled page     |
| Outline     |                                    |                    |
|  Methods    |  Selected block exposes tools      |                    |
|  Results    |                                    |                    |
|-------------+------------------------------------+--------------------|
| Compile succeeded       Problems [0]       Log           UTF-8 / LF    |
+-----------------------------------------------------------------------+
```

Files／Outline 可切換，避免同時塞滿側欄；PDF 可收起。全域設定不放在正文工具列。視覺章節折疊、Draw.io、Mermaid、協作、Typst／Draft 不作本階段承諾，也不擺可點但無效的按鈕。

### C. 原始碼與分割模式：工作台內狀態

```text
+-----------------------------------------------------------------------+
| main.tex   Modified                         Visual  Source  [Split]    |
|-------------+----------------------------+----------------------------|
| Files       | Source                     | Visual                     |
| main.tex    |  1  \documentclass{article} |                            |
|             |  2  \begin{document}       | Methods                    |
|             |  3  \section{Methods}      |                            |
|             |  4  Text...                | Text...                    |
|             |                            | [Raw LaTeX: custom macro]  |
|-------------+----------------------------+----------------------------|
| Ln 4, Col 8        UTF-8 / LF             Unsupported syntax retained |
+-----------------------------------------------------------------------+
```

未知語法不丟棄，也不自動加入套件。切換保留游標、undo 與未儲存變更；格式化為明確使用者動作。原始碼 folding 由自行設定的 CodeMirror extensions 提供。

### D. PDF 與編譯診斷：工作台內狀態

```text
+-----------------------------------------------------------------------+
| main.tex                                           Cancel compilation |
|---------------------------------------+-------------------------------|
| Document                              | PDF: previous successful run  |
|                                       |                               |
|                                       |  Previous page remains visible|
|---------------------------------------+-------------------------------|
| Problems [1]    Log                                                   |
| main.tex:20    Undefined environment tabularx     Go to source         |
| Cache miss     Downloading TeX resources from configured official host |
+-----------------------------------------------------------------------+
```

編譯前保存當前版本；PDF 綁定編譯的文件版本，內容更新後標示 stale。失敗不清空上次成功 PDF；錯誤可定位行列，log 有大小上限。保留既定 Tectonic 官方資源來源，不增加逐次詢問，也不開放任意 URL 或 shell flags。套件新增必須有來源片段預覽與確認。

### E. 表格面板：選中表格時展開

```text
+-----------------------------------------------------------------------+
| Table      Caption: [None v]     Style: [Three-line v]         Close    |
| Header row [x]   Width [80] %   +Row  +Column   Borders   Delete        |
|                                                                       |
|                   | 40% |           | 35% |           | 25% |          |
|              +----------------+----------------+----------------+     |
|  + above     | Method         | Score          | Notes          |     |
|              +----------------+----------------+----------------+     |
|              | Baseline       | 0.82           |                | +   |
|  + below     | Proposed       | 0.89           |                |     |
|              +----------------+----------------+----------------+     |
|                                                                       |
| Caption [.........................................................]   |
+-----------------------------------------------------------------------+
```

提供三線、全框線、僅橫線；首列預設為表頭，可取消。caption 可無／上／下；隱藏 caption 不刪除已輸入文字。欄寬可拖曳或輸入、歸一到表格寬度；新增行列在相鄰邊界與工具列都可操作。虛線橫線表另列後續項目，不搬用舊缺陷。

三線表可使用 booktabs；不加入時使用三條 `\hline` 並標明等粗線。需要 tabularx／array 等套件時先顯示 preamble 變更；未加入時只生成相容的既有格式。不能在缺套件的文件輸出不可編譯環境。未知欄位規格進 Raw LaTeX，不強制轉成 X 欄。

### F. 公式與矩陣面板：編輯器內板塊

```text
+-----------------------------------------------------------------------+
| Equation    Inline [ ]    Display [x]                        Close     |
|                                                                       |
|  +-----------------------------------------------------------------+  |
|  |  Type an equation...                                            |  |
|  +-----------------------------------------------------------------+  |
|  Fraction    Root    Script    Integral    Matrix                       |
|                                                                       |
|  Matrix: Rows [3]   Columns [3]   Brackets [( ) v]                       |
|           +----------+----------+----------+                           |
|           | 1        | 0        | 0        |                           |
|           | 0        | 1        | 0        |                           |
|           | 0        | 0        | 1        |                           |
|           +----------+----------+----------+                           |
|  LaTeX source [.....................................................]  |
+-----------------------------------------------------------------------+
```

矩陣各維限制 1–10，支援 n×n 快速設定與非方陣。縮小尺寸前確認非空格資料，不能默默刪除。MathLive 數學鍵盤與正文快捷鍵分開；輸入直接更新同一 transaction，關閉不遺失已編輯內容。Raw LaTeX 可隨時查看。

### G. 設定 `#/settings`

```text
+-----------------------------------------------------------------------+
| Settings                                                  Back        |
|--------------------+--------------------------------------------------|
| General            | Language             [English v]                 |
| Editor             | Appearance           [System v]                  |
| Compilation        | Font size            [14]                        |
| Shortcuts          | Autosave             [On]                        |
|                    |                                                  |
|                    | Compilation                                      |
|                    | Engine               [Managed Tectonic v]        |
|                    | Resource downloads   Fixed official source       |
|                    | Cache                Open folder / Clear...      |
|--------------------+--------------------------------------------------|
| Changes saved                                      Restore defaults...|
+-----------------------------------------------------------------------+
```

一般設定立即保存，危險操作才要求確認；清快取前說明下次需要網路。原工作區設定是否沿用、哪些 key 可重用，逐項記錄；不可 import 整個舊 settings 模組。MCP 與未知功能沒有空設定頁。

### H. 說明與授權 `#/help`

```text
+-----------------------------------------------------------------------+
| Help                                                      Back        |
|--------------------+--------------------------------------------------|
| Getting started    | Open a .tex file                                 |
| Editing            | Edit in Visual or Source mode                    |
| Tables / Equations | Compile and view the PDF                         |
| Compilation        |                                                  |
| Keyboard shortcuts | Installation and compiler troubleshooting        |
| Licenses           |                                                  |
|--------------------+--------------------------------------------------|
| About ModuTeX      | Component licenses / Third-party notices         |
+-----------------------------------------------------------------------+
```

說明必須對應可用功能；安裝指南連結開啟真實內容。授權頁分別列前端、host、third-party，而不是顯示一個概括的 Apache badge。保留來源與 notices 可讀入口。

## 6. 互動與狀態驗收

| 情境                   | 必要行為                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| empty／loading／error  | 每個頁面有任務相關訊息；失敗保留輸入與文件，不反覆顯示泛用 toast                 |
| 保存、外部修改、切文件 | 鎖定保存的文件版本，衝突提供重載／另存；不自動覆寫磁碟                           |
| 關閉面板／工作區／視窗 | Esc、關閉鈕、取消一致；保留內容；有 dirty 時提示；焦點回到原操作點               |
| 鍵盤                   | Ctrl+S 保存、Ctrl+O 開啟、編譯快捷鍵可配置；工具列可遍歷；不攔截公式必要輸入     |
| 調整工作台尺寸         | 面板可拖曳，有最小寬度；960 px 以下收起側欄，PDF 改切頁；320 px 設定／說明可重排 |
| 視覺可用性             | 淺／深色、100%／150% 縮放、繁中／英文、焦點可見與對比檢查；不靠顏色表示錯誤      |

## 7. 實作順序與所有權

不要再以每個控制項開一條長期分支。建議按三個可審查範圍集中：原創骨架／來源清單、document-core／編輯能力、桌面適配／驗收。後續 Git、PR 與發布動作另依使用者授權；本輪不建立 commit 或外部 issue。

| 階段              | 主要輸出                                                | 依賴與完成條件                                                         |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| F0 來源與設計確認 | 功能規格、素材／模組來源清單、八個畫面確認              | 明確分開新碼與 legacy；確認 Apache 範圍、版面與 tokens                 |
| F1 原創骨架       | 新 Svelte workspace、四個頁面、設計 tokens、en／zh-Hant | 不 import legacy；真實導航／焦點／設定；無假按鈕                       |
| F2 原創來源核心   | bytes／EOL／BOM、span model、patches、source mode       | 新 fixture 的無修改保存 byte-identical；未知語法保留；大型文件量測     |
| F3 視覺編輯       | 原創 schema、文字、公式、矩陣、表格、Raw LaTeX          | 已定義子集雙向保存與重開；套件相容；不能用舊 serializer 代替           |
| F4 桌面與 PDF     | 新版適配、真實保存／編譯／取消／PDF                     | 編譯失敗保留 PDF；切文件／關閉釋放資源；host 仍保留 AGPL 標示          |
| F5 前端授權驗收   | dependency closure、來源 manifest、NOTICE、正式授權範圍 | 新前端產物不包含 AGPL／來源不明實作；獨立審查，不能宣稱整體 App 已完成 |

可分工時，UI writer 擁有 `apps/frontend`；document writer 擁有新 `packages/document-core`；主代理維護原創契約、package／lock、來源審查與整合驗收。兩位 writer 不共同改 schema／contract；一項介面變更由一位 owner 負責。需要嚴格來源隔離時再調整角色與工具可見範圍。

## 8. 驗證與完成定義

本輪目錄搬移的驗證使用既有命令，不新增空 CI：`npm run verify:install-policy`、`npm run verify:vendor`、`npm run app:build`、`npm run test:electron`、既有前端 `check` 與受影響的語系／workspace／fixture 測試。fixture EOL 測試涉及 Git index，驗證未提交的搬移時使用一次性測試 index；不修改實際 staging、不放寬 byte-identical 檢查。來源清單確認搬移前後 bytes，lock 比較確保僅路徑更動。通過證據整理於 [目錄整理記錄](../reference/REPOSITORY_LAYOUT.md)。

新版指令尚未建立。F1 起再新增明確的 `modutex-frontend` build／check／test 與 `verify:frontend-origin`，沿用 CI 安全門檻；此處不把規劃中的 script 寫成已存在。來源驗證須同時檢查 import／alias、generated files、bundle chunks、CSS、字型、圖片與依賴閉包；只搜尋 AGPL 字串不算去除完成。

| 驗證             | 通過標準                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 來源與授權       | 每個新碼／素材有來源、owner、license、審查結果；AGPL／來源不明項目不能進新版前端 bundle                                    |
| 保真             | 自行建立的 LF、CRLF、BOM、註解、未知語法 fixture 無修改保存 byte-identical；局部修改不重寫無關範圍                         |
| 公式／矩陣／表格 | 真實插入、編輯、undo、保存、重開與編譯；矩陣 1–10；caption、欄寬、首列表頭與三種表格樣式                                   |
| PDF／編譯        | 實際引擎生成 PDF；cached／首次下載／新套件／錯誤／取消／stale 各有證據，不以 mock 回傳 PDF                                 |
| 安全             | runtime validation、workspace containment、HTML／SVG／URL 處理與平台權限；不因前端換框架移除原測試                         |
| 效能             | 固定 100 KB／1 MB／5 MB corpus，記錄機器與 baseline；量測 keystroke p95、切模式、保存、heap／worker 回收，設 gate 後才驗收 |
| GUI              | 使用者確認概念稿；實際桌面導航／鍵盤／繁中／英文／縮放／面板關閉可操作，無空頁或未接線操作                                 |
| 分發             | 新前端來源與產物清單相符、保留 notices；現有 AGPL host 分發義務明確，不更改舊 release                                      |

本階段完成標準：新版原創 Svelte 前端通過上述驗收，明確列出尚存 AGPL host／contracts／site 邊界。只有後續也替換或取得所有相關權利、審查完整分發閉包，才能考慮更改整體 App 的授權與 root metadata。

## 9. 待確認的設計

- [ ] 八個概念畫面、工具列密度與側欄切換方式。
- [ ] 淺／深色 token 提案；已確認不使用螢光色。
- [ ] 新前端原創模組採 Apache-2.0 的精確檔案範圍與來源審查流程。
- [ ] 首輪視覺編輯支援的 LaTeX 子集；未知語法固定保留 Raw LaTeX。
- [ ] 網站重寫是否與桌面前端同階段；本輪只整理既有網站，不將其視為已去 AGPL。

參考：[Svelte 官方文件](https://svelte.dev/docs/svelte/overview)、[Svelte 測試指南](https://svelte.dev/docs/svelte/testing)。

## 10. A 版面確認與延伸狀態

使用者於 2026-10-07 選定 A 並確認延伸方向，保留檔案／文件／PDF 三欄與頂部常用操作；新增圖片包含 TeX、視覺編輯、下方終端機、工具展開、上方工具列、版本紀錄及設定。七張延伸稿與邊界見 [A 版面延伸稿](../design/WORKBENCH_STATES.md)。不將圖片列為功能驗收。

新版前端必須接回真正 Electron host。接入後逐頁對照實際畫面的文字，移除 AI slop、重複敘述、除錯碼與開發交辦訊息；保留必要的限制、權限、錯誤原因及復原操作。未實作入口不展示，完成後再接回，不以假成功／靜態畫面代替功能。

版本紀錄新增為閱讀頁面，不恢復 updater；內容由版本文件提供。終端機目前僅確認呈現需求，正式 shell 啟動、工作區權限、輸入與取消、輸出限額、行程釋放另訂契約後實作；未接入時不得展示假成功輸出。
