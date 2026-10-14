# 前端來源與授權邊界靜態審查報告 (2026-10-07)

基準分支：`refactor/frontend`
審查時間：2026-10-07
審查性質：**有限靜態代碼與檔案路徑觀察；來源獨立性審查持續進行中（非最終法務核准／無放行宣稱）**
審查範圍：`packages/document-core`、`packages/frontend-contracts`、`apps/frontend`（排除本次審查者參與撰寫之 `Home.svelte`、`Help.svelte`、`ReleaseNotes.svelte`，此三檔案維持利益衝突隔離，必須由另一位 Reviewer 進行獨立複審）
查閱之具體檔案路徑與行號：
- [FRONTEND_REWRITE_PLAN.md](../architecture/FRONTEND_REWRITE_PLAN.md#L9-L23)（授權邊界要求與 F0／F5 標準）
- [frontend-origin.json](frontend-origin.json#L1-L100)（來源清冊及 pending-independent-review 狀態）
- [.verification-artifacts/frontend-origin/artifacts.json](../../.verification-artifacts/frontend-origin/artifacts.json#L1-L100)（歷史快照產物清冊與未解決項目）
- [scripts/licensing/frontend-artifacts.mjs](../../scripts/licensing/frontend-artifacts.mjs#L1-L118)（產物掃描工具邏輯）
- [packages/document-core/package.json](../../packages/document-core/package.json#L1-L17) 及 [src/index.ts](../../packages/document-core/src/index.ts#L1-L13)
- [packages/frontend-contracts/package.json](../../packages/frontend-contracts/package.json#L1-L23) 及 [src/index.ts](../../packages/frontend-contracts/src/index.ts#L1-L19)
- [apps/frontend/package.json](../../apps/frontend/package.json#L1-L35) 及 [vite.config.ts](../../apps/frontend/vite.config.ts#L1-L5)
- [apps/frontend/src/App.svelte](../../apps/frontend/src/App.svelte#L1-L60) 及 [src/styles/base.css](../../apps/frontend/src/styles/base.css#L1-L35)
- 根目錄 [LICENSE](../../LICENSE#L1-L50)

---

## 1. 審查限制與嚴格邊界聲明 (Strict Limitations & Disclaimers)

1. **非嚴格 Clean-Room 聲稱**：
   依據重寫計畫第 1 節，專案參與者曾接觸既有代碼；本審查僅針對靜態檔案、公開 API 及宣告依據進行比對，**絕不宣稱或冒稱具備嚴格隔離法務證據之 clean-room**。
2. **靜態 Import 觀察不等於代碼無衍生或搬移**：
   在靜態 ESM 語法與 Vite 設定中未見引用 `apps/editor-legacy/`，**不能等同證明底層邏輯、演算法或文字未有抄錄或衍生**。此項僅為檔案路徑與建置圖譜之有限靜態觀察。
3. **頂部註解不具法律來源證明效力**：
   原始碼檔案頂層標註之 `// Original ModuTeX implementation. License pending provenance review.` 僅為作者當前自述標記，**不構成任何法務所有權或獨立原創性之實質證明**。
4. **不預先授予 Apache-2.0 授權**：
   新開發之 `packages/document-core`、`packages/frontend-contracts` 及 `apps/frontend` 在 `package.json` 均宣告為 `"license": "UNLICENSED"`、`"private": true`。在完整第三方授權閉包審查與法務確認完成前，維持私有未授權狀態，**嚴禁提前授予 Apache-2.0 授權**。
5. **根目錄與宿主授權維持不變**：
   專案根目錄 [LICENSE](../../LICENSE) 保持 AGPL-3.0；現行 Electron 桌面端主程序、preload 及既有發布物 0.1.0 維持原有義務，不因前端模組替換而變更根目錄授權或發布宣告。

---

## 2. 三大核心授權邊界區隔 (Core Boundary Distinctions)

落實 F0／F5 驗收標準，必須將靜態文字、執行期邏輯與宿主架構分開審視，避免「僅搜尋 AGPL 字串」之簡化誤判：

| 邊界範疇 | 實質性質 | 靜態檢驗觀察依據 | 審查狀態判定 |
|---|---|---|---|
| **執行期程式碼模組**<br>(Runtime Code Modules) | 執行期邏輯、演算法與適配代碼 | 檢視 `packages/*` 與 `apps/frontend/src` 之檔案 imports 及 [vite.config.ts](../../apps/frontend/vite.config.ts)，未見別名指向 `apps/editor-legacy/`。 | **有限靜態觀察符合**<br>語法路徑未直接連結舊前端；實質原創性與非衍生性判定仍待獨立審查 (Provenance pending)。 |
| **說明介面之授權全文**<br>(Displayed License Text) | 作為靜態資料展示之授權文字 | `Help.svelte` 透過 Vite `?raw` 匯入 `LICENSE?raw`、`LICENSES/Apache-2.0.txt?raw` 與第三方 notices。產物證據：歷史快照 `dist/assets/Help-*.js` 包含 AGPL 全文字串供 `#/help/agpl` 顯示；啟動核心 `dist/assets/index-*.js` 靜態閉包無 AGPL 字串。 | **合規展示資料**<br>非執行期程式碼；屬合規透明揭露使用者義務與第三方授權之資料內容。 |
| **桌面端宿主環境**<br>(Legacy AGPL Host) | 系統行程、IPC 與後端服務 | `electron/`（主程序、preload、檔案系統服務、編譯器管理）與 `apps/editor-legacy/` 仍屬 AGPL-3.0 邊界。新前端透過 contracts 介面定義平台邊界，但組合打包為桌面分發物時整體仍受 AGPL-3.0 約束。 | **維持 AGPL 邊界**<br>整體桌面 App 尚未去 AGPL；不可宣稱整體作品已轉授權。 |

---

## 3. 模組來源審查觀察 (Module Observations)

### 3.1 `packages/document-core`
* **套件清冊**：[packages/document-core/package.json](../../packages/document-core/package.json) 宣告為 `"license": "UNLICENSED"`, `"private": true`，無任何外部 `dependencies`。
* **原始碼檔案**：`src/index.ts`, `utf8.ts`, `changes.ts`, `source.ts`, `parser.ts`, `projection.ts`, `editor-projection.ts`。
* **靜態觀察**：實作 byte-level source buffer、LF/CRLF/BOM 追蹤及增量 patch。各檔有待審查標記。
* **審查判定**：靜態依賴乾淨，但實質來源判定仍列為 `pending-independent-review`；維持 `UNLICENSED`。

### 3.2 `packages/frontend-contracts`
* **套件清冊**：[packages/frontend-contracts/package.json](../../packages/frontend-contracts/package.json) 宣告為 `"license": "UNLICENSED"`, `"private": true`，無任何外部 `dependencies`。
* **原始碼檔案**：`src/index.ts`, `types.ts`, `validate.ts`。
* **靜態觀察**：定義平台 IPC 契約型別與純 TypeScript runtime validation 驗證器，無直接引用 Electron 內部模組。
* **審查判定**：靜態結構獨立，實質來源判定仍列為 `pending-independent-review`；維持 `UNLICENSED`。

### 3.3 `apps/frontend`（排除審查者自撰之 Home/Help/ReleaseNotes）
* **建置設定**：[apps/frontend/vite.config.ts](../../apps/frontend/vite.config.ts) 僅使用 `@sveltejs/vite-plugin-svelte`，base 為 `./`，無路徑別名 (resolve.alias) 指向 legacy。
* **直接第三方依賴項**：
  * `@codemirror/language` (6.12.3), `@codemirror/state` (6.7.0), `@codemirror/view` (6.43.2)：MIT 授權。
  * `prosemirror-model` (1.25.9), `prosemirror-state` (1.4.4), `prosemirror-view` (1.41.9)：MIT 授權。
  * `pdfjs-dist` (6.2.108)：Apache-2.0 授權。
  * `mathlive` (0.110.0)：MIT 授權。
  * `svelte` (5.56.9)：MIT 授權。
* **自撰檔案利益衝突隔離（核心阻礙之一）**：
  * `apps/frontend/src/pages/Home.svelte`
  * `apps/frontend/src/pages/Help.svelte`
  * `apps/frontend/src/pages/ReleaseNotes.svelte`
  * **維持排除**：上述三頁面由本 Worker 參與實作，依獨立審查原則，本報告**不做任何自我核准**，必須由另一位 Reviewer 進行獨立程式碼來源複審。
* **動態變更中之檔案 (In-flight Pending)**：
  * `apps/frontend/src/App.svelte`（其他同儕正進行路由與生命週期調整）
  * `apps/frontend/src/features/source-editor/SourceView.svelte` 與 `visual-editor/view.ts`（編輯管線接線中）
  * **狀態**：標記為 `Pending in-flight completion`，待同儕完成交付後進行複查。

---

## 4. 歷史產物快照紀錄與待解決邊界 (Old Snapshot Artifacts & Unresolved Boundaries)

> **重要提示**：以下表格數據引用自過去產物記錄檔 [.verification-artifacts/frontend-origin/artifacts.json](../../.verification-artifacts/frontend-origin/artifacts.json)，**僅作為歷史快照參考（Old Snapshot Data）**。目前各同儕正活躍修改前端代碼，當前最新建置產物雜湊已發生變更；最新雜湊需待穩定後由 Root 重新執行建置並採集，**本表不代表最終產物放行核可 (No final clearance)**。

| 歷史快照產物路徑 | 快照大小 (Bytes) / SHA-256 雜湊 | 快照分類標籤 | 證據分析與後續必備行動 (Next Action) |
|---|---|---|---|
| `apps/frontend/dist/assets/pdf.worker-CLesOks4.mjs` | 2,222,991 bytes<br>`1a7607f28cfbc63f0e4e0a41927c89f991e353e4f3fb4565ecfd621ac5975089` | `script-without-source-map` | **現況**：直接由 `node_modules/pdfjs-dist/build/pdf.worker.mjs` 透過 `?url` 打包，npm 預編譯檔本身無 `.map`。<br>**行動**：核對 npm 來源原始檔案雜湊，並於驗證清冊建立白名單比對。 |
| `apps/frontend/dist/assets/KaTeX_*.woff2`<br>（共 19 個實體檔案 + 1 份 inline base64） | 例：`KaTeX_AMS-Regular-BQhdFMY1.woff2`<br>28,076 bytes<br>`0cdd387c9590a1a9f9794560022dbb59654a7d86f187aa0c81495ad42d3a7308` | `asset-origin-review-required` | **現況**：MathLive 0.110.0 內嵌之 KaTeX 字型。磁碟安裝包內**缺少**獨立 OFL 字型授權文字（見第三方依賴證據清冊）。<br>**行動**：釐清字型授權歸屬並補齊相應 notices。 |
| `apps/frontend/dist/assets/mathlive-fonts-Bk27eonZ.css` | 13,858 bytes<br>`1f8a85f269ebac05b458d9eec4d59f23dbffbfa0256e409ec82315fa4fc5b161` | `asset-origin-review-required` | **現況**：由 `mathlive/fonts.css` 抽取，已確認無外連 URL。<br>**行動**：納入前端第三方 Notices 清冊追蹤。 |
| `apps/frontend/dist/assets/SourceView-ByzV39G-.css` | 2,277 bytes<br>`44b9a527fef585b7f7fb247d4834e022f6d50f55cf58d34b2239e24bcf8fef7f` | `asset-origin-review-required` | **現況**：包含 `prosemirror-view/style/prosemirror.css`。<br>**行動**：納入 ProseMirror MIT notice 追蹤。 |
| `apps/frontend/dist/assets/index-DIgPEugX.js` | 101,939 bytes<br>`b9229f8006611e62d4a85d149d25e6842ec07934f7cfd82efa87bacd8a9af5a8` | 歷史核心入口快照（已過期） | **現況**：此為舊建置快照，當前程式碼變更後該 hash 已失效。<br>**行動**：由 Root 於後續全域建置後重新取得最新產物雜湊。 |

---

## 5. 三大核心阻礙與下一步行動清單 (Core Blockers & Next Actions)

授權判定不能簡化為「僅資產待查」，當前存在三大核心阻礙：

### 5.1 三大核心阻礙 (Core Blockers)
1. **自撰三頁面獨立複審阻礙 (Self-Authored Pages Review Pending)**：
   本 Worker 參與撰寫之 `Home.svelte`、`Help.svelte`、`ReleaseNotes.svelte`，依法務與獨立審查原則，尚未由第三方完成程式碼來源審查。
2. **原始碼清冊全數待查阻礙 (Source Inventory Provenance Pending)**：
   [frontend-origin.json](frontend-origin.json) 中所列原始模組（包括 `document-core`、`frontend-contracts`、`visual-editor`、`source-editor` 等）目前全數標記為 `pending-independent-review`，檔案標頭之作者自述不構成法務獨立性證據。
3. **第三方字型與 Notices 缺漏阻礙 (Third-Party Notices & Font License Gaps)**：
   MathLive npm 安裝包未隨附 KaTeX 字型授權文本，`THIRD_PARTY_NOTICES.md` 尚未建立完備，第三方授權義務尚未完全清查。

### 5.2 下一步行動清單 (Action Items)

| 責任項目 | 涉及檔案／模組 | 具體行動 | 預期交付物 |
|---|---|---|---|
| **獨立複審指派** | `Home.svelte`, `Help.svelte`, `ReleaseNotes.svelte` | 由另一位獨立 Reviewer 審查此三頁面原始碼及文案來源。 | 獨立 Reviewer 簽核紀錄 |
| **全模組來源審查** | `packages/document-core`, `packages/frontend-contracts`, `apps/frontend/src` | 逐檔進行實質邏輯與演算法比對，確認無抄錄自 legacy 之實作。 | 逐檔審查詳細簽核清單 |
| **第三方 Notices 建置** | `apps/frontend/THIRD_PARTY_NOTICES.md` | 依據已採集之安裝包授權文件建立第三方 Notices（參考 [FRONTEND_THIRD_PARTY_EVIDENCE_2026-10-07.md](FRONTEND_THIRD_PARTY_EVIDENCE_2026-10-07.md)）。 | 完備之 `THIRD_PARTY_NOTICES.md` |
| **最新建置雜湊採集** | `apps/frontend/dist` | 待前端所有動態修改穩定後，由 Root 執行正式建置並產出最新產物雜湊清冊。 | 即時驗證產物雜湊表 |
