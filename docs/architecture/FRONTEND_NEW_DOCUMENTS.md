# 首頁與新文件

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

首頁 `#/` 接開啟文件／資料夾、新文件、空白／文章／報告模板與返回目前文件。切頁保留編輯器，PDF 暫停；模板按既定 LaTeX 語法自行撰寫，不取用 legacy fixture、樣式或預設套件。

| 位置 | 行為 | 驗證邊界 |
| --- | --- | --- |
| `files/templates.ts` | frozen 三種 id allowlist；每次建立新 SourceDocument／identity；bytes 不共用 | 真來源與 CodeMirror edit／undo／redo 測試 |
| `Home.svelte` | 原生開檔、模板、當前文件導航；busy 禁用操作、檔名安全文字與窄頁換行 | 真 Svelte SSR／DOM；不等於實際桌面點擊、320 px 或焦點驗收 |
| `App.newDocument` | dirty 捨棄確認；建立來源後撤銷舊工作區，發佈 fresh draft；清除舊 PDF／投影，回工作台 | 開檔／新建等待期間 editor 唯讀，來源／owner／lifetime await 後再檢查；App DOM 排程仍待驗證 |
| draft checkpoint | 初次磁碟保存前保持 dirty，包括 undo 回到初始模板；Ctrl+S／儲存轉原生 Save As | 真成功 receipt 才更新 checkpoint；取消保留來源。完整 GUI 流程待驗收 |
| 空白模板 | 標準 article 加 null，產生真空白 PDF 頁 | 不以零頁或假 PDF 冒充成功 |

模板不包含 input／include／額外套件／shell；文章提供 title／section，報告提供 title／chapter。建立不自動寫入磁碟；瀏覽器明示儲存／編譯需桌面版，不顯示假保存成功。

本批：前端 93、真 Tectonic 8、production 1 項通過，0 skip；check 0 errors／warnings。三模板實際走 Save As → receipt revision → Tectonic → PDF bytes 與磁碟比對。入口 100.00 KB、延遲 editor 485.94 KB，門檻未改；首頁與模板延遲載入。

子代理編寫測資並指出 close await 時輸入的問題；主代理將 SourceView 的唯讀保護擴為 saving／opening，審查測試並重跑前端／production。來源台帳與產物盤點已更新，但不作獨立授權證明。

尚待：最近文件的主程序持久化／失效項移除、英文、GUI／IME／焦點、真實新建→保存→重開端到端及 Impeccable finish review。不得將「目前文件」一列當作最近文件功能完成。
