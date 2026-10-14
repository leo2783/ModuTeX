# 前端授權閉包與來源獨立審查報告 (2026-10-08)

本報告依據 [`FRONTEND_REWRITE_PLAN.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/architecture/FRONTEND_REWRITE_PLAN.md) 第 7 節 F5 階段驗收標準與第 8 節完成定義，針對 `apps/frontend` 及其依賴模組進行原創性、依賴閉包、資產來源與授權完整性審查。

---

## 1. 審查依據與受檢文件

### 1.1 實際讀取並核對之專案文件
為確保嚴格遵守審查規範，本次審查僅透過精確檢視工具（`view_file`）完整讀取並核對以下文件：
1. [`docs/architecture/FRONTEND_REWRITE_PLAN.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/architecture/FRONTEND_REWRITE_PLAN.md)：前端重寫架構、F5 授權驗收標準與授權邊界規範。
2. [`docs/licensing/frontend-origin.json`](file:///C:/Users/qet63/Documents/ModuTex/docs/licensing/frontend-origin.json)：原創前端模組、測試 fixture 與第三方採用清單之來源 manifest。
3. [`docs/licensing/FRONTEND_FONT_SOURCE_EVIDENCE_2026-10-08.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/licensing/FRONTEND_FONT_SOURCE_EVIDENCE_2026-10-08.md)：MathLive 20 個 KaTeX WOFF2 字型檔之 Git blob 比對與授權限制紀錄。
4. [`apps/frontend/THIRD_PARTY_NOTICES.md`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/THIRD_PARTY_NOTICES.md)：目前前端收錄之 16 個第三方套件授權條款複本。
5. [`scripts/licensing/frontend-artifacts.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs)：生產產物（dist）、source map、套件 manifest 與授權文件收集器。
6. [`scripts/licensing/frontend-asset-origins.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-asset-origins.mjs)：已分發二進位字型、PDF.js worker 與 CSS 來源標記比對工具。
7. [`scripts/licensing/frontend-boundaries.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-boundaries.mjs)：靜態原始碼、AST 與路徑引用邊界檢驗器。
8. [`scripts/licensing/verify-frontend-origin.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/verify-frontend-origin.mjs)：綜合驗證邊界、產物與資產授權之門檻檢驗腳本。
9. [`apps/frontend/package.json`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/package.json)：本專案前端應用 workspace（`modutex-frontend`，私有 UNLICENSED）。
10. [`packages/document-core/package.json`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/package.json)：本專案核心套件 workspace（`@modutex/document-core`，私有 UNLICENSED）。
11. [`packages/frontend-contracts/package.json`](file:///C:/Users/qet63/Documents/ModuTex/packages/frontend-contracts/package.json)：本專案契約套件 workspace（`@modutex/frontend-contracts`，私有 UNLICENSED）。

### 1.2 基準快照情境（2026-10-08 01:43 PDF 變更後重建）
依根目錄實際建置快照數據（作為現況基準，非獨立證明）：
- Emitted Artifacts：60 個生產建置檔案。
- Mapped Sources：111 個經 source map 映射之原始碼檔案。
- Packages in Bundle：19 個涉入套件（精確構成：16 個第三方套件 + 3 個本專案自建模組 workspace）。
- Source Files & References：51 個原始碼檔案，174 處引用，靜態邊界掃描違規（static boundary findings）為 0。
- 待決項目：3 個套件缺少獨立授權文件（為 3 個本專案自建 workspace）、1 個遺失映射原始碼（`node_modules/pdfjs-dist/build/pdf.worker.mjs?url` 於 `index-17vyQt_D.js.map`）、28 個素材待審查（assets review required）、1 個預建 JavaScript worker 缺乏 source map（`pdf.worker.mjs`）、19 個套件審查待獨立確認（pending package reviews）。

### 1.3 未檢視範圍聲明
- 本次審查未執行 shell 命令、未讀取 Git 提交歷史或網路遠端資料，亦未檢閱根目錄全部 60 個產物之個別完整位元組。
- `.verification-artifacts/frontend-origin/artifacts.json` 以及 Electron 主程序具體程式碼本次未直接載入。
- 本報告之結論受限於上述已知快照與受檢文件範圍，後續若產物或原始碼重新建置／變更，必須重新執行複查。

---

## 2. 已確認事實 (Confirmed Facts)

1. **靜態邊界掃描 0 Findings 為局部靜態證據，非獨立原創性判定**：
   - 依據 [`scripts/licensing/frontend-boundaries.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-boundaries.mjs)，51 個原始碼檔案與 174 處引用未發現指向舊版 `apps/editor-legacy/`、`apps/site-legacy` 或外部私有模組的靜態 AST/alias 引用。
   - 此掃描僅證明「無靜態引用違規」，**不代表獨立著作權原創性已獲法律層面的判定（not independent originality clearance）**。
2. **非嚴格乾淨室（No Strict Clean-Room Independence）**：
   - [`FRONTEND_REWRITE_PLAN.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/architecture/FRONTEND_REWRITE_PLAN.md) 與 [`frontend-origin.json`](file:///C:/Users/qet63/Documents/ModuTex/docs/licensing/frontend-origin.json) 明確載明：參與者曾接觸舊碼，實作依據為功能規格與公開 API，「本方案不冒稱具嚴格隔離證據的 clean-room」。
3. **19 個涉入套件結構：16 個第三方套件已全數收錄於聲明，3 個缺少者為自建 Workspace**：
   - 產物中的 19 個套件包含：
     - **16 個第三方開源套件**：全部 16 個套件之授權條款全文已完整收錄於 [`apps/frontend/THIRD_PARTY_NOTICES.md`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/THIRD_PARTY_NOTICES.md)。第三方授權文字**並無缺漏**。
     - **3 個本專案自建 Workspace**：`apps/frontend` (`modutex-frontend`)、`packages/document-core` (`@modutex/document-core`)、`packages/frontend-contracts` (`@modutex/frontend-contracts`)。
   - 收集器報告的「3 missing license documents」為此 3 個自建 workspace 目錄內無 standalone LICENSE 檔案（目前皆宣告為 `"license": "UNLICENSED"`、`"private": true`），**並非第三方授權遺漏**。
4. **本專案套件維持 UNLICENSED，桌面維持 AGPL，未獲 Apache 授權發布**：
   - 3 個自建模組目前皆為私有且處於審查待決狀態（`pending independent provenance review`）。
   - 桌面後端宿主（Electron 主程序、preload、IPC 適配器）與已發布的 0.1.0 維持 AGPL-3.0 義務。
   - **嚴禁斷言新模組已獲得 Apache-2.0 clearance**。
5. **PDF.js Worker 為預建 JavaScript 腳本（非二進位碼），無獨立 Source Map**：
   - `pdf.worker.mjs` 為 JavaScript 腳本（非編譯後的機器二進位碼），經 hash 比對與 `pdfjs-dist@6.2.108` 預建檔一致並具備 `@licstart/@licend`；但其在發行端無 source map，亦非由本專案建置管道自原始碼構建。
6. **MathLive 字型 Blob 一致性僅證明 Bytes，非授權清理（No Assumed OFL）**：
   - 20 個 KaTeX `.woff2` 字型檔與 MathLive commit `b0a4b033` 之 blob hash 吻合，僅證明檔案位元組來源相同。
   - MathLive 套件宣告之 MIT 無法自動推定涵蓋字型。
   - **不得假設字型必然採用 OFL**：字型的具體上游權利與授權條件仍未解決（exact font rights remain unresolved）。二進位來源一致性不等於合法授權。

---

## 3. 未知與待核實項目 (Unknowns & Unverified Items)

1. **遺失映射原始碼之實體路徑與產物關聯**：
   - Source map 檔案 `index-17vyQt_D.js.map` 中所引用的 `node_modules/pdfjs-dist/build/pdf.worker.mjs?url` 缺少對應磁碟實體來源，需追蹤該底層檔案路徑與分發產物雜湊（emitted resource hash）。
2. **MathLive KaTeX 字型之確實權利與授權文書**：
   - MathLive 內嵌 KaTeX 字型之上游真實授權文件、著作權宣告與商標/保留字型名稱限制尚未取得確切憑據。
3. **28 個待審查資產（Assets Review Required）之最終合法性**：
   - 生產產物中提取之 CSS、字型與靜態素材尚未建立完整的版權清查與使用權利鏈。
4. **19 個涉入套件之獨立來源簽核**：
   - 收集器將所有套件標註為 `pending-independent-review`，尚未由法務或授權審查人完成最終獨立簽核。

---

## 4. 阻擋問題與閉包缺口 (Blocking Gaps)

| 編號 | 阻擋項目 | 嚴重程度 | 現象與證據邊界 |
| :--- | :--- | :--- | :--- |
| **GAP-01** | MathLive KaTeX 字型權利未決 | **高 (Blocker)** | 20 個 WOFF2 字型檔僅有 byte match，無明確字型授權文本；不能假設 OFL，亦不得由 package MIT 概括。 |
| **GAP-02** | 遺失 Source Map 引用追蹤 | **高 (Blocker)** | `index-17vyQt_D.js.map` 引用 `node_modules/pdfjs-dist/build/pdf.worker.mjs?url` 失敗；需追蹤底層檔案與 emitted resource hash，**嚴禁採用白名單/忽略過濾規避**。 |
| **GAP-03** | 預建 JavaScript Worker 缺乏 Source Map | **中 (Gap)** | `pdf.worker.mjs` 為預建 JavaScript 產物，缺乏 source map，影響分發產物調試審計鏈與完整性映射。 |
| **GAP-04** | 自建模組 UNLICENSED 待審查狀態與全體 AGPL 約束 | **政策阻擋** | 3 個自建 workspace 維持私有 UNLICENSED 且待審查；桌面維持 AGPL，不可宣稱新模組或整體應用已獲 Apache-2.0 clearance。 |
| **GAP-05** | 未完成之獨立套件與資產審查閉包 | **中 (Gap)** | 19 個套件與 28 個分發資產仍處於 `pending-independent-review` 與 `asset-origin-review-required`。 |

---

## 5. 解決阻擋問題的精確處置行動 (Exact Actions to Resolve)

1. **行動 1：查證 MathLive KaTeX 字型之確切授權文本 (針對 GAP-01)**
   - 追查 MathLive 0.110.0 所附帶 20 個 KaTeX 字型檔的上游真實授權文本與版權宣告（不預設其為 OFL），查明是否有獨立授權通知義務，並將確認後之授權文本與版權歸屬補入聲明文件。
2. **行動 2：實體追蹤遺失之 Source Map 引用與產物雜湊 (針對 GAP-02)**
   - 調查 `index-17vyQt_D.js.map` 中 `node_modules/pdfjs-dist/build/pdf.worker.mjs?url` 的實際對應路徑與 Vite build bundle 的資源輸出雜湊。
   - 確實驗證該 URL import 所指涉之底層實體檔案與 emitted worker 之間的關聯，**嚴格禁止以白名單、過濾規則或忽略機制規避此錯誤**。
3. **行動 3：補全 PDF.js Worker 審計鏈 (針對 GAP-03)**
   - 記錄預建 `pdf.worker.mjs` 來自 `pdfjs-dist@6.2.108` 官方發行版本之完整來源路徑、SHA-256 雜湊與 Apache-2.0 Notice 標頭驗證紀錄，說明其作為預建 JavaScript 模組之審計依據。
4. **行動 4：維持自建模組 UNLICENSED 狀態與 AGPL 宿主邊界說明 (針對 GAP-04)**
   - 維持 `modutex-frontend`、`@modutex/document-core`、`@modutex/frontend-contracts` 在通過獨立審查前為私有 UNLICENSED 狀態；
   - 嚴禁於文件或中介資料中提前宣稱 Apache-2.0 授權，並在整體發行規劃中維持 Electron 宿主與桌面分發物的 AGPL-3.0 義務。
5. **行動 5：執行獨立來源與資產審查閉包 (針對 GAP-05)**
   - 對 19 個套件與 28 個分發資產逐一進行來源判定與專利/著作權審查，在確認符合規範後，由獨立審查人更新 `frontend-origin.json` 與審查資料庫之審查標記。

---

## 6. 審查結論 (Verdict)

- **審查判定**：**未通過（Not Cleared / Review Not Approved）**
- **判定理由**：
  靜態邊界掃描 0 findings 僅為局部靜態證據，不構成獨立原創性判定；MathLive 字型確切權利仍未解決且不能假設為 OFL；`index-17vyQt_D.js.map` 中存在遺失的 `pdf.worker.mjs?url` 映射引用且須實體追蹤；3 個自建模組仍處於私有 UNLICENSED 審查待決狀態且整體桌面應用受 AGPL 拘束（未獲 Apache clearance）。在上述未決阻擋問題依精確行動完成處置前，**審查維持 Not Approved，不得宣稱版權已合法清理**。
