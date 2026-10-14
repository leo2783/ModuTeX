# 前端生成資源追蹤機制獨立程式碼審查報告 (2026-10-08)

本報告依據 [`FRONTEND_REWRITE_PLAN.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/architecture/FRONTEND_REWRITE_PLAN.md) F5 驗收標準，針對 Root 於 [`scripts/licensing/frontend-artifacts.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs) 實作之 Vite `?url` 生成資源追蹤機制、配套測試 [`scripts/licensing/frontend-resource-maps.test.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-resource-maps.test.mjs) 及 [`scripts/licensing/frontend-asset-origins.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-asset-origins.mjs) 進行安全性與正確性獨立審查。

---

## 1. 審查範圍與核對之專案文件

本次審查透過專屬檢視工具（`view_file`）完整讀取並核對以下文件：
1. [`scripts/licensing/frontend-artifacts.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs)（含新增之 `resourceTrace` 函式）
2. [`scripts/licensing/frontend-resource-maps.test.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-resource-maps.test.mjs)（8 個測試案例全數通過之單元測試）
3. [`scripts/licensing/frontend-asset-origins.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-asset-origins.mjs)（分發資產與 worker 驗證邏輯）

### 當前快照盤點事實
- 經 Vite `?url` 追蹤修復後，Root 盤點狀態為：**112 mapped sources**、**19 packages**。
- `node_modules/pdfjs-dist/build/pdf.worker.mjs` 經追蹤確認 SHA-256 為 `1a7607f28cfbc63f0e4e0a41927c89f991e353e4f3fb4565ecfd621ac5975089`，精確對應至分發物 `apps/frontend/dist/assets/pdf.worker-CLesOks4.mjs`。
- **邊界維持**：`pdf.worker.mjs` 為無 source map 之預建 JavaScript 腳本，字型與套件獨立授權審查依然維持 `pending`，本次審查不構成法律原創性核准或假定測試具備窮盡完整性。

---

## 2. 機制正確性與安全性審查分析

### 2.1 來源容器約束（Source Containment）
- **實作位置**：[`scripts/licensing/frontend-artifacts.mjs#L110-L122`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L110-L122)
- **分析**：針對 `sources` 陣列中的 `?url` 模組，先以 `name.slice(0, -4)` 剝除 query 字尾，再透過 `path.resolve` 與 `inside(root, candidate)` 檢查，並由 `readContained` 經 `realpath` 確認位於根目錄內。能有效防止利用 `../` 或符號連結逃逸出專案倉庫。

### 2.2 精確已知包裝結構（Exact Known Wrapper Matching）
- **實作位置**：[`scripts/licensing/frontend-artifacts.mjs#L36`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L36)
- **分析**：使用正規表達式 `/^export default ["']__VITE_ASSET__[A-Za-z\d_$]+__["'];?\s*$/` 嚴格匹配 `embedded` 內容。若 wrapper 字串不符合 Vite 資產 placeholder 格式（如任意自訂代碼或一般原始碼），立即回傳 `null` 並進入拒絕路徑，避免將未知虛擬模組誤判為 asset wrapper。

### 2.3 實際 JavaScript 字面量提取與 AST 診斷（AST Parse Diagnostics & String Extraction）
- **實作位置**：[`scripts/licensing/frontend-artifacts.mjs#L39-L46`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L39-L46)
- **分析**：使用 TypeScript 編譯器 API 建立 AST（`ts.createSourceFile`），若有解析診斷錯誤（`script.parseDiagnostics.length > 0`）即拒絕處理。遍歷 AST 僅提取 `ts.isStringLiteralLike` 節點字面量。

### 2.4 雜湊位元組比對（Hash Bytes Verification）
- **實作位置**：[`scripts/licensing/frontend-artifacts.mjs#L47`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L47)、[`#L53`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L53)
- **分析**：以 `digest(sourceBytes)` 計算原始資產之 SHA-256 雜湊，並與候選產物 `digest(await readFile(emitted))` 比對，確認產物位元組未遭篡改且與來源完全一致。

### 2.5 輸出路徑容器約束（Emitted Path Containment）
- **實作位置**：[`scripts/licensing/frontend-artifacts.mjs#L50-L52`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L50-L52)
- **分析**：排除含有 `?#\` 或協定前綴（`http:`, `//`）之字串；對絕對路徑與相對路徑分別安全解析，並以 `inside(dist, emitted)` 及 `files.includes(emitted)` 雙重保證候選檔案必須是本次掃描到的 `dist` 內部常規檔案。

### 2.6 嚴格單一匹配拒絕機制（Rejection on Unknown / Mismatch / Missing / Ambiguity）
- **實作位置**：[`scripts/licensing/frontend-artifacts.mjs#L55`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L55)、[`#L127`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L127)
- **分析**：若匹配之分發產物數量不等於 1（`matched.length !== 1`，即 0 個匹配或多重歧義），回傳 `null`，並使收集器將該項推進 `unresolved`（`url-resource-unverified`），具備完整的 fail-closed 特性。

---

## 3. 潛在風險與審查發現 (Identified Risks & Edge Cases)

雖然當前實作在現有打包情境下正確且測試通過，但經深入源碼檢視，仍存在以下潛在歸屬與解析邊界風險：

| 編號 | 潛在問題 | 嚴重程度 | 行錨點 (Line Anchor) | 風險細節說明 | 建議處置行動 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **FINDING-01** | 無關字串字面量引發重複產物歧義阻擋 | **低 (潛在邊界)** | [`L42-L46`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L42-L46), [`L55`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L55) | `visit(script)` 收集腳本中**所有**字串字面量。若腳本中恰好包含與產物同路徑的無關字串，或同一檔案被不同字面量形式多次引用，會因 `Set` 去重不完全或多個字串指向同一檔案，造成 `matched.length > 1` 而觸發 `matched.length !== 1` 導致追蹤失敗。 | 在加入 `matched` 前以解析後的規格化路徑（canonical resolved path）進行去重；或將 AST 檢查限制在 import / export / URL 呼叫之參數節點。 |
| **FINDING-02** | 缺乏對非標準 Query 或多重 Query 參數之處理 | **低 (防禦性)** | [`L110-L111`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L110-L111) | 程式碼以 `name.endsWith('?url')` 判斷並以 `slice(0, -4)` 去除。若未來 Vite 插件輸出多重 query（如 `?url&v=1` 或 `?commonjs-proxy&url`），將無法識別為 url module，而直接以完整名稱尋找磁碟路徑導致失敗。 | 改以 URL searchParams 或正規式 `/(\?.*)?$/` 分離 query 參數並檢查是否包含 `url` 標記。 |
| **FINDING-03** | 預建腳本審計與法務原創性不可由資產追蹤取代 | **政策限制** | [`L56-L57`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L56-L57), [`L144-L147`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-artifacts.mjs#L144-L147) | 追蹤機制成功將 source map 映射至 `pdf.worker-CLesOks4.mjs`，僅證明其來自 `pdfjs-dist` 之未篡改資源。但該腳本本身仍為無 source map 之預建 JavaScript，且其 Apache-2.0 分發 notice 義務與第三方閉包仍屬獨立審查範疇。 | 維持 `pdf.worker.mjs` 在 `frontend-origin.json` 與總結報告中的 pending 狀態，不得因資產追蹤成功而直接標記為原創性核准。 |

---

## 4. 審查結論 (Verdict)

- **程式碼安全性與正確性判定**：**通過（Scoped Correctness Approved）**。
  - 新增之 `resourceTrace` 實作具備嚴格的目錄容器邊界（`inside(root)` 與 `inside(dist)`）、正規式 wrapper 驗證、TypeScript AST 字面量解析、SHA-256 位元組完全符合要求，以及嚴格的單一匹配拒絕機制（fail-closed）。
  - 單元測試 [`frontend-resource-maps.test.mjs`](file:///C:/Users/qet63/Documents/ModuTex/scripts/licensing/frontend-resource-maps.test.mjs) 覆蓋了正常追蹤、內容篡改、引用遺失、跨目錄逃逸與未知 wrapper 等 5 種核心場景，邏輯健全。
- **邊界與授權限制重申**：
  - 本次審查僅限於生成資產追蹤機制的技術正確性；**不構成**對全體套件法律授權之認可，亦**不解除** MathLive 字型未決權利、預建 worker 無 source map 以及 3 個自建 workspace 私有 UNLICENSED 狀態之阻擋。
