# 產品與介面設計

本機 LaTeX 工作台：開啟專案、編輯、公式／表格、編譯與 PDF；未修改內容原樣保存，未知語法保留 Raw。首頁、工作台、設定、說明共用系統 UI 字型與一致操作。

## 版面與互動

2026-10-07 選定 A：檔案／文件／PDF 三欄，頂部常用操作，低彩度。B drawer、C 原始碼＋診斷保留為比較稿。工作台目前採可視化／原始碼兩模式，舊 split 構想已取消。

- 文件與 PDF 為焦點；情境工具依 selection 呈現。終端機置底 dock，接真實服務後開放；版本紀錄讀實際 CHANGELOG，不代表 updater。
- 首頁提供開啟、新建、MRU、模板；不顯示假統計。設定窄導覽搭配原生控制項，只放真正保存的選項。
- 說明等唯讀頁面約 72ch；Help 內容約 620px、導覽可換行。支援鍵盤 focus、錯誤／dirty 狀態、繁中／英文及窄視窗。
- spacing 4／8／12／16／24；常用目標至少 32px，touch 44px；toolbar 高約 40–44px。避免螢光色、宣傳漸層、裝飾統計與重複文案。

| token                 | 淺色                      | 深色                      |
| --------------------- | ------------------------- | ------------------------- |
| canvas／surface       | #F4F3EF／#FFFFFF          | #202428／#292E33          |
| text／muted           | #24292E／#5D6670          | #E8EBED／#AFB8C0          |
| border／accent／error | #CDD2D7／#3D617B／#A33232 | #49525B／#9BBAD1／#EF9696 |

## 圖片稿

保留原圖與 `.png.json` 來源 metadata；圖片是版面參考，功能行為以[編輯器規格](../architecture/FRONTEND_VISUAL_SOURCE.md)與[Tauri 計畫](../architecture/TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)為準。Draw.io 改為後續 plugin。

[工作台 A](concepts/workbench-a.png) · [B](concepts/workbench-b.png) · [C](concepts/workbench-c.png)

[原始碼](concepts/a-states-2026-10-07/source.png) · [可視化](concepts/a-states-2026-10-07/visual.png) · [終端機](concepts/a-states-2026-10-07/terminal.png) · [工具](concepts/a-states-2026-10-07/tools.png) · [工具列](concepts/a-states-2026-10-07/toolbar.png) · [版本紀錄](concepts/a-states-2026-10-07/release-notes.png) · [設定](concepts/a-states-2026-10-07/settings.png)
