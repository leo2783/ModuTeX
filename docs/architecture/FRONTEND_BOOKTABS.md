# Booktabs 三線表

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

三線表提供「等粗線（不加套件）」與 Booktabs。預設保持原 hline 語法；全框線、僅橫線不使用 Booktabs。

- 生成器以 `toprule`／`midrule`／`bottomrule` 輸出三線表；首列是否為表頭、caption 與欄寬沿用原工具。單行表不重複加入中線。
- 回讀只接受精確生成語法；規則順序、未知選項、混用 hline 或其他指令保留 Raw，不猜測轉換。
- 前言檢查使用當前 parser identity／version 與直接 literal 套件宣告；註解、正文、macro 中的字串不視為已載入。前言不完整或動態語法拒絕自動追加。
- 缺套件時預覽固定 `\usepackage{booktabs}`；等待確認期間鎖定表格草稿，返回後可改選 hline。取消／Esc 不改文件。
- 確認重新檢查原來源與插入位置。前言、表格同一 CodeMirror 交易／undo；版本不符、plan 篡改、範圍衝突、超過 5 MiB 均不得留下部分前言。
- 單次工具動作允許解析來源來驗證前言；普通擊鍵仍只走既有局部來源 patch。

八項新增回歸與真 Managed Tectonic fixture 由驗證子代理提供並執行；包含原 parser 預算拒絕與 UTF-8 5 MiB 原子拒絕，沒有提高預算。完整前端 190／190、core 121／121、production 2／2 通過，check 零診斷；真 Booktabs 編譯 1 項確認保存 bytes、產生 PDF 與精確 undo，其餘 9 項 runtime 此次未重跑。SSR 不代表實際確認按鈕、焦點或 GUI 驗收。編譯使用既有隔離暖快取，不宣告首次下載或完全離線。

前言檢查使用的完整 parser 僅供工具動作載入；首頁共用 identity guard 已獨立，保留原 API。首頁 101.93 kB，符合既有 100 KiB gate；SourceView 511.90 kB／MathLive 800.66 kB chunk 警告仍在。

正式產物測試已固定遍歷真 startup 靜態依賴閉包的 source-map；完整 parser 不得進首頁。新增 assert 後同兩項產物測試再次通過，未重新建置或提高門檻。
