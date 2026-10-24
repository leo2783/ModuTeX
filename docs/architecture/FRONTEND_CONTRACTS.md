# 桌面、檔案與編譯契約

實作入口：`packages/frontend-contracts`、`apps/frontend/src/features/files`、`electron/src/services`。Tauri 的對應介面見 [CONTRACT](FRONTEND_CONTRACTS.md)。

## 邊界與資料

- DesktopPort 保留 11 個方法；workspace ID 由 host 配發並綁定視窗。呼叫只接受相對路徑，不能用 renderer 提供的 owner 決定權限。
- record 驗證拒絕額外欄位、getter、異常 prototype 與稀疏陣列；binary 使用 owned bytes，拒絕 shared／detached buffer。
- 來源上限 5 MiB、PDF 32 MiB、list 4096 筆／深度 16；ID 為 1–128 ASCII 字元，revision 最長 256，一般文字最多 32767 UTF-16 units。配置及傳輸前驗證。
- revision 為 null 表示僅允許新建；修改必須比對原 revision。儲存失敗保留 dirty、undo 與草稿。

## 儲存與生命週期

- Save As 使用原生 picker；成功後更新 checkpoint，保留同一 SourceDocument 與 undo。切換工作區成功才清除舊 PDF；取消維持現況。
- 最近文件保存於 `frontend-recent-v1.json`，最多 20 筆 MRU；依實際路徑忽略大小寫去重，同一路徑沿用 ID。temp／sync／rename 原子更新，sharing denial 最多重試 10 次、合計 450 ms。歷史寫入失敗不撤銷成功開檔；移除歷史不刪檔。
- CloseDialog 隨 App 載入，不能等待非同步 chunk 才攔截關窗；儲存、放棄、取消及保存失敗各有獨立結果。
- 現行 Electron 以 destination lock、再次核對、temp／sync／rename 防止內部覆寫；最後核對到 rename 的外部替換競態仍是 Tauri 必須補足的項目。
- 圖片單檔 5 MiB、合計 32 MiB、最多 4096 個資源，使用 UUID 路徑。同 bytes 可重用，不同內容不得占用同 ID；先寫資源，再寫文件。失敗留下的未引用圖片不任意清除。

## 編譯、取消與 PDF

- 狀態依序為 prepared → running → draining → settled；從初始 revision 核對前保留工作區，直到程序清理與 PDF 捕捉完成才解鎖。相交根目錄的保存／編譯互斥。
- runId、documentVersion、savedRevision 與全部輸入身分／hash 必須一致。包含檔變更、增刪及同 bytes 的檔案替換都要辨識；只排除明確指定的產物／快取目錄，不能依一般資料夾名稱漏掉輸入。
- 取消要等待啟動競態、子程序樹與輸出排空，再裁決結果；失敗或取消保留上一次成功 PDF。
- `pdfWrappedText` 只處理正文 ASCII alnum 長段：連續至少 32 字元，每 16 字元加入斷行機會。math、literal、comment、未知語法與 Raw table 保持原樣；使用私有輸入 stage，不改磁碟原稿。行號保留，失準欄號清除，SyncTeX 路徑映回原檔。
- diagnostics 最多 256 筆，訊息最長 512；只導向已確認入口檔／行。無法對應的 included file 或欄位留在 log，不猜測位置。
- UI 顯示編譯階段；新 PDF 畫布完成才取代舊結果。每個 canvas 一個 render task、最多一個 pending；取消必須 await，dispose 清理 RAF、observer、loading task。fit-width 只隨寬度變動調整。

## 非同步與監看

- App 使用 AbortSignal／ticket 拒絕過期結果；歷史最多 200 個 transaction，儲存期間的唯讀狀態一致。
- Parser Worker 一個 in-flight、最多 64 個 queued，insert 上限 5 MiB；watchdog／restart 保留 editor state。parser 預算 32768 nodes／8000000 steps，超過時保留完整來源為 Raw。
- watcher 合併 OS 通知，以檔案身分約每 5 秒核對、每 60 秒 reconcile；溢位明確回報。subscription 綁 workspace、視窗、generation；切換後舊事件失效。
- 前端批次更新樹與啟動 resync；外部變更只自動重載 clean 文件，dirty 文件保留內容並提示衝突。
- 設定 schema v1；storage event 重新讀取各欄位，單欄損壞不能覆蓋其他設定。

## 驗證

執行契約 check／test、Electron frontend runtime 與原生 smoke；競態案例使用真檔案及可控制 barrier。2026-10-10 的歷史證據為 host guard 104、engine 18、browser 7、原生 Electron 1；目前結果與缺口統一記於[狀態表](FRONTEND_REWRITE_STATUS.md)。
