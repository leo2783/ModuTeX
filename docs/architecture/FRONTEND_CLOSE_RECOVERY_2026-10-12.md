# 未儲存文件關閉流程

## 修正

原先 beforeunload 先攔截關閉，再動態載入 CloseDialog。首次模組載入失敗時，視窗保持開啟且沒有對話框；重新按 X 也無法恢復失敗的載入。使用者回報背景視窗無法關閉；背景本身在隔離重現中可正常關閉，沒有宣稱已證明使用者當次的全部環境因素。

CloseDialog 現在跟 App 一起備妥，按 X 不再請求額外模組。保留儲存、捨棄、取消及儲存失敗保護。共用 App 翻譯函式，取消後恢復有效編輯焦點，元件移除時由瀏覽器移除 modal。

為維持原有 100 KiB 啟動門檻，大綱與 PDF 預覽狀態跟工作台一起載入，說明頁標題目錄維持延遲載入。diagnosticSpan／previewStatus 的既有公開匯出維持相容，計算內容不變。沒有修改 Electron IPC、編譯後端或使用者資料。

## 驗證

| 證據 | 結果 |
| --- | --- |
| close-regression-blocked-native-chunk.log | 修正前阻擋首次 CloseDialog 請求，對話框逾時；其餘控制組正常 |
| close-regression-native-verified-final.log | 修正後 7／7：阻擋請求時仍可關閉且請求數為 0；背景最小化；取消重試；儲存；捨棄；儲存失敗後捨棄 |
| close-regression-production-verified-final.log | 3／3；原啟動大小門檻未放寬 |
| close-regression-check-final.log | 0 errors；既有 2 warnings |
| close-regression-tests-final.log | 完整前端 344／344 |

記錄位於本機 .verification-artifacts。原生測試使用隔離暫存資料夾與單一停用 GPU 的 Electron，直接呼叫主程序 BrowserWindow.close，覆蓋原生 X 的生命週期；沒有宣稱自動點擊作業系統標題列。背景使用 minimize／restore。
