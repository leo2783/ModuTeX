# packages/document-core/src 原始碼局部靜態審查報告 (2026-10-08)

本報告依據 [`FRONTEND_REWRITE_PLAN.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/architecture/FRONTEND_REWRITE_PLAN.md) 第 1、3、7 節之架構規劃與原始碼保真不變量（invariants），針對 [`packages/document-core`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/package.json) 導出之核心實作模組進行靜態原始碼審查。

---

## 1. 審查範圍與核對之專案文件

本次審查未列出目錄亦未執行 shell，僅透過精確檢視工具（`view_file`）讀取並審查以下 8 份檔案：
1. [`docs/architecture/FRONTEND_REWRITE_PLAN.md`](file:///C:/Users/qet63/Documents/ModuTex/docs/architecture/FRONTEND_REWRITE_PLAN.md)：架構規範、保真模型要求與 F2 階段靜態不變量標準。
2. [`packages/document-core/package.json`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/package.json)：套件宣告（私有 UNLICENSED，經查核完全無 `dependencies` 與 `devDependencies` 欄位）。
3. [`packages/document-core/src/index.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/index.ts)：公開導出介面定義。
4. [`packages/document-core/src/utf8.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/utf8.ts)：UTF-8 驗證、BOM/EOL 剖析、代理對（surrogate pair）索引與分段結構。
5. [`packages/document-core/src/changes.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/changes.ts)：Patch 座標映射、Span 追蹤與重新錨定。
6. [`packages/document-core/src/source.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts)：Piece table、不可變版本快照、原子事務與二進位序列化。
7. [`packages/document-core/src/parser.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/parser.ts)：保守語法投影解析器、步數/節點預算防護與動態語法退避。
8. [`packages/document-core/src/projection.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/projection.ts)：投影身分驗證守衛（`projectionIsCurrent`）。
9. [`packages/document-core/src/editor-projection.ts`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/editor-projection.ts)：CRLF 座標映射與 CodeMirror 換行規範化適配。

### 未讀取之模組與未執行之驗證（Unresolved / Not Executed）
- `packages/document-core/tests/*.ts`（單元測試與效能測試檔案未讀取）。
- `packages/document-core/tsconfig.json`、`tsconfig.tests.json`（編譯設定未讀取）。
- **未實機執行執行期測試（Runtime tests not executed）**：未執行 `node --test` 或 `source.bench.ts`，未量測記憶體配置、垃圾回收或極限負載，**靜態檢查無法證明全量功能規格已獲實體運作上的完整驗證**。

---

## 2. 靜態程式碼與指定不變量對照 (Scoped Static Findings Consistent with Invariants)

### 2.1 位元組、BOM 與 EOL 靜態邏輯 (Bytes/BOM/EOL Logic)
- **程式碼證據**：
  - [`utf8.ts#L62-L77`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/utf8.ts#L62-L77)：`profile` 遍歷字串統計 LF、CRLF 與 CR 計數，判定 `preferredLineEnding` 並凍結物件。
  - [`source.ts#L47-L61`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts#L47-L61)：接收 `Uint8Array`，檢查 `0xef, 0xbb, 0xbf` BOM，以 `{ fatal: true, ignoreBOM: true }` 呼叫 `TextDecoder`，遇編碼違規拋出 `SourceError('ENCODING')`。
  - [`source.ts#L109-L120`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts#L109-L120)：`toBytes()` 依據 pieces 的原始位元組切片與 BOM 標頭逐段填入新配置的 `Uint8Array(this.byteLength)`。
  - [`editor-projection.ts#L53-L58`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/editor-projection.ts#L53-L58)：將編輯器 patch 中的 `\n` 替換為文件的 `preferredLineEnding` 寫入底層 source。

### 2.2 原子有界 Patches 與多版本結構 (Atomic Patches & Piece Table Structure)
- **程式碼證據**：
  - [`changes.ts#L27-L43`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/changes.ts#L27-L43)、[`#L46-L66`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/changes.ts#L46-L66)：`mapPosition` 與 `remapSpan` 檢查 `Number.isSafeInteger` 與區間邊界；被 patch 觸及的 span 回傳 `null`。
  - [`source.ts#L126-L167`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts#L126-L167)：`apply` 事務驗證 `expectedVersion`，拒絕重疊/逆序 patch；以 piece 切片拼接產生新的 `SourceDocument` 快照，版本號遞增。
  - [`source.ts#L181-L185`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts#L181-L185)：`restore` 在 Undo 舊 snapshot 時仍推進 `version`，以使過期非同步運算結果在比對版本時失效。

### 2.3 語法解析邊界防護與保守退避 (Parser Guardrails & Fallbacks)
- **程式碼證據**：
  - [`parser.ts#L31-L39`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/parser.ts#L31-L39)：設定預算上限（`maxSteps`, `maxNodes`），超額時以符號例外中斷，將全文降級包裝為 `node('raw', 0, text.length, 'parse-budget')`。
  - [`parser.ts#L194-L197`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/parser.ts#L194-L197)、[`#L301-L302`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/parser.ts#L301-L302)：掃描到動態 TeX 指令（如 `catcode`, `def`, `let`）時記錄 `DYNAMIC_SYNTAX` 並將全文降級為 Raw LaTeX。
  - [`parser.ts#L250-L276`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/parser.ts#L250-L276)：未知指令安全平衡參數括號後標記為 `raw` 節點。

### 2.4 套件依賴與宣告邊界 (Package Manifest Reality)
- **程式碼證據**：
  - 檢視 [`packages/document-core/package.json`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/package.json) 實際內容：
    ```json
    {
      "name": "@modutex/document-core",
      "version": "0.1.0",
      "private": true,
      "type": "module",
      "license": "UNLICENSED",
      "description": "Original lossless source buffer for the ModuTeX frontend",
      "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
      "files": ["dist"],
      "scripts": { ... }
    }
    ```
  - **事實查核**：該清單內**完全未宣告 `dependencies` 與 `devDependencies` 鍵值**（測試與編譯直接仰賴上層 workspace 或全域環境提供的 `node` 與 `tsc`）。先前報告斷言「僅於 devDependencies 宣告原生 node 測試」與實際檔案內容不符，特此修正。

---

## 3. 具體審查發現與實作邊界 (Actionable Findings & Precise Limits)

| 編號 | 項目 | 嚴重程度 | 行錨點 (Line Anchor) | 細節說明與審查觀察 |
| :--- | :--- | :--- | :--- | :--- |
| **DOC-01** | 全文字串與片段配置存在真實記憶體開銷 | **設計限制 (需量測)** | [`parser.ts#L35`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/parser.ts#L35)、[`source.ts#L101-L106`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts#L101-L106) | `parseSource` 在解析前直接呼叫 `document.read()`，這會透過 `source.ts#L105` 的 `map(...).join('')` 將所有 piece 的字串片段組合成一個**全新的全文字串**。不可宣稱「無全量字串配置」；在大型文件情境下有明確的字串物件配置與 GC 開銷，確切衝擊需仰賴實機 profiling。 |
| **DOC-02** | 代理對分段邊界安全防護健全 | **代碼觀察 (安全性)** | [`utf8.ts#L37-L49`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/utf8.ts#L37-L49)、[`#L54-L60`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/utf8.ts#L54-L60) | 在 `segment()` 中偵測孤立 High/Low Surrogate 並拋出 `ENCODING` 錯誤；以 `splitSurrogate` 標記跨代理對位置，在 `byteBoundary()` 拒絕切分 Unicode 純量值。 |
| **DOC-03** | 投影與文件版本身分比對 | **代碼觀察 (正確性)** | [`projection.ts#L5-L7`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/projection.ts#L5-L7)、[`source.ts#L187-L189`](file:///C:/Users/qet63/Documents/ModuTex/packages/document-core/src/source.ts#L187-L189) | 透過 `projectionIsCurrent` 與 `acceptCurrent` 比對 `documentId` 與 `version`，防止過期非同步結果覆蓋新資料。 |
| **DOC-04** | 未執行比對相似度審查，無從推定歷史粘合層不存在或具原創性 | **來源邊界 (重要侷限)** | 全模組 `src/*.ts` | **審查侷限說明**：本次審查**未對歷史 legacy 程式碼進行比對式相似度審查（comparative similarity review not performed）**。不可僅憑檔案頭部的版權註記、程式碼風格或未引用 legacy 路徑，即推論歷史粘合層不存在，亦不得將其視為法律層面原創性的證據。 |

---

## 4. 下階段獨立審查中真正能支持來源出處（Source Provenance）之數據

單純宣稱 0 findings 或依賴靜態研讀，無法作為法律原創性或依賴授權核准之依據。在後續獨立審查中，應提供以下具體數據與客觀事證：
1. **外部/歷史代碼庫比對式相似度報告**：以自動化工具與已知歷史實作（如舊版 Texpile、CodeMirror/ProseMirror 既有膠水層、unified-latex）進行 AST 與 token 級別的相似度比對分析，提供客觀差異性指標。
2. **Clean-Room 開發紀錄與規格演進歷程**：提交實作者與規格審查者的隔離紀錄、從原始數學/文字規格到目前 API 的逐步演進 commit 歷程與設計討論紀錄。
3. **實機執行的基準測試與回歸測試日誌**：執行 `node --test tests/*.test.ts` 與 `node --expose-gc tests/source.bench.ts` 的完整 stdout/stderr、記憶體 allocation profile（證明 Piece table 與 parseSource 在 100 KB / 1 MB / 5 MB 下的實際 heap 佔用與 GC 表現）。
4. **字型與第三方資產許可鏈文書**：針對關聯模組引用的字型二進位檔案與第三方宣告，提供明確之上游 License 授權文字與Notice 清單。

---

## 5. 審查結論 (Verdict)

- **靜態分析判定**：**程式碼結構與靜態不變量一致（Scoped Static Findings Consistent with Specified Invariants）**。
- **嚴格限制聲明**：
  - 本報告僅代表靜態原始碼結構與特定約束一致，**非全量功能規格之實體運行核准（not full functional conformance confirmation）**；
  - **未執行執行期測試（Runtime tests not executed）**；
  - **不構成法律原創性認可或 Apache-2.0 授權批准（No legal clearance or Apache approval）**；
  - 套件維持私有 `"license": "UNLICENSED"` 狀態。
