# 另存新檔

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

工作台的「另存新檔」使用 Electron 原生保存對話框。renderer 只傳工作區身份、來源 bytes 與文件版本，不傳絕對路徑；取消保留原文件。既有目的檔由原生對話框確認覆寫，再讀取 revision，走同一保存服務。

| 位置 | 行為 | 邊界 |
| --- | --- | --- |
| `App.svelte` | 保存期間禁止來源修改；成功只更新工作區、路徑、revision 與 saved checkpoint，不替換 SourceDocument／undo | 舊編譯 PDF 屬於原工作區，成功另存後清除；取消或失敗不清除 |
| `frontend:save-as` | sender 與工作區驗證；picker owner 在 await 前捕捉；finally 解除 picker busy | 原生對話框實際操作仍待桌面驗收 |
| `FrontendFiles.saveAs` | 驗證選定 `.tex` 與所有 parent components；拒絕 junction；寫入完成才發布新工作區 | 不複製 include／圖片等相對資源；跨資料夾另存後應確認依賴路徑 |
| 新檔保存 | `expectedRevision: null` 表示檔案必須不存在；同目錄 wx 暫存、sync、hard-link 排他發布 | 既有目的或 symlink 不覆寫；檔案系統不支援 hard link 時保留失敗，不退回非排他寫入 |
| 既有檔保存 | revision／身份再檢查後 rename；與其他視窗共享目的鎖及 compile reservation | 不是外部程序鎖或 OS CAS |
| open／close／另存 | authority token 撤銷舊 picker／另存；commit syscall 前再驗證 owner | syscall 已開始後不能回滾；外部路徑替換窗口仍待處理 |
| 失敗 open | finally 僅清除自己持有的 pending marker | 不清除較新 open，原工作區可再次操作 |

驗證批次使用 Node 24.19.0／npm 11.17.0：前端 86、契約 18、主程序檔案／診斷／入口 40、來源核心 121、真 Tectonic 5、production 1 項通過，0 skip。前端 check 0 errors／warnings，Electron build 通過。測資為真 filesystem、真正 Worker／編輯器／PDF.js 與引擎，不冒稱 Electron GUI 或完整 race 驗收。

子代理負責 filesystem 與契約測資，主代理修正 production code、審查並獨立重跑契約／主程序批次。後續按完整功能批次集中驗證，不以單一控制項反覆重跑全套。
