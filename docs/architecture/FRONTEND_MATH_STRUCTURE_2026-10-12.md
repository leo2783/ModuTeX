# 公式輸入、矩陣尺寸與文字層級

## 行為

- 公式欄位共用 IME 組字狀態。組字期間及 Windows keyCode 229／Process 按鍵不交給公式快捷鍵或 MathLive 按鍵處理，不取消原生組字預設行為。
- 非行內公式與矩陣在編輯前後置中，字級 22px；正文 16px，行內公式跟隨正文比例。
- 點擊公式直接編輯，移除持續顯示的「編輯公式」文字。公式本身是有名稱、可聚焦的按鈕，Enter／Space 也可進入編輯。
- 新增／重編輯單一矩陣直接顯示行、列、括號設定。調整尺寸保留左上方內容、上下標及矩陣前後的數學；縮小碰到非空內容時要求先清空。
- 多個矩陣不猜測要覆寫哪一個；尺寸設定不自動覆寫整段公式。保留原有混合數學輸入。
- 表格面板隔離文件的 pre-wrap 規則，縮短控制間距。樣式、表頭、總寬度、增刪行列直接可用；線條、說明、欄寬比例可展開。欄寬拖曳保留。
- 文字工具新增正文、論文題目、摘要及 #／##／### 標題。對所選文字儲存格套用來源交易，保留內容，支援原有來源復原。

## 來源對應

| 類型 | LaTeX |
| --- | --- |
| 論文題目 | `\title{…}` 與 `\maketitle` |
| 摘要 | `abstract` 環境 |
| #／##／### | `\section`／`\subsection`／`\subsubsection` |

題目指令與相鄰 maketitle 在視覺投影中共用儲存格來源範圍。摘要由前端使用既有解析 API 解碼內容；未知語法仍保留原始碼。沒有修改 document-core 解析器、Electron IPC 或編譯模組。

## 驗證範圍

`.verification-artifacts/math-ime-table-final.log`：實際 Chromium GUI 16／16，包含中文組字確認／取消／Backspace、229 Enter、矩陣尺寸與內容保留、置中與計算字級、直接編輯、表格進階設定、拖曳、程式碼、文字顏色及題目／摘要／標題切換。

組字使用 Chromium CDP 原生 Input.imeSetComposition／Input.insertText；沒有宣稱自動操作 Windows 特定輸入法的候選視窗。一般中文組字在修正前已通過；本次另補強 Windows 確認鍵邊界，未宣稱已重現使用者當時的所有環境因素。

Electron 關閉回歸新增「中文公式輸入並完成後捨棄關閉」，另外保留背景、取消重試、儲存失敗等既有案例。正式版大小門檻不放寬。

- 完整前端來源／交易測試：344／344。
- Electron 原生關閉生命週期：8／8。
- 正式版資產／啟動大小／告示檢查：3／3。
- svelte-check：0 errors，2 個既有 WorkbenchLayout warnings。
- GUI 使用獨立 Vite cacheDir，避免其他 Svelte 測試服務造成 Outdated Optimize Dep／504。GUI、建置與原生視窗驗證按序執行。

## 實作來源

使用者授權對照舊版後，閱讀 `apps/editor-legacy/src/lib/editor/comp/toolbar/MathSymbolPanel.svelte` 與 `extensions/mathlivebridge/mlview.svelte.ts` 的焦點／事件處理片段；本次新增實作沒有複製這些 UI 片段。既有 matrix.ts 的作者授權重用紀錄維持原狀。沒有新增 legacy 執行期 import，也未把這批工作描述成未接觸舊碼的嚴格 clean room。

已閱讀 impeccable SKILL、craft-floor、operate，以及 Frontend／reviewer／技術文件角色、docs_rule、method_map 與維護清單；沿用既有配色和互動，變更只覆蓋使用者指定行為。
