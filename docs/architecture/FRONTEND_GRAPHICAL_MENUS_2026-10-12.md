# 圖形公式選單與面板排列

公式分類與模板使用 MathLive 唯讀預覽，保留分類名稱及按鈕無障礙名稱。返回使用 SVG 箭頭。極限（lim）與微積分可從工具列直接展開；搜尋涵蓋中文、英文、LaTeX 與分類名稱。常用分類優先排序。預覽子樹設為 inert，避免 MathLive 攔截分類點擊；掛載後才建立預覽，切換分類及關閉時釋放欄位。

| 操作 | 實作 |
| --- | --- |
| 分類→模板 | `features/math/inline.ts`；公式外觀搭配名稱，模板不改變自由輸入 |
| 積分 | `features/math/catalog.ts`；六種積分各提供無限界、側置限界、上下限界，另保留微分與導數 |
| 括號 | 圓、方、大括號，分段、堆疊及二項係數 |
| 行內草稿 | `features/visual-editor/view.ts`；零長度文字插入使用既有文字游標，避免落在段落外 |
| 程式碼面板 | `CodePanel.svelte`；重設繼承的 pre-wrap，語言與輸入區間距 10px，14px 等寬字體 |
| 文字層級 | `SourceView.svelte`；原生 details 展開一致樣式的按鈕，保留題目、摘要、三級標題及正文 |

來源仍使用既有交易與復原；此次不變更後端、IPC、授權範圍或第三方程式碼來源。

驗證：`panel-ui.log`、`panel-unit.log`、`panel-check.log`、`panel-build.log`、`panel-production.log` 位於 `.verification-artifacts`。GUI 使用隔離 Chrome、disable-gpu、本機 Vite，涵蓋語法上色、超過百種語言、插入／取消、行內公式、矩陣、表格、拖曳、IME 與文字層級。畫面另保留淺／深色程式碼面板與圖形公式選單擷取。

最終 GUI `panel-ui-final.log` 為 16/16；完整單元回歸 344/345，檔案監看逾時的單項重跑 1/1。最後公式與來源測試 6/6，正式資產驗證 3/3，建置成功；型別檢查 0 錯誤及 2 個既有 WorkbenchLayout 警告。
