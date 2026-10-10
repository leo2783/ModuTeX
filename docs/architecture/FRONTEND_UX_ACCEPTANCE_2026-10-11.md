# 前端品質驗收 2026-10-11

本輪重構前端，沿用現有後端介面；未重寫 IPC，也未變更完整應用授權。

| 要求 | 實作與證據 |
| --- | --- |
| 模式與功能層級 | 固定「原始碼／視覺化」，移除對照；文件操作、格式圖示、內容插入與編譯分區。真 Chrome 驗收。 |
| 文件內編輯 | 共用 SourceDocument 與 CodeMirror undo。文字直接輸入；前端區塊前後的＋可插入文字、公式、矩陣、表格，解析後保留入口與焦點。 |
| 公式／矩陣 | 實際 MathLive 元件；共享建立函式先掛載再設定。一般視覺操作不顯示 LaTeX 輸入欄位；只有載入失敗才提供備援。 |
| 表格 | 插入、就地顯示、重新編輯與 undo；保留原有行列、樣式、標題與寬度控制。IME 與焦點處理不丟草稿。 |
| 未儲存關閉 | Electron beforeunload 顯示儲存／放棄／取消；儲存失敗保留視窗及內容。共用現有儲存與另存流程。 |
| 文字與配色 | 統一視覺化名稱，圖示含 tooltip 與可存取名稱；使用共用色彩 tokens。深淺色、1280／760px 說明導覽通過真 Chrome 驗收。 |
| 文件與編譯 | 真 Electron 開啟、編輯、精確保存、實際 Tectonic PDF、取消保留上一份 PDF、重試、設定路由通過。 |
| 效能 | 100 KiB 初始 JS 門檻保持；MathLive、工具面板與編譯訊息延遲載入。 |

驗證記錄位於 `.verification-artifacts/`：完整回歸 `frontend-parity-full-tests-final.log`（327／327）；真 Chrome `frontend-parity-ui-final.log`（6／6）；Electron 主流程 `frontend-parity-native-mainpath-final.log`（1／1）；關閉流程 `frontend-parity-close-final.log`（5／5）；建置資源 `frontend-parity-production-final.log`（3／3）。說明資料拆分後，分類與路由另驗 9／9；型別檢查零錯誤、兩項既有 layout 警告。

Electron 關閉測試以真視窗的 `window.close()` 觸發同一 beforeunload 路徑，未自動點擊 OS 標題列 X。四個情境是取消、儲存、放棄、外部磁碟修改導致儲存失敗。跨平台與實體 OS 按鈕操作仍需人工驗收。

本輪為原創前端實作與整合，未匯入 legacy UI。來源清單及第三方依賴盤點屬審查證據；獨立來源／授權結論尚未核准，不宣稱完整應用已去除 AGPL。Draw.io／Mermaid、協作與其他後端功能仍按前端重構計畫分階段接入。

真 AGY3 回件：blocks `cac7bf20-93a8-4811-9194-b253809254fd`、workbench `949b6591-c58a-4d24-a653-052136526414`、math `d8564005-15cd-48c9-bb17-bc5249897a03`。第一輪不合格 patch 退回重做；root 審查後整合重新交付。

真 API Luna3 回件：`28bba291-971e-47e5-94c3-e43b1a1b6b04`、`09a6888b-591d-426e-82ae-4845a36a08a4`、`b5ab2794-7a4f-4dd6-81fa-ca84a0ad1e29`。測試失敗照實修復，沒有提高 bundle 門檻或重設成本帳本；所有 worker 結束後才串行 GUI 驗收。
