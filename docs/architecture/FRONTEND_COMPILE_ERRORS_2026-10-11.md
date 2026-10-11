# 編譯失敗與檔案右鍵修正

使用者的 `document.tex` 是合法的最小 article 文件，包含 `2555` 與 `58866`。實際工作區位於 `latex/.verification-artifacts/table-package-recovery`。

## 根因與處理

- 編譯前的 `captureCompileInputs` 回報 `FILE_TOO_LARGE`；Tectonic 尚未啟動，因此沒有 TeX 記錄。
- 舊驗收留下的 `profile/Cache` 被當作編譯輸入，總量超過 64 MiB。不是文件語法錯誤。
- 舊 profile 保留到同層 `table-package-recovery-profile-archive-20261011`，不刪除資料。原工作區重新檢查成功：2 個輸入、456 bytes。
- 編譯安全限制保持原值；不任意忽略所有 `Cache` 或 `profile` 目錄，以免漏掉真正的文件依賴。
- 正式 Electron smoke 的隔離資料位於暫存 fixture 根目錄，文件位於其 `workspace` 子目錄；避免 profile 混入文件工作區。已將本輪根因驗證整合進既有 smoke。

## 前端行為

- 啟動前例外保留具體錯誤碼、文件名稱與恢復方式，失敗自動開啟有界、可選取的詳細資料面板。
- 編譯狀態提供「查看編譯記錄／隱藏詳細資料」；TeX 失敗保留記錄與可用的原始碼導航。
- 檔案右鍵提供開啟、編譯 PDF、複製相對路徑；Escape 關閉並恢復焦點。編譯目前文件不重新載入來源或丟失 undo。
- 開啟其他檔案後編譯仍共用原本的未儲存檢查、儲存與編譯流程；未新增後端檔案操作 IPC。

## 驗證與派工

- 真 Electron：32 MiB＋1 byte 檔案造成啟動前拒絕，面板顯示 `FILE_TOO_LARGE` 與大小上限說明；移除隔離測試檔後，由右鍵編譯使用者相同內容，驗證真 PDF 像素與完成提示。
- 真 Electron 同次驗證取消、重試、故意 TeX 錯誤與上一份 PDF 保留；沒有 mock 編譯結果。
- App lifecycle 14／14，涵蓋右鍵 Escape 焦點與失敗記錄／診斷導航；此 harness 的編譯回傳受控，不能代替原生證據。
- 型別檢查 0 errors，既有 WorkbenchLayout 2 warnings。
- SSR 修正後全套 335／335；最後檔案樹按需載入與 PDF 重繪調整另以 30／30 相關測試及真 Electron 重驗通過。production 3／3，首頁 JavaScript 保持原本 100 KiB 上限。
- 錯誤面板展開造成預覽高度改變時，不再因單純高度變化重繪 PDF；固定縮放的畫布及磁碟 PDF bytes 均驗證失敗後內容保持一致。
- 完整回歸遇到 6 項 SSR runtime `Symbol(filename)` 失敗，單獨執行 recent SSR 也能重現。SSR 排除 Svelte runtime 預打包後，同一隔離測試通過；設定不影響瀏覽器端預打包。失敗日誌保留，最終全套結果另記。
- AGY3 有效審查：`aafb03ef-438d-4caf-b625-af690bc5e4df`、`5e4cc917-9777-4f85-b81a-06978eab7c36`、`9270ef21-7551-48dd-b35c-67c2007113bd`。
- API Luna3 實際檔案審查：`144b9816-4e81-437c-96a3-3b181f5cbe6f`、`60dbc68c-a904-489d-85a4-9242884317b6`、`275a5eb7-b4ac-47e3-b792-18c2bff7fe38`。首次三回件來源不對應任務，未當作程式碼審查交付；補正後收件，root 整合。

本地驗收日誌：`.verification-artifacts/compile-details-*`，不提交生成物或使用者文件。
