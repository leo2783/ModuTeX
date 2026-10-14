# 最近文件

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

首頁接入真正 Electron 最近文件清單、重開與移除。只有成功原生選檔、資料夾開啟與另存的新位置會記錄；瀏覽器暫存檔及未保存草稿不記錄。

- 主程序 userData 下 `frontend-recent-v1.json`，最多 20 筆 MRU；相同實際路徑保留 ID，Windows 大小寫去重。
- 公開資料只含隨機 ID、資料夾名、入口檔名、時間。重開只接受已存 ID，實際路徑由主程序查回，再由 FrontendFiles 驗證；不接受前端絕對路徑。
- 三種近期操作正式納入原創 DesktopPort；收據使用共用 `parseRecentDocuments`，ID 使用 `recentDocumentId`。嚴格拒絕額外欄位、getter、原型／Array 子類、稀疏清單、重複 ID、路徑與控制字元；返回獨立 frozen 資料，不保留 payload 別名。
- 主程序共用單一服務串行讀寫，排他暫存檔、sync、rename；不先刪除舊檔。Windows 暫時 sharing denial 最多 10 次嘗試，重試等待合計 450 ms，永久失敗仍回報。
- 失效路徑保留紀錄，不建立空檔；使用者可移除。損壞／超限資料不覆寫；清單失敗保留原生開檔入口。歷史寫入失敗不讓已成功開檔／保存變成失敗。
- 前端清單刷新帶 ticket 與卸載防護；重開共用 dirty 確認與 opening／saving 保護。另存後更新清單。

## 本批證據

子代理新增 10 項真 tmp filesystem 測試，首次發現 Windows rename EPERM；主代理有界重試修正後原測試通過，未放寬門檻。涵蓋重開、MRU、並行寫入／移除、真正讀者與原子 JSON、失效保留、ID／路徑拒絕、超限／損壞與真 junction。

主代理新增 decoder 與實際 Home SSR 兩項測試。完整前端 166、相關 host 45 項通過，0 skip；Svelte check 0 errors／warnings，Electron 型別通過。

共用契約補強批次：子代理新增 10 項契約測試，揭露 Array 子類可通過；主代理僅修正近期契約，不改其他 validator 的容器政策。獨立完整契約 28、前端 166、相關 host 45、production 2 項通過，0 skip；契約 check／build、Svelte check 與 Electron 型別通過。MathLive 大 chunk 警告仍保留。來源盤點 48 產物／104 sources／19 packages／30 待查項不代表授權通關。

尚未驗收 Electron 點擊／dirty 切換／多視窗、永久 OS sharing denial、OS CAS 或外部同時寫者。來源核心／Tectonic 前批證據不冒稱本批重跑。新服務仍在既有 AGPL host 邊界，不改根授權。
