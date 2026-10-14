# 前端可分離授權審查（2026-10-12）

基準：ed3acae 及目前工作區的實際建置。此次為來源與依賴邊界審查，不修改授權，不宣稱嚴格 clean-room。工作區存在其他未提交內容；掃描結果代表工作區，不能直接視為已發布版本。

## 判斷

有部分具備獨立採用非 AGPL 授權的條件。原創部分的權利人可以另行授權；外部作者及第三方內容的權利仍需分別處理。套件的 UNLICENSED 宣告只是尚未授予使用許可，既不證明衍生自 AGPL，也不代表已完成另行授權。

| 範圍 | 判斷與依據 | 尚需處理 |
|---|---|---|
| packages/document-core | 可作獨立授權候選；無外部 dependencies；既有有限來源比較記錄與目前靜態模組邊界未見舊前端依賴 | 明確選擇授權及確認完整來源權利；2026-10-10 比較不是完整歷史證明 |
| packages/frontend-contracts | 可作獨立授權候選；原創平台介面及驗證，無外部 dependencies | 明確授權；不要將契約介面與 AGPL Electron 實作混為一談 |
| 原創 Svelte UI、圖片、拖曳與新編輯邏輯 | 可依個別來源抽離，靜態掃描未見舊前端模組引用 | 清冊的作者自述不是完整非衍生性證明，仍需針對舊來源疑似重用處比對 |
| matrix.ts 中使用者自有程式 | 使用者已確認作者身分並授權重用，可由權利人另行授權 | 僅涵蓋確實自有部分；舊 AGPL 發布版本既有許可不因此撤銷 |
| CodeMirror／ProseMirror／Svelte／MathLive／PDF.js | 本身採 MIT 或 Apache-2.0，可供獨立前端採用；MathLive 字型另遵守 OFL | 保存通知及各自授權；完整產物和字型素材閉包仍需核對 |
| Electron host、舊 editor/site、既有桌面發布物 | 仍在既有 AGPL 邊界；此次前端改寫不改變其授權 | 完整桌面作品不可由此宣稱已脫離 AGPL；IPC 也不是自動豁免依據 |

## 實際證據與工具限制

新版重建後執行 scripts/licensing/verify-frontend-origin.mjs。74 個來源檔案的靜態路徑檢查沒有邊界違規。產物清冊列出 53 個 MIT 套件、1 個 Apache-2.0 套件、3 個 UNLICENSED 自有套件及 1 個根 AGPL 套件歸屬；此數字不是最終授權核准。

根 AGPL 歸屬只對應 `.verification-artifacts/mathlive-input/runtime.mjs`。工具向上尋找最近 package.json，誤將生成的第三方程式歸到根套件。實際位元組與 inputOnlyMathLive 對已固定 SHA-256 的 MathLive 0.110.0 轉換結果完全相同，其上游授權為 MIT。此項不能作為 AGPL 程式碼混入的證據，也不能直接刪除所有其他未解項目。

工具總判定仍是 not-cleared，含所有套件預設 pending-independent-review、資產 CSS／字型核對、無 source map 的腳本及三個自有套件缺少正式 LICENSE。這些項目必須解讀原因，不能全部當成 AGPL 衍生性證明。最新建置已排除 App.svelte 格式更新造成的舊 source map 不一致。

機器證據：`.verification-artifacts/frontend-agpl-review-20261012.json`。目前沒有確認新的 AGPL 執行程式碼直接進入獨立 renderer；這不等於完整來源史或整個桌面組合已獲授權放行。

## 查閱

閱讀 reviewer_role、來源台帳、既有 FRONTEND_ORIGIN_REVIEW_2026-10-07、DOCUMENT_CORE_EXPRESSION_COMPARISON_2026-10-10、套件 manifest、Vite 設定、Electron preload 與打包設定、來源及產物掃描程式，以及生成 MathLive runtime。

授權判斷依據：[GNU 著作權人另行授權說明](https://www.gnu.org/licenses/gpl-faq.en.html#ReleaseUnderGPLAndNF)、[GNU 組合作品判斷](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)。判斷需要同時考慮通訊機制及交換內容，不能只看資料夾或行程分離。
