# 文件內數學與內容編輯驗收

## 結果

- 數學入口合併行內公式、公式儲存格及矩陣。展開選單提供 191 個項目，包含 lim、微分／偏微分、積分、希臘字母、集合數系、常見公式、多行函數與矩陣運算。
- 行內公式沿用實際文字游標；公式與矩陣儲存格沿用 Notebook 新增、移動、刪除與局部編輯。確認採綠色、取消採紅色；不提供數學鍵盤入口。
- 新增程式碼儲存格，採原生 verbatim，內容只顯示、不執行。文字顏色支援預設色與自訂六位 RGB；格式與輸入共用來源交易及 undo。
- 套件需求與內容同一次交易寫入；數學加入缺少的 amsmath／amssymb，顏色加入 xcolor。未填公式空格拒絕提交，不產生不能編譯的 placeholder。
- 修正長文件 Ctrl+End／Home：定位整份來源的端點，避免只跳至 CodeMirror 畫面已掛載的尾端。
- dev／build／test 前先建置共享模組，避免新版前端使用舊 document-core dist。

## 開發來源與派工

本批 catalog、程式碼區塊與顏色功能由核准的功能需求獨立實作。舊版只在本地抽取操作名稱作為對照，未將 legacy 實作傳給外部代理，也未複製其實作。既有矩陣 parser 是前輪使用者確認著作權並授權重用的程式；本批不將它重新宣稱為 clean-room。第三方 MathLive 仍沿用既有授權及來源紀錄，整體應用授權尚未變更。

| 代理 | 真實交付收據 | 採用方式 |
| --- | --- | --- |
| AGY math | 7466661d-f49e-4fcf-9aad-ecb2bf6df33d | 新 catalog／行內選單補丁，主代理補齊功能與 AMS 需求 |
| AGY blocks | 917a479a-ec29-4fbc-b65c-aa94f926bd52 | 程式碼來源與面板補丁，主代理接入共用視覺／來源交易 |
| AGY workbench | b3c52c2e-c141-4f20-af7a-087ced46feb2 | 顏色方案審查，主代理實作帶色碼的格式映射 |
| API Luna 1 | ce8c5a0c-00f9-4f6c-b126-22a7b766cfdf | 行內游標／面板補丁審查與整合 |
| API Luna 2 | 9b4a2b8b-310e-408d-84af-576c4efa6dcf | 回件不完整，未整包套用；僅採審查建議，主代理完成顏色交易 |
| API Luna 3 | ad2f499f-d3c3-4afa-a9bc-55afc925a8ea | 程式碼／Raw 狀態生命週期審查 |

## 驗證

- 完整前端 338／338、document-core 121／121；真 Chrome GUI 11／11，正式產物 3／3。
- Svelte check 0 errors，保留既有 WorkbenchLayout 2 warnings。首頁 100 KiB 預算未提高。
- 原生 Electron 使用真 Tectonic：正常編譯、取消／重試、啟動前失敗詳情、TeX 失敗保留上一份 PDF，以及 PDF canvas 有非空白像素。
- 全 191 項 catalog 編譯 fixture 將輸入空格替換為 x；最終原生編譯及 PDF 像素驗證通過，覆蓋所有模板的 TeX 語法與套件依賴，不等同任意使用者公式皆有效。
- 真 GUI 核對行內希臘字母、展開分類、程式碼插入／取消、文字顏色與綠紅按鈕。17 次實際鍵盤輸入立即同步，中位數約 7.1 ms、p95 約 16.4 ms；不代表全部文件尺寸的效能保證。

## Prompt caching

此批 API Luna 三次回件 cached_tokens 均為 0。原請求把不同任務的參考檔案放在共同前綴之前，降低跨任務可共用的前綴。

`scripts/agents/luna-input.mjs` 改為先放共享來源權威、數學來源與契約，再放去重排序的任務檔案及指令；本機忽略的 `.codex/scripts/run-luna-task.mjs` 已接入。既有 explicit cache 與 TTL 保留，未清空成本帳本或送出灌命中率的測試請求。來源紀錄及前綴測試共 76／76 通過，包含跨任務前綴相同與參考去重；實際命中率要待下一批真實派工確認。

## 範圍

本批只重構前端與共享文件格式辨識；不改後端模組及 IPC。未提高安全上限、未刪除未知語法、未將回傳 HTML 注入程式碼區塊。來源、BOM／CRLF、無修改返回及精確 undo 由真交易測試驗證。
